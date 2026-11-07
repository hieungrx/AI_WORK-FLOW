// Bộ kiểm thử đơn vị độc lập cho Review Policy v2 (.agents/scripts/review_policy.mjs & ask_mentor.mjs).
// Chạy riêng: node .agents/tests/review_policy.test.mjs (không gắn vào npm test để giữ nguyên phạm vi Task 4).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ESCALATION_EXIT_CODE,
  resolveMaxRounds,
  normalizeStageRounds,
  seedStageRounds,
  getStageRounds,
  incrementStageRound,
  resetStageRounds,
  checkRoundBudget,
  buildSeverityRules,
  parseSeverityReport,
  applySeverityGate,
  appendTechDebt,
  loadLedger,
  saveLedger,
  appendLedgerRound,
  getOpenIssues,
  buildConvergenceBlock,
  detectConvergenceViolations,
  computeUnifiedDiff,
  decidePlanPayload,
  buildPlanDeltaBody,
  renderEscalationBlock,
  upsertEscalation,
  removeEscalation,
  hasEscalation,
  resolveDualMentorPolicy,
  normalizeMentorFeedback,
  buildSecondOpinionBlock,
  renderAdvisorySection,
  combineDualStatus,
} from '../scripts/review_policy.mjs';
import {
  parseArgs,
  normalizeSessionMap,
  buildMentorPrompt,
  normalizeChatGptProjectUrl,
  normalizeComposerMode,
  resolveComposerMode,
} from '../scripts/ask_mentor.mjs';
import { loadWorkflowConfig } from '../scripts/verify_guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

// 1. Bộ đếm vòng theo giai đoạn & resolveMaxRounds
test('RP-1: resolveMaxRounds hỗ trợ số legacy, object chi tiết và mặc định theo provider/mode', () => {
  assert.equal(resolveMaxRounds(2, 'chatgpt', 'plan'), 2);
  assert.equal(resolveMaxRounds('4', 'gemini', 'review-code'), 4);
  const objCfg = {
    chatgpt: { plan: 3, 'review-code': 2, rescue: 2 },
    gemini: { plan: 2, 'review-code': 2, rescue: 2 },
  };
  assert.equal(resolveMaxRounds(objCfg, 'chatgpt', 'plan'), 3);
  assert.equal(resolveMaxRounds(objCfg, 'gemini', 'plan'), 2);
  assert.equal(resolveMaxRounds(objCfg, 'chatgpt', 'rescue'), 2);
  assert.equal(resolveMaxRounds(undefined, 'chatgpt', 'plan'), 3);
  assert.equal(resolveMaxRounds(undefined, 'gemini', 'plan'), 2);
});

test('RP-2: seedStageRounds & normalizeSessionMap di trú từ threads/geminiThreads và miễn nhiễm --new-thread', () => {
  const session = normalizeSessionMap({
    currentTask: 'task-4',
    threads: {
      'task-4-plan': { url: 'https://chatgpt.com/c/1', rounds: 2 },
      'task-4': { url: 'https://chatgpt.com/c/1', rounds: 2 },
    },
    geminiThreads: {
      'task-4-plan': { url: 'https://gemini.google.com/app/g1', rounds: 1 },
    },
  });
  assert.equal(getStageRounds(session, 'task-4-plan', 'chatgpt'), 2);
  assert.equal(getStageRounds(session, 'task-4-plan', 'gemini'), 1);
  assert.equal(session.stageRounds['task-4'], undefined);

  // Dù mở luồng mới (--new-thread), checkRoundBudget vẫn đọc stageRounds theo giai đoạn
  const budgetOk = checkRoundBudget(
    session,
    'task-4-plan',
    ['chatgpt', 'gemini'],
    { chatgpt: { plan: 3 }, gemini: { plan: 2 } },
    'plan'
  );
  assert.equal(budgetOk.ok, true);
  assert.equal(budgetOk.details[0].next, 3);
  assert.equal(budgetOk.details[1].next, 2);

  incrementStageRound(session, 'task-4-plan', 'chatgpt');
  const budgetExhausted = checkRoundBudget(
    session,
    'task-4-plan',
    ['chatgpt', 'gemini'],
    { chatgpt: { plan: 3 }, gemini: { plan: 2 } },
    'plan'
  );
  assert.equal(budgetExhausted.ok, false);
  assert.deepEqual(budgetExhausted.exhausted, ['chatgpt']);

  resetStageRounds(session, 'task-4-plan', ['chatgpt']);
  assert.equal(getStageRounds(session, 'task-4-plan', 'chatgpt'), 0);
  assert.equal(session.stageRounds['task-4-plan'].resets.length, 1);
  assert.deepEqual(session.stageRounds['task-4-plan'].resets[0].before, { chatgpt: 3 });
});

// 2. Severity Gate (P0-only blocking) & TECH_DEBT.md
test('RP-3: parseSeverityReport & applySeverityGate ép REJECTED khi APPROVED có P0, giữ REJECTED kèm cảnh báo khi không có P0', () => {
  const rawWithP0 = [
    'STATUS: APPROVED',
    '',
    '## BLOCKING (P0)',
    '- **[P0-01]** Thiếu kiểm tra symlink — có thể ghi đè file ngoài repo',
    '## NON-BLOCKING (P1/P2)',
    '- [P1-01] Nên tách hàm helper',
    '- [P2-1] Đổi tên biến cho rõ',
  ].join('\n');
  const rep1 = parseSeverityReport(rawWithP0);
  assert.equal(rep1.structured, true);
  assert.equal(rep1.p0.length, 1);
  assert.equal(rep1.p0[0].id, 'P0-01');
  assert.equal(rep1.p1.length, 1);
  assert.equal(rep1.p2.length, 1);
  assert.equal(rep1.p2[0].id, 'P2-01');

  const gate1 = applySeverityGate('APPROVED', rep1);
  assert.equal(gate1.status, 'REJECTED');
  assert.ok(gate1.warnings.includes('APPROVED_WITH_P0_FORCED_REJECT'));

  // REJECTED nhưng không có P0 (chọn A: giữ REJECTED + cảnh báo REJECT_WITHOUT_P0)
  const rawNoP0 = [
    'STATUS: REJECTED',
    '## BLOCKING (P0)',
    '- Không có',
    '## NON-BLOCKING (P1/P2)',
    '- [P1-02] Góp ý nhỏ',
  ].join('\n');
  const rep2 = parseSeverityReport(rawNoP0);
  assert.equal(rep2.p0.length, 0);
  const gate2 = applySeverityGate('REJECTED', rep2);
  assert.equal(gate2.status, 'REJECTED');
  assert.ok(gate2.warnings.includes('REJECT_WITHOUT_P0'));
});

test('RP-4: appendTechDebt ghi P1/P2 vào TECH_DEBT.md và loại trùng theo khóa', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-td-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const items = [
      { id: 'P1-01', title: 'Tách module', late: false },
      { id: 'P2-01', title: 'Thêm JSDoc', late: true },
    ];
    const added1 = appendTechDebt(tdFile, items, {
      threadKey: 'task-4-plan',
      provider: 'chatgpt',
      round: 2,
    });
    assert.equal(added1, 2);
    const added2 = appendTechDebt(tdFile, items, {
      threadKey: 'task-4-plan',
      provider: 'chatgpt',
      round: 2,
    });
    assert.equal(added2, 0);
    const text = fs.readFileSync(tdFile, 'utf8');
    assert.ok(text.includes('**P1-01** Tách module'));
    assert.ok(text.includes('late'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 3. Quy tắc hội tụ (Convergence Rule) & REVIEW_LEDGER.json
test('RP-5: Ledger lưu P0 qua các vòng và phát hiện vi phạm hội tụ khi thêm P0 mới không có tiền tố NEW-', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-ledger-'));
  try {
    const ledgerFile = path.join(tmpDir, 'REVIEW_LEDGER.json');
    const ledger = loadLedger(ledgerFile);
    appendLedgerRound(ledger, 'task-5-plan', 'chatgpt', {
      round: 1,
      status: 'REJECTED',
      p0: [{ id: 'P0-01', title: 'Lỗi khóa mutex', isNew: false }],
    });
    saveLedger(ledgerFile, ledger);

    const open = getOpenIssues(loadLedger(ledgerFile), 'task-5-plan', 'chatgpt');
    assert.equal(open.length, 1);
    const convPrompt = buildConvergenceBlock(open, 2);
    assert.ok(convPrompt.includes('[P0-01] Lỗi khóa mutex'));
    assert.ok(convPrompt.includes('NEW-P0-xx'));

    const round2Text = [
      'STATUS: REJECTED',
      '## ISSUE STATUS',
      '- [P0-01] RESOLVED',
      '## BLOCKING (P0)',
      '- [NEW-P0-01] Phát sinh từ thay đổi ở bước 3',
      '- [P0-99] Lỗi mới nhưng quên gắn NEW-',
    ].join('\n');
    const rep = parseSeverityReport(round2Text);
    assert.equal(rep.statuses['P0-01'], 'RESOLVED');
    const violations = detectConvergenceViolations(rep, open, 2);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].id, 'P0-99');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 4. Delta Review
test('RP-6: decidePlanPayload phân biệt unchanged / delta / full (>60% hoặc luồng mới)', () => {
  const basePlan = Array.from({ length: 40 }, (_, i) => `Dòng kế hoạch số ${i + 1}: nội dung chi tiết giữ nguyên.`).join('\n');
  const smallEdit = basePlan.replace('Dòng kế hoạch số 20: nội dung chi tiết giữ nguyên.', 'Dòng kế hoạch số 20: ĐÃ CẬP NHẬT.');
  const diffSmall = computeUnifiedDiff(basePlan, smallEdit);
  assert.ok(diffSmall && diffSmall.includes('+Dòng kế hoạch số 20: ĐÃ CẬP NHẬT.'));

  assert.equal(
    decidePlanPayload({
      effectiveNewThread: false,
      usedRounds: 1,
      previousSnapshot: basePlan,
      planContent: basePlan,
      diffText: '',
    }).kind,
    'unchanged'
  );

  assert.equal(
    decidePlanPayload({
      effectiveNewThread: false,
      usedRounds: 1,
      previousSnapshot: basePlan,
      planContent: smallEdit,
      diffText: diffSmall,
    }).kind,
    'delta'
  );

  assert.equal(
    decidePlanPayload({
      effectiveNewThread: true,
      usedRounds: 1,
      previousSnapshot: basePlan,
      planContent: smallEdit,
      diffText: diffSmall,
    }).kind,
    'full'
  );

  const deltaBody = buildPlanDeltaBody(diffSmall, '- P0-01 -> Đã sửa tại mục 20');
  assert.ok(deltaBody.includes('DIFF CURRENT_PLAN.md'));
  assert.ok(deltaBody.includes('P0-01 -> Đã sửa tại mục 20'));
});

// 5. Escalation block
test('RP-7: renderEscalationBlock, upsertEscalation và removeEscalation hoạt động idempotent', () => {
  const block = renderEscalationBlock({
    taskId: 'task-4',
    threadKey: 'task-4-plan',
    reason: 'Hết 3/3 vòng',
    budget: [{ provider: 'chatgpt', used: 3, max: 3 }],
    openIssues: { chatgpt: [{ id: 'P0-01', title: 'Chưa đóng' }] },
    lastStatus: { chatgpt: 'REJECTED' },
  });
  const h1 = upsertEscalation('# HANDOFF\n\nNội dung gốc.\n', 'task-4-plan', block);
  assert.ok(hasEscalation(h1, 'task-4-plan'));
  const h2 = upsertEscalation(h1, 'task-4-plan', block);
  assert.equal(
    h2.split('<!-- ESCALATION_START:task-4-plan -->').length - 1,
    1
  );
  const cleaned = removeEscalation(h2, 'task-4-plan');
  assert.equal(hasEscalation(cleaned, 'task-4-plan'), false);
  assert.ok(cleaned.includes('Nội dung gốc.'));
});

// 6. Gemini normalization & Dual-Mentor policy (chatgpt-gate vs both-required)
test('RP-8: normalizeMentorFeedback, buildSecondOpinionBlock, combineDualStatus theo lựa chọn chatgpt-gate', () => {
  assert.equal(resolveDualMentorPolicy(undefined), 'chatgpt-gate');
  const norm = normalizeMentorFeedback('STATUS: approved\nChi tiết...', 'APPROVED', 'plan');
  assert.ok(norm.startsWith('STATUS: APPROVED\n\nChi tiết...'));

  const geminiEval = {
    status: 'REJECTED',
    url: 'https://gemini.google.com/app/bba140fe8808ed1b',
    report: { p0: [{ id: 'P0-07', title: 'Cảnh báo race condition' }], p1: [], p2: [] },
  };
  const secondOp = buildSecondOpinionBlock(geminiEval);
  assert.ok(secondOp.includes('[GEMINI-P0-07]'));

  // chatgpt-gate: ChatGPT APPROVED vẫn giữ APPROVED dù Gemini REJECTED, nhưng báo CONFLICT
  const cGate = combineDualStatus('APPROVED', geminiEval, 'chatgpt-gate');
  assert.equal(cGate.finalStatus, 'APPROVED');
  assert.equal(cGate.consensus, 'CONFLICT');

  // both-required: hạ xuống REJECTED nếu Gemini REJECTED
  const bothReq = combineDualStatus('APPROVED', geminiEval, 'both-required');
  assert.equal(bothReq.finalStatus, 'REJECTED');

  const advisory = renderAdvisorySection(geminiEval, 'chatgpt-gate');
  assert.ok(advisory.includes('tham khảo — ChatGPT quyết định'));
  assert.ok(advisory.includes('[P0-07]'));
});

// 7. Kiểm tra CLI --dry-run không làm thay đổi bất kỳ file nào trong .agents/state/
test('RP-9: ask_mentor.mjs --dry-run chạy quyết định mà không sửa bất kỳ file nào trong .agents/state/*', () => {
  const stateDir = path.join(REPO_ROOT, '.agents', 'state');
  const snapshotBefore = Object.fromEntries(
    fs
      .readdirSync(stateDir)
      .filter((f) => fs.statSync(path.join(stateDir, f)).isFile())
      .map((f) => [f, fs.readFileSync(path.join(stateDir, f), 'utf8')])
  );

  const res = childProcess.spawnSync(
    process.execPath,
    [
      path.join(REPO_ROOT, '.agents', 'scripts', 'ask_mentor.mjs'),
      '--dry-run',
      '--mode',
      'plan',
      '--task',
      'task-1',
      '--provider',
      'both',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.ok(res.stdout.includes('provider=gemini | stage=task-1-plan | round='));
  assert.ok(res.stdout.includes('provider=chatgpt | stage=task-1-plan | round='));

  const snapshotAfter = Object.fromEntries(
    fs
      .readdirSync(stateDir)
      .filter((f) => fs.statSync(path.join(stateDir, f)).isFile())
      .map((f) => [f, fs.readFileSync(path.join(stateDir, f), 'utf8')])
  );
  assert.deepEqual(snapshotAfter, snapshotBefore);
});

test('RP-10: parseArgs & buildMentorPrompt tích hợp cờ mới và khối Severity Gate', () => {
  const parsed = parseArgs([
    '--mode=plan',
    '--provider=both',
    '--dry-run',
    '--reset-rounds',
    '--ensure-project',
  ]);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.resetRounds, true);
  assert.equal(parsed.ensureProject, true);
  assert.equal(parsed.provider, 'both');

  const { prompt } = buildMentorPrompt('plan', 'Nội dung kế hoạch', '');
  assert.ok(prompt.includes('Bạn là Mentor đánh giá thiết kế kỹ thuật'));
  assert.ok(prompt.includes('QUY TẮC PHÂN LOẠI MỨC ĐỘ (SEVERITY GATE)'));
});

test('RP-11: Tự động lấy tên thư mục dự án Antigravity khi projectName trống & chuẩn hóa URL Project ChatGPT', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-proj-'));
  const fakeWorkspaceDir = path.join(tmpRoot, 'Booking-SaaS-Pro');
  fs.mkdirSync(path.join(fakeWorkspaceDir, '.agents'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeWorkspaceDir, '.agents', 'config.json'),
    JSON.stringify({ projectName: '' }, null, 2),
    'utf8'
  );
  try {
    const cfg = loadWorkflowConfig(fakeWorkspaceDir);
    assert.equal(cfg.projectName, 'Booking-SaaS-Pro');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  assert.equal(
    normalizeChatGptProjectUrl(
      'https://chatgpt.com/g/g-p-6ad3b17e96f88191bf0fda969044d956-ai-workspace/c/6aef8c5e-78c8-83ec-8d58-f8802d701864'
    ),
    'https://chatgpt.com/g/g-p-6ad3b17e96f88191bf0fda969044d956-ai-workspace/project'
  );
  assert.equal(
    normalizeChatGptProjectUrl('https://chatgpt.com/g/g-p-6ad3b17e96f88191bf0fda969044d956'),
    'https://chatgpt.com/g/g-p-6ad3b17e96f88191bf0fda969044d956/project'
  );
  assert.equal(normalizeChatGptProjectUrl('https://chatgpt.com/'), '');
});

test('RP-12: Chế độ khung chat Project (Trò chuyện / Công việc) qua --composer và config.chatgptComposerMode', () => {
  assert.equal(normalizeComposerMode('chat'), 'chat');
  assert.equal(normalizeComposerMode('Trò chuyện'), 'chat');
  assert.equal(normalizeComposerMode('WORK'), 'work');
  assert.equal(normalizeComposerMode('Công việc'), 'work');
  assert.equal(normalizeComposerMode('codex'), '');

  // Ưu tiên: --composer > config > mặc định "work"
  assert.equal(resolveComposerMode('', {}), 'work');
  assert.equal(resolveComposerMode('', { chatgptComposerMode: 'chat' }), 'chat');
  assert.equal(resolveComposerMode('work', { chatgptComposerMode: 'chat' }), 'work');
  assert.equal(resolveComposerMode('', { chatgptComposerMode: 'bogus' }), 'work');

  assert.equal(parseArgs(['--composer', 'chat']).composerArg, 'chat');
  assert.equal(parseArgs(['--composer=công việc']).composerArg, 'work');
  assert.equal(parseArgs(['--effort', 'tức thì']).effortArg, 'instant');
  assert.equal(parseArgs(['--effort=vừa']).effortArg, 'standard');
  assert.equal(parseArgs(['--effort', 'cao']).effortArg, 'high');
  assert.equal(parseArgs([]).composerArg, '');
  assert.throws(() => parseArgs(['--composer', 'codex']), /--composer không hợp lệ/);
});

console.log(`\n=== TỔNG KẾT REVIEW POLICY v2: ${passed}/${passed} PASS ===`);
