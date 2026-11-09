import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPlanGuard, verifyPreCommitGuard, loadWorkflowConfig, publishApproval } from '../scripts/verify_guard.mjs';
import { applySeverityGate, parseSeverityReport } from '../scripts/review_policy.mjs';
import { appendLedgerRound, getOpenIssues, getStageRounds } from '../scripts/review_policy.mjs';
import { captureBinding, captureCode, collectSnapshot, git } from '../scripts/review_artifact.mjs';
import { readJson, writeJson, acquireLease, recoverLease, withRunnerLease, commitStateFiles, hasPendingTransaction, recoverStateTransaction, loadRequest, digest } from '../scripts/workflow_state.mjs';
import { parseReviewContract, artifactHash } from '../scripts/review_contract.mjs';
import { executeReviewRequest } from '../scripts/review_runner.mjs';
import { evaluateToolCall } from '../scripts/check_plan_approved.mjs';
import { initializeProject } from '../scripts/init_project.mjs';
import { createCheckpoint, restoreCheckpoint } from '../scripts/checkpoint.mjs';
import { sendEscalationTelegram, waitForTelegramDecision, applyHumanDecisionToState } from '../scripts/telegram.mjs';
import { buildMentorPrompt, requireCompleteAttachment } from '../scripts/ask_mentor.mjs';
import { doctor } from '../scripts/doctor.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-fixture-'));
  const state = path.join(root, '.agents/state');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(root, 'src/app.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'tests/basic.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('fixture',()=>assert.equal(1,1));\n");
  writeJson(path.join(root, '.agents/config.json'), { sourceDirs: ['src', 'tests'], testCommand: 'node --test tests/basic.test.mjs', maxReviewRounds: 1 });
  git(root, ['init', '-b', 'codex/fixture']);
  git(root, ['add', 'src', 'tests', '.agents/config.json']);
  git(root, ['-c', 'user.name=Workflow Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-verify', '-m', 'fixture baseline']);
  initializeProject(root);
  writeJson(path.join(state, 'SESSION_MAP.json'), { currentTask: 'task-1', projectUrl: '', threads: {}, geminiThreads: {}, stageRounds: {} });
  const dispose = () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.join(os.tmpdir(), 'workflow-fixture-')));
    fs.rmSync(resolved, { recursive: true, force: true });
  };
  return { root, state, dispose, config: () => loadWorkflowConfig(root), binding: (mode = 'plan') => captureBinding(root, loadWorkflowConfig(root), { taskId: 'task-1', mode }) };
}
function approvePlan(f) { return publishApproval(f.root, f.binding(), { requestId: 'plan-fixture', approvedBy: 'fixture-mentor' }); }
function response(request, patch = {}) {
  return JSON.stringify({ requestId: request.requestId, taskId: request.taskId, stage: request.mode, artifactHash: artifactHash(request.binding), status: 'APPROVED', blockingIssues: [], nonBlockingIssues: [], resolvedIssueIds: [], stillOpenIssueIds: [], ...patch });
}

test('guard refuses APPROVED without a valid approval record', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-guard-'));
  try {
    const state = path.join(root, '.agents/state');
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, 'CURRENT_PLAN.md'), '# Task 1\nPlan A');
    fs.writeFileSync(path.join(state, 'MENTOR_FEEDBACK.md'), 'STATUS: APPROVED\n');
    assert.equal(verifyPlanGuard(root).ok, false);
    fs.writeFileSync(path.join(state, 'STATE_LOCK.json'), '{broken');
    assert.equal(verifyPlanGuard(root).ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing review structure cannot authorize implementation', () => {
  assert.equal(applySeverityGate('APPROVED', parseSeverityReport('STATUS: APPROVED\nLooks fine.')).status, 'REJECTED');
});

test('plan approval survives implementation but expires on plan/task/branch/config drift', () => {
  const f = fixture();
  try {
    approvePlan(f);
    assert.equal(verifyPlanGuard(f.root).ok, true);
    fs.appendFileSync(path.join(f.root, 'src/app.mjs'), '// implementation\n');
    assert.equal(verifyPlanGuard(f.root).ok, true);
    const plan = path.join(f.state, 'CURRENT_PLAN.md'); const original = fs.readFileSync(plan);
    fs.appendFileSync(plan, '\nChanged acceptance criteria');
    assert.equal(verifyPlanGuard(f.root).ok, false);
    fs.writeFileSync(plan, original);
    const session = readJson(path.join(f.state, 'SESSION_MAP.json'));
    writeJson(path.join(f.state, 'SESSION_MAP.json'), { ...session, currentTask: 'task-2' });
    assert.equal(verifyPlanGuard(f.root).ok, false);
    writeJson(path.join(f.state, 'SESSION_MAP.json'), session);
    git(f.root, ['switch', '-c', 'codex/other']);
    assert.equal(verifyPlanGuard(f.root).ok, false);
    git(f.root, ['switch', 'codex/fixture']);
    writeJson(path.join(f.root, '.agents/config.json'), { ...f.config(), testCommand: 'node -e "process.exit(0)"' });
    assert.equal(verifyPlanGuard(f.root).ok, false);
  } finally { f.dispose(); }
});

test('late approval cannot certify plan/code changed during review', () => {
  const f = fixture();
  try {
    const before = f.binding();
    fs.appendFileSync(path.join(f.state, 'CURRENT_PLAN.md'), '\nNew plan');
    assert.throws(() => publishApproval(f.root, before, { requestId: 'old' }), /STALE_REVIEW/);
    approvePlan(f);
    const code = f.binding('review-code');
    fs.appendFileSync(path.join(f.root, 'src/app.mjs'), '// late change\n');
    assert.throws(() => publishApproval(f.root, code, { requestId: 'old-code', testExitCode: 0, testEvidenceHash: digest('test') }), /STALE_REVIEW/);
  } finally { f.dispose(); }
});

test('snapshot contains plan, staged/unstaged, untracked and binary without changing index', () => {
  const f = fixture();
  try {
    fs.appendFileSync(path.join(f.root, 'src/app.mjs'), '// staged\n'); git(f.root, ['add', 'src/app.mjs']);
    fs.appendFileSync(path.join(f.root, 'src/app.mjs'), '// unstaged\n');
    fs.writeFileSync(path.join(f.root, 'src/new.bin'), Buffer.from([0, 1, 200, 255]));
    const index = git(f.root, ['diff', '--cached', '--binary']);
    const snapshot = collectSnapshot(f.root, f.config(), 'task-1', 'review-code');
    assert.equal(snapshot.positiveTestExitCode, 0);
    assert.match(snapshot.fullBundleText, /CURRENT_PLAN/);
    assert.match(snapshot.fullBundleText, /staged/);
    assert.match(snapshot.fullBundleText, /unstaged/);
    assert.match(snapshot.fullBundleText, /BINARY BASE64/);
    assert.deepEqual(snapshot.newFilesList, ['src/new.bin']);
    assert.equal(git(f.root, ['diff', '--cached', '--binary']), index);
  } finally { f.dispose(); }
});

test('test-generated source mutation invalidates the snapshot', () => {
  const f = fixture();
  try {
    writeJson(path.join(f.root, '.agents/config.json'), { ...f.config(), testCommand: 'node -e "require(\'fs\').appendFileSync(\'src/app.mjs\',\'// mutation\')"' });
    assert.throws(() => collectSnapshot(f.root, f.config(), 'task-1', 'review-code'), /STALE_REVIEW/);
  } finally { f.dispose(); }
});

test('pre-commit rejects partial staging and rechecks the reviewed code after tests', () => {
  const f = fixture();
  try {
    approvePlan(f);
    fs.appendFileSync(path.join(f.root, 'src/app.mjs'), '// change\n');
    const snapshot = collectSnapshot(f.root, f.config(), 'task-1', 'review-code');
    publishApproval(f.root, snapshot.binding, { requestId: 'code-fixture', testExitCode: 0, testEvidenceHash: snapshot.testEvidenceHash });
    assert.equal(verifyPreCommitGuard(f.root).ok, true); // nothing staged
    git(f.root, ['add', 'src/app.mjs']);
    assert.equal(verifyPreCommitGuard(f.root).ok, true);
    fs.appendFileSync(path.join(f.root, 'src/app.mjs'), '// after approval\n');
    assert.equal(verifyPreCommitGuard(f.root).ok, false);
  } finally { f.dispose(); }
});

test('hook normalizes relative/custom paths and returns host decisions for terminal/protected writes', () => {
  const f = fixture();
  try {
    assert.equal(evaluateToolCall(f.root, { toolCall: { name: 'write_to_file', args: { TargetFile: 'src/new.mjs' } } }).decision, 'deny');
    approvePlan(f);
    assert.equal(evaluateToolCall(f.root, { toolCall: { name: 'write_to_file', args: { TargetFile: 'src/new.mjs' } } }).decision, 'allow');
    assert.equal(evaluateToolCall(f.root, { toolCall: { name: 'run_command', args: { CommandLine: 'echo x > src/app.mjs' } } }).decision, 'force_ask');
    assert.equal(evaluateToolCall(f.root, { toolCall: { name: 'edit_file', args: { path: '.agents/state/STATE_LOCK.json' } } }).decision, 'force_ask');
    assert.equal(evaluateToolCall(f.root, { toolCall: { name: 'write_to_file', args: { TargetFile: '../escape' } } }).decision, 'deny');
    assert.equal(evaluateToolCall(f.root, {}).decision, 'deny');
  } finally { f.dispose(); }
});

test('JSON contract rejects missing identities, invalid fields, duplicate issues and omitted old blockers', () => {
  const request = { requestId: 'r', taskId: 'task-1', mode: 'plan', binding: { planHash: 'x' } };
  assert.equal(parseReviewContract(response(request), request).status, 'APPROVED');
  assert.throws(() => parseReviewContract('STATUS: APPROVED', request), /JSON/);
  assert.throws(() => parseReviewContract(response(request, { requestId: 'other' }), request), /IDENTITY/);
  assert.throws(() => parseReviewContract(response(request, { extra: true }), request), /SCHEMA/);
  const old = [{ id: 'P0-01', title: 'old blocker' }];
  assert.throws(() => parseReviewContract(response(request), request, old), /NOT_ACCOUNTED/);
  assert.equal(parseReviewContract(response(request, { stillOpenIssueIds: ['P0-01'] }), request, old).status, 'REJECTED');
  assert.equal(parseReviewContract(response(request, { resolvedIssueIds: ['P0-01'] }), request, old).status, 'APPROVED');
  assert.throws(() => parseReviewContract(response(request, { blockingIssues: [{ id: 'P0-01', title: 'a' }, { id: 'P0-01', title: 'b' }] }), request), /DUPLICATE/);
});

test('ledger keeps an omitted blocker open and deduplicates a recovered response', () => {
  const ledger = {};
  appendLedgerRound(ledger, 'task-1-plan', 'chatgpt', { requestId: 'a', p0: [{ id: 'P0-01', title: 'issue' }] });
  appendLedgerRound(ledger, 'task-1-plan', 'chatgpt', { requestId: 'b', p0: [] });
  assert.equal(getOpenIssues(ledger, 'task-1-plan', 'chatgpt').length, 1);
  appendLedgerRound(ledger, 'task-1-plan', 'chatgpt', { requestId: 'b', p0: [] });
  assert.equal(ledger['task-1-plan'].chatgpt.length, 2);
  appendLedgerRound(ledger, 'task-1-plan', 'chatgpt', { requestId: 'c', p0: [], statuses: { 'P0-01': 'RESOLVED' } });
  assert.equal(getOpenIssues(ledger, 'task-1-plan', 'chatgpt').length, 0);
});

test('timeout resumes the same request without another send or review round at budget limit', async () => {
  const f = fixture();
  try {
    let sends = 0, reads = 0;
    const transport = { prepare: async () => ({ url: 'https://chatgpt.com/c/fixture000' }), submit: async () => { sends++; return {}; }, receive: async (req) => { if (++reads === 1) throw new Error('timeout'); return response(req); }, url: () => 'https://chatgpt.com/c/fixture000' };
    const args = { root: f.root, config: f.config(), taskId: 'task-1', mode: 'plan', provider: 'chatgpt', threadKey: 'task-1-plan', snapshot: collectSnapshot(f.root, f.config(), 'task-1', 'plan', { runTests: false }), buildPrompt: () => 'Plan', transport };
    await assert.rejects(() => executeReviewRequest(args), /timeout/);
    assert.equal(loadRequest(f.root, 'chatgpt', 'task-1-plan').status, 'SENT');
    const recovered = await executeReviewRequest(args);
    assert.equal(recovered.status, 'RECEIVED');
    assert.equal(sends, 1);
    assert.equal(getStageRounds(readJson(path.join(f.state, 'SESSION_MAP.json')), 'task-1-plan', 'chatgpt'), 1);
    await executeReviewRequest(args);
    assert.equal(reads, 2);
  } finally { f.dispose(); }
});

test('uncertain submit never auto-resends; a changed artifact cannot resume', async () => {
  const f = fixture();
  try {
    let sends = 0;
    const transport = { prepare: async () => ({ url: 'https://chatgpt.com/c/fixture000' }), submit: async () => { sends++; throw new Error('connection lost'); }, hasSubmission: async () => false, receive: async () => 'unused' };
    const args = { root: f.root, config: f.config(), taskId: 'task-1', mode: 'plan', provider: 'chatgpt', threadKey: 'task-1-plan', snapshot: collectSnapshot(f.root, f.config(), 'task-1', 'plan', { runTests: false }), buildPrompt: () => 'Plan', transport };
    await assert.rejects(() => executeReviewRequest(args), /connection lost/);
    await assert.rejects(() => executeReviewRequest(args), /UNCERTAIN_SEND/);
    assert.equal(sends, 1);
    fs.appendFileSync(path.join(f.state, 'CURRENT_PLAN.md'), '\nchanged');
    await assert.rejects(() => executeReviewRequest(args), /STALE_REVIEW/);
  } finally { f.dispose(); }
});

test('attachment failure leaves request unsent and preserves budget', async () => {
  const f = fixture();
  try {
    let submits = 0;
    const transport = { prepare: () => requireCompleteAttachment({}, 'unused', async () => false), submit: async () => { submits++; }, receive: async () => '' };
    await assert.rejects(() => executeReviewRequest({ root: f.root, config: f.config(), taskId: 'task-1', mode: 'plan', provider: 'chatgpt', threadKey: 'task-1-plan', snapshot: collectSnapshot(f.root, f.config(), 'task-1', 'plan', { runTests: false }), buildPrompt: () => 'Plan', transport }), /ATTACHMENT_FAILED/);
    assert.equal(submits, 0);
    assert.equal(getStageRounds(readJson(path.join(f.state, 'SESSION_MAP.json')), 'task-1-plan', 'chatgpt'), 0);
  } finally { f.dispose(); }
});

test('journaled partial write blocks approval until recovery completes', () => {
  const f = fixture();
  try {
    approvePlan(f);
    assert.throws(() => commitStateFiles(f.root, { 'HANDOFF.md': 'new handoff', 'HUMAN_DECISION.json': '{"nonce":"recovered"}' }, { afterWrite: () => { throw new Error('simulated crash'); } }), /crash/);
    assert.equal(hasPendingTransaction(f.root), true);
    assert.equal(verifyPlanGuard(f.root).ok, false);
    assert.equal(recoverStateTransaction(f.root), true);
    assert.equal(readJson(path.join(f.state, 'HUMAN_DECISION.json')).nonce, 'recovered');
    assert.equal(verifyPlanGuard(f.root).ok, true);
  } finally { f.dispose(); }
});

test('a live lease excludes another runner and cannot be recovered', async () => {
  const f = fixture();
  try {
    await withRunnerLease(f.root, [], async () => {
      await assert.rejects(() => withRunnerLease(f.root, [], async () => {}), /RUNNER_BUSY/);
      assert.throws(() => recoverLease(path.join(f.state, '.workflow-runner.lock')), /ACTIVE/);
    });
    assert.equal(fs.existsSync(path.join(f.state, '.workflow-runner.lock')), false);
  } finally { f.dispose(); }
});

test('checkpoint restores partial staging, untracked binary and invalidates old approval', () => {
  const f = fixture();
  try {
    approvePlan(f);
    fs.appendFileSync(path.join(f.root, 'src/app.mjs'), '// staged\n'); git(f.root, ['add', 'src/app.mjs']);
    fs.appendFileSync(path.join(f.root, 'src/app.mjs'), '// unstaged\n');
    fs.writeFileSync(path.join(f.root, 'src/new.bin'), Buffer.from([0, 200, 255]));
    const checkpoint = createCheckpoint(f.root);
    const status = git(f.root, ['status', '--porcelain=v1', '-z', '--', 'src', 'tests']);
    git(f.root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'src', 'tests']);
    fs.unlinkSync(path.join(f.root, 'src/new.bin'));
    assert.throws(() => restoreCheckpoint(f.root, checkpoint.folder), /CONFIRMATION/);
    restoreCheckpoint(f.root, checkpoint.folder, { confirmRestore: checkpoint.id });
    assert.equal(git(f.root, ['status', '--porcelain=v1', '-z', '--', 'src', 'tests']), status);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'src/new.bin')), Buffer.from([0, 200, 255]));
    assert.equal(verifyPlanGuard(f.root).ok, false);
    const latest = fs.readFileSync(path.join(f.state, 'CHECKPOINT_LATEST.json'), 'utf8');
    assert.throws(() => createCheckpoint(f.root, { beforePublish: () => { throw new Error('capture failure'); } }), /failure/);
    assert.equal(fs.readFileSync(path.join(f.state, 'CHECKPOINT_LATEST.json'), 'utf8'), latest);
  } finally { f.dispose(); }
});

test('init is repeatable, preserves application/package and requires explicit backed-up reset', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.state, 'HANDOFF.md'), 'keep my progress');
    fs.writeFileSync(path.join(f.root, 'package.json'), '{"name":"existing-package"}');
    initializeProject(f.root); initializeProject(f.root);
    assert.equal(fs.readFileSync(path.join(f.state, 'HANDOFF.md'), 'utf8'), 'keep my progress');
    assert.equal(readJson(path.join(f.root, 'package.json')).name, 'existing-package');
    assert.throws(() => initializeProject(f.root, { reset: true }), /CONFIRMATION/);
    const reset = initializeProject(f.root, { reset: true, confirmReset: path.basename(f.root) });
    assert.equal(fs.readFileSync(path.join(reset.backup, 'HANDOFF.md'), 'utf8'), 'keep my progress');
    assert.equal(fs.existsSync(path.join(f.root, 'src/app.mjs')), true);
  } finally { f.dispose(); }
});

test('doctor defaults to offline and does not mistake configuration for a live verified host', async () => {
  const f = fixture();
  try {
    const result = await doctor(f.root, { fetchImpl: () => { throw new Error('network must not be called'); } });
    assert.equal(result.liveHostVerified, false);
    assert.ok(result.checks.some((c) => c.name === 'dependencies' && c.status === 'FAIL'));
  } finally { f.dispose(); }
});
