#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, commitStateFiles, hasPendingTransaction, digest } from './workflow_state.mjs';
import { captureBinding, captureCode, normalizeScope, repositoryIdentity, assertBindingCurrent } from './review_artifact.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stateFile = (root, name) => path.join(root, '.agents/state', name);
const emptyLock = () => ({ schemaVersion: 2, taskId: '', plan: null, code: null, planHash: '', codeDiffHash: '', updatedAt: '' });

export function loadWorkflowConfig(root = REPO_ROOT) {
  const defaults = { projectName: path.basename(root), cdpUrl: 'http://127.0.0.1:9222', geminiCdpUrl: 'http://127.0.0.1:9223', sourceDirs: ['src', 'tests'], testCommand: 'npm test', maxReviewRounds: 2, chatgptComposerMode: 'chat', chatgptModel: '' };
  const config = { ...defaults, ...readJson(path.join(root, '.agents/config.json'), { missing: {} }) };
  config.projectName = String(config.projectName || defaults.projectName).trim();
  config.sourceDirs = normalizeScope(config.sourceDirs);
  if (typeof config.testCommand !== 'string' || !config.testCommand.trim()) throw new Error('INVALID_TEST_COMMAND');
  return config;
}
export const loadStateLock = (root = REPO_ROOT) => readJson(stateFile(root, 'STATE_LOCK.json'), { missing: emptyLock() });
export function saveStateLock(lock, root = REPO_ROOT) {
  const data = { ...lock, updatedAt: new Date().toISOString() };
  writeJson(stateFile(root, 'STATE_LOCK.json'), data);
  return data;
}
// Compatibility export; evidence collection no longer modifies the Git index.
export const stageIntentToAdd = (root = REPO_ROOT, scope = ['src', 'tests']) => normalizeScope(scope).filter((p) => fs.existsSync(path.join(root, p)));
export function computePlanHash(root = REPO_ROOT) {
  return digest(fs.readFileSync(stateFile(root, 'CURRENT_PLAN.md'), 'utf8').replace(/\r\n/g, '\n').trim());
}
export const computeCodeDiffHash = (root = REPO_ROOT, scope = ['src', 'tests']) => captureCode(root, scope).codeDiffHash;

export function invalidateApproval(root, mode, taskId) {
  const current = loadStateLock(root);
  return saveStateLock({ ...emptyLock(), taskId, plan: mode === 'review-code' && current.schemaVersion === 2 ? current.plan : null, planHash: mode === 'review-code' ? current.planHash || '' : '' }, root);
}
function validateRecord(root, config, record, taskId, code = false) {
  if (!record || record.status !== 'APPROVED' || !record.requestId || !record.approvedBy || !record.binding?.planHash) throw new Error('APPROVAL_MISSING_OR_LEGACY');
  const b = record.binding;
  if (b.taskId !== taskId) throw new Error('APPROVAL_TASK_MISMATCH');
  const current = captureBinding(root, config, { taskId, mode: b.mode });
  if (['main', 'master'].includes(current.branch)) throw new Error('PROTECTED_BRANCH');
  for (const key of ['repoRoot', 'branch', 'baseCommit', 'configHash', 'planHash']) {
    if (current[key] !== b[key]) throw new Error('APPROVAL_STALE: ' + key);
  }
  if (JSON.stringify(current.sourceDirs) !== JSON.stringify(b.sourceDirs)) throw new Error('APPROVAL_SCOPE_MISMATCH');
  if (code && (b.mode !== 'review-code' || current.codeDiffHash !== b.codeDiffHash || record.testExitCode !== 0 || !/^[a-f0-9]{64}$/.test(record.testEvidenceHash || ''))) throw new Error('CODE_APPROVAL_OR_TEST_EVIDENCE_STALE');
  return true;
}
export function publishApproval(root, binding, { requestId, provider = 'chatgpt', approvedBy = provider, testExitCode = null, testEvidenceHash = '', humanOverride = false, extraWrites = {} } = {}) {
  if (!requestId || !approvedBy) throw new Error('MISSING_APPROVER_IDENTITY');
  if (['main', 'master'].includes(repositoryIdentity(root).branch)) throw new Error('PROTECTED_BRANCH');
  const config = loadWorkflowConfig(root);
  assertBindingCurrent(root, config, binding);
  const current = loadStateLock(root);
  const isCode = binding.mode === 'review-code';
  if (isCode) {
    validateRecord(root, config, current.plan, binding.taskId);
    if (testExitCode !== 0 || !/^[a-f0-9]{64}$/.test(testEvidenceHash)) throw new Error('TEST_EVIDENCE_REQUIRED');
  }
  const record = { status: 'APPROVED', requestId, provider, approvedBy, binding, testExitCode, testEvidenceHash, humanOverride, approvedAt: new Date().toISOString() };
  const lock = { ...emptyLock(), taskId: binding.taskId, plan: isCode ? current.plan : record, code: isCode ? record : null, planHash: binding.planHash, codeDiffHash: isCode ? binding.codeDiffHash : '', updatedAt: record.approvedAt };
  const header = isCode ? 'CODE_STATUS: APPROVED' : 'STATUS: APPROVED';
  commitStateFiles(root, {
    ...extraWrites,
    'STATE_LOCK.json': JSON.stringify(lock, null, 2) + '\n',
    [isCode ? 'CODE_REVIEW_FEEDBACK.md' : 'MENTOR_FEEDBACK.md']: header + '\n\nRequest: ' + requestId + '\nApprover: ' + approvedBy + '\n' + (humanOverride ? 'HUMAN_OVERRIDE; tests are recorded separately.\n' : ''),
  });
  return lock;
}
export function verifyPlanGuard(root = REPO_ROOT) {
  try {
    if (hasPendingTransaction(root)) throw new Error('STATE_RECOVERY_REQUIRED');
    const config = loadWorkflowConfig(root);
    const lock = loadStateLock(root);
    const session = readJson(stateFile(root, 'SESSION_MAP.json'));
    if (lock.schemaVersion !== 2 || !session.currentTask || lock.taskId !== session.currentTask) throw new Error('APPROVAL_TASK_OR_SCHEMA_MISMATCH');
    validateRecord(root, config, lock.plan, session.currentTask);
    return { ok: true, reason: '[VERIFY_GUARD] Plan approval matches task, repository, branch, base, scope and plan.' };
  } catch (e) { return { ok: false, reason: 'CHẶN SỬA CODE: ' + e.message }; }
}
export function verifyPreCommitGuard(root = REPO_ROOT) {
  try {
    if (hasPendingTransaction(root)) throw new Error('STATE_RECOVERY_REQUIRED');
    const config = loadWorkflowConfig(root);
    const opts = { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 50 * 1024 * 1024 };
    if (['main', 'master'].includes(repositoryIdentity(root).branch)) throw new Error('PROTECTED_BRANCH');
    const staged = childProcess.execFileSync('git', ['diff', '--cached', '--name-only', '-z'], opts).split('\0').filter(Boolean);
    const matches = (p) => config.sourceDirs.some((s) => p === s || p.startsWith(s + '/'));
    if (!staged.some(matches)) return { ok: true, reason: 'Commit outside configured code scope.' };
    const assertFullyStaged = () => {
      const unstaged = childProcess.execFileSync('git', ['diff', '--name-only', '-z', '--', ...config.sourceDirs], opts);
      const untracked = childProcess.execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', ...config.sourceDirs], opts);
      if (unstaged || untracked) throw new Error('CODE_MUST_BE_FULLY_STAGED');
    };
    assertFullyStaged();
    const indexBeforeTests = childProcess.execFileSync('git', ['diff', '--cached', '--binary', '--full-index'], opts);
    const lock = loadStateLock(root);
    const session = readJson(stateFile(root, 'SESSION_MAP.json'));
    if (lock.schemaVersion !== 2 || lock.taskId !== session.currentTask) throw new Error('APPROVAL_TASK_OR_SCHEMA_MISMATCH');
    validateRecord(root, config, lock.plan, session.currentTask);
    validateRecord(root, config, lock.code, session.currentTask, true);
    const test = process.platform === 'win32'
      ? childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', config.testCommand], { ...opts, timeout: 600_000 })
      : childProcess.spawnSync('sh', ['-c', config.testCommand], { ...opts, timeout: 600_000 });
    if (test.error || test.signal || test.status !== 0 || /WORKFLOW_NO_TESTS/.test(test.stdout || '')) throw new Error('TEST_FAILED_OR_MISSING');
    if (hasPendingTransaction(root)) throw new Error('STATE_RECOVERY_REQUIRED');
    assertFullyStaged();
    const indexAfterTests = childProcess.execFileSync('git', ['diff', '--cached', '--binary', '--full-index'], opts);
    if (indexAfterTests !== indexBeforeTests) throw new Error('INDEX_CHANGED_DURING_TESTS');
    const latestSession = readJson(stateFile(root, 'SESSION_MAP.json'));
    if (latestSession.currentTask !== session.currentTask) throw new Error('APPROVAL_TASK_MISMATCH');
    validateRecord(root, loadWorkflowConfig(root), lock.code, session.currentTask, true);
    return { ok: true, reason: '[VERIFY_GUARD] Code and fresh tests match the reviewed artifact.' };
  } catch (e) { return { ok: false, reason: 'CHẶN COMMIT: ' + e.message }; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = process.argv.includes('--check-plan') ? verifyPlanGuard() : process.argv.includes('--pre-commit') ? verifyPreCommitGuard() : { ok: false, reason: 'Use --check-plan or --pre-commit.' };
  console.log(result.reason);
  process.exitCode = result.ok ? 0 : 2;
}
