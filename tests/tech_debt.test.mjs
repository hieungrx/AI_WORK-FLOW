import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_MAX_TECH_DEBT_PER_ROUND,
  DEFAULT_LOCK_OPTIONS,
  validateLockOptions,
  withFileLock,
  recoverOrphanedLock,
  sha256Hex,
  sanitizeSingleLineMarkdown,
  sanitizeIssueId,
  splitIssueTitle,
  extractTaskIdFromThreadKey,
  normalizeCanonicalSummary,
  buildTechDebtFingerprint,
  extractExistingFingerprints,
  filterAndRankTechDebt,
  appendTechDebt,
  ingestMentorTechDebtReport,
  parseTechDebtFile,
  resolveTechDebt,
  summarizeTechDebt,
} from '../src/tech_debt.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODULE_URL = pathToFileURL(path.resolve(__dirname, '../src/tech_debt.mjs')).href;

test('TD-1: splitIssueTitle, extractTaskIdFromThreadKey và normalizeCanonicalSummary xử lý NFC/NFD & Markdown', () => {
  const s1 = splitIssueTitle('Thiếu kịch bản E2E — Bổ sung các trường hợp biên và lỗi mạng.');
  assert.equal(s1.summary, 'Thiếu kịch bản E2E');
  assert.equal(s1.detail, 'Bổ sung các trường hợp biên và lỗi mạng.');

  const s2 = splitIssueTitle('Chuẩn hóa log: Cần thêm timestamp ISO-8601');
  assert.equal(s2.summary, 'Chuẩn hóa log');
  assert.equal(s2.detail, 'Cần thêm timestamp ISO-8601');

  assert.equal(extractTaskIdFromThreadKey('task-1-plan'), 'task-1');
  assert.equal(extractTaskIdFromThreadKey('task-1-review-code'), 'task-1');
  assert.equal(extractTaskIdFromThreadKey('task-1-rescue'), 'task-1');

  // Kiểm thử chuẩn hóa Unicode NFC vs NFD và ký tự trang trí Markdown
  const nfc = 'Tối ưu **bộ nhớ** `cache`_tạm_!';
  const nfd = nfc.normalize('NFD');
  assert.equal(normalizeCanonicalSummary(nfc), normalizeCanonicalSummary(nfd));
  assert.equal(normalizeCanonicalSummary(nfc), 'tối ưu bộ nhớ cache tạm');
});

test('TD-2 [P0-02]: Fingerprint dùng SHA-256 trên toàn bộ summary — không mất mục khi trùng 80 ký tự đầu', () => {
  const sharedPrefix85Chars =
    'Kiểm tra tính toàn vẹn của gói dữ liệu đầu vào trong luồng đồng bộ trạng thái giữa các ';
  assert.ok(sharedPrefix85Chars.length > 80);

  const summaryA = `${sharedPrefix85Chars}tiến trình Worker A và Mentor Gate`;
  const summaryB = `${sharedPrefix85Chars}tiến trình Worker B và Bộ nhớ đệm`;

  const fpA = buildTechDebtFingerprint('task-1-plan', summaryA);
  const fpB = buildTechDebtFingerprint('task-1-plan', summaryB);
  assert.notEqual(fpA, fpB);
  assert.match(fpA, /^task-1\|[0-9a-f]{64}$/);
  assert.match(fpB, /^task-1\|[0-9a-f]{64}$/);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-p0-02-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const added = appendTechDebt(
      tdFile,
      [
        { id: 'P1-01', title: `${summaryA} — Chi tiết A` },
        { id: 'P1-02', title: `${summaryB} — Chi tiết B` },
      ],
      { threadKey: 'task-1-plan', provider: 'chatgpt', round: 1 }
    );
    assert.equal(added, 2);
    const records = parseTechDebtFile(fs.readFileSync(tdFile, 'utf8'));
    assert.equal(records.length, 2);
    assert.equal(records[0].summary, summaryA);
    assert.equal(records[1].summary, summaryB);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-3: filterAndRankTechDebt lọc nhiễu, nâng mức P2->P1 khi trùng trong lô, ưu tiên P1 và cắt theo trần maxItems', () => {
  const rawItems = [
    { id: 'P2-01', title: 'Không có.' },
    { id: 'P2-02', title: 'None' },
    { id: 'P2-03', title: 'Tối ưu thông báo lỗi — Thêm mã lỗi chi tiết' },
    { id: 'P1-01', title: 'Tối ưu thông báo lỗi — Cần mã lỗi rõ ràng hơn' }, // Trùng summary với P2-03 -> nâng lên P1
    { id: 'P2-04', title: 'Góp ý văn phong 1 — Chi tiết' },
    { id: 'P1-02', title: 'Kiểm tra quyền truy cập — Chi tiết' },
    { id: 'P1-03', title: 'Giới hạn kích thước tệp — Chi tiết' },
    { id: 'P2-05', title: 'Góp ý văn phong 2 — Chi tiết' },
    { id: 'P2-06', title: 'Góp ý văn phong 3 — Chi tiết' },
  ];

  const res = filterAndRankTechDebt(rawItems, { maxItems: DEFAULT_MAX_TECH_DEBT_PER_ROUND });
  assert.equal(res.selected.length, 5);
  assert.equal(res.stats.filteredNoise, 2);
  assert.equal(res.stats.deduplicatedInBatch, 1);
  assert.equal(res.stats.cappedByLimit, 1);
  assert.equal(res.droppedCount, 4);

  // Ba mục đầu tiên bắt buộc phải là P1
  assert.equal(res.selected[0].level, 'P1');
  assert.equal(res.selected[0].summary, 'Tối ưu thông báo lỗi');
  assert.equal(res.selected[1].level, 'P1');
  assert.equal(res.selected[2].level, 'P1');
  assert.equal(res.selected[3].level, 'P2');
  assert.equal(res.selected[4].level, 'P2');
});

test('TD-4: appendTechDebt khử trùng lặp xuyên vòng, xuyên pha (plan/review) và xuyên provider (chatgpt/gemini)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-dedup-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const now = new Date('2026-11-08T00:00:00Z');

    const added1 = appendTechDebt(
      tdFile,
      [
        { id: 'P1-01', title: 'Tách module cấu hình — Nên gom về một file riêng' },
        { id: 'P2-01', title: 'Bổ sung JSDoc cho hàm helper', late: true },
      ],
      { threadKey: 'task-1-plan', provider: 'chatgpt', round: 1 },
      now
    );
    assert.equal(added1, 2);

    // Cùng vấn đề "Tách module cấu hình" nhưng ở pha review-code, provider gemini, mã P1-04 và câu giải thích khác
    const added2 = appendTechDebt(
      tdFile,
      [
        { id: 'P1-04', title: '**Tách module cấu hình** — Đề xuất tách thành config_loader.mjs' },
        { id: 'P1-05', title: 'Kiểm tra timeout kết nối — Tránh treo tiến trình' },
      ],
      { threadKey: 'task-1-review', provider: 'gemini', round: 2 },
      now
    );
    assert.equal(added2, 1); // Chỉ thêm "Kiểm tra timeout kết nối"

    const content = fs.readFileSync(tdFile, 'utf8');
    assert.ok(content.includes('**P1-01** Tách module cấu hình'));
    assert.ok(content.includes('late'));
    const records = parseTechDebtFile(content);
    assert.equal(records.length, 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-5 [P1-01]: Tương thích ngược với khóa legacy <!-- TD:threadKey|provider|id|rawTitle -->', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-legacy-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const legacyLine =
      '- [ ] **P1-01** Tách module xử lý chuỗi — Giảm độ phức tạp _(task-2-plan · chatgpt · vòng 1 · 2026-11-07)_ <!-- TD:task-2-plan|chatgpt|P1-01|Tách module xử lý chuỗi — Giảm độ phức tạp -->\n';
    fs.writeFileSync(
      tdFile,
      `# TECH_DEBT — Góp ý không chặn (P1/P2) từ Mentor\n\n${legacyLine}`,
      'utf8'
    );

    // Gửi lại cùng tiêu đề "Tách module xử lý chuỗi" ở vòng 2 -> không bị ghi trùng
    const added = appendTechDebt(
      tdFile,
      [{ id: 'P1-03', title: 'Tách module xử lý chuỗi — Gợi ý diễn đạt lại ở vòng 2' }],
      { threadKey: 'task-2-review', provider: 'gemini', round: 2 }
    );
    assert.equal(added, 0);

    const contentAfter = fs.readFileSync(tdFile, 'utf8');
    assert.ok(contentAfter.includes(legacyLine.trim()));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-6 [P0-03]: Bảo vệ cấu trúc Markdown 1 dòng trước chuỗi xuống dòng, --> và ký tự đặc biệt (round-trip)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-p0-03-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const maliciousTitle =
      'Kiểm tra **input**\r\nchứa xuống dòng <!-- giả mạo --> — Chi tiết có chứa -->\nvà <!-- TD:fake|123 --> bên trong';

    const added = appendTechDebt(
      tdFile,
      [{ id: 'P1-01', title: maliciousTitle }],
      { threadKey: 'task-3-plan', provider: 'chatgpt', round: 1 }
    );
    assert.equal(added, 1);

    const rawContent = fs.readFileSync(tdFile, 'utf8');
    const bulletLines = rawContent
      .split('\n')
      .filter((line) => line.trim().startsWith('- ['));
    assert.equal(bulletLines.length, 1);
    assert.ok(!bulletLines[0].slice(0, -85).includes('-->'));

    const parsed = parseTechDebtFile(rawContent);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].id, 'P1-01');
    assert.equal(parsed[0].taskId, 'task-3');
    assert.ok(parsed[0].summary.includes('Kiểm tra input chứa xuống dòng'));
    assert.ok(parsed[0].detail.includes('--&gt;'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-7 [P0-01]: resolveTechDebt chống đóng nhầm bản ghi giữa nhiều Task và từ chối matcher mơ hồ (fail-closed)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-p0-01-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const now = new Date('2026-11-08T00:00:00Z');

    // Task 1 và Task 2 đều có mục P1-01 và đều có từ khóa "Chuẩn hóa log"
    appendTechDebt(
      tdFile,
      [
        { id: 'P1-01', title: 'Chuẩn hóa log truy cập — Thêm requestId cho Task 1' },
        { id: 'P2-01', title: 'Chuẩn hóa log lỗi hệ thống — Thêm stacktrace rút gọn' },
      ],
      { threadKey: 'task-1-plan', provider: 'chatgpt', round: 1 },
      now
    );
    appendTechDebt(
      tdFile,
      [{ id: 'P1-01', title: 'Chuẩn hóa log thanh toán — Ẩn thông tin nhạy cảm cho Task 2' }],
      { threadKey: 'task-2-plan', provider: 'chatgpt', round: 1 },
      now
    );

    const snapshotBefore = fs.readFileSync(tdFile, 'utf8');

    // 1. Tìm theo ID nhưng thiếu taskId -> bắt buộc ném lỗi UNSCOPED_ID_MATCHER và không sửa file
    assert.throws(
      () => resolveTechDebt(tdFile, 'P1-01', 'Cố tình truyền thiếu taskId'),
      /UNSCOPED_ID_MATCHER/
    );
    assert.throws(
      () => resolveTechDebt(tdFile, [{ id: 'P1-01' }], 'Thiếu taskId trong object'),
      /UNSCOPED_ID_MATCHER/
    );
    assert.equal(fs.readFileSync(tdFile, 'utf8'), snapshotBefore);

    // 2. Tìm theo summary mơ hồ ("Chuẩn hóa log" khớp cả 3 bản ghi) -> ném lỗi AMBIGUOUS_MATCH và không sửa file
    assert.throws(
      () => resolveTechDebt(tdFile, { summary: 'Chuẩn hóa log' }),
      /AMBIGUOUS_MATCH/
    );
    assert.throws(
      () => resolveTechDebt(tdFile, { taskId: 'task-1', summary: 'Chuẩn hóa log' }),
      /AMBIGUOUS_MATCH/
    );
    assert.equal(fs.readFileSync(tdFile, 'utf8'), snapshotBefore);

    // 3. Giải quyết chính xác P1-01 của riêng task-1 (không ảnh hưởng P1-01 của task-2)
    const resolvedCount1 = resolveTechDebt(
      tdFile,
      { taskId: 'task-1', id: 'P1-01' },
      'Đã bổ sung requestId vào logger',
      now
    );
    assert.equal(resolvedCount1, 1);

    const recordsAfter1 = parseTechDebtFile(fs.readFileSync(tdFile, 'utf8'));
    const task1P1 = recordsAfter1.find((r) => r.taskId === 'task-1' && r.id === 'P1-01');
    const task2P1 = recordsAfter1.find((r) => r.taskId === 'task-2' && r.id === 'P1-01');
    assert.equal(task1P1.checked, true);
    assert.equal(task2P1.checked, false);

    // 4. Giải quyết bằng fingerprint chính xác cho bản ghi của task-2
    const resolvedCount2 = resolveTechDebt(
      tdFile,
      task2P1.fingerprint,
      'Đã che mặt nạ thẻ thanh toán',
      now
    );
    assert.equal(resolvedCount2, 1);

    // 5. Kiểm tra thống kê summarizeTechDebt
    const stats = summarizeTechDebt(tdFile);
    assert.equal(stats.total, 3);
    assert.equal(stats.open, 1);
    assert.equal(stats.resolved, 2);
    assert.deepEqual(stats.byLevel.P1, { open: 0, resolved: 2 });
    assert.deepEqual(stats.byLevel.P2, { open: 1, resolved: 0 });
    assert.deepEqual(stats.byTask['task-1'], { open: 1, resolved: 1 });
    assert.deepEqual(stats.byTask['task-2'], { open: 0, resolved: 1 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-8 [P1-03]: writeFileAtomic dọn file tạm khi lỗi và bảo toàn nguyên trạng dữ liệu khi giao dịch thất bại', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-p1-03-'));
  try {
    // 1. Khi đích ghi là một thư mục đang tồn tại -> renameSync lỗi -> file tạm phải được dọn sạch
    const conflictDir = path.join(tmpDir, 'DIR_AS_FILE.md');
    fs.mkdirSync(conflictDir);
    assert.throws(() => {
      appendTechDebt(
        conflictDir,
        [{ id: 'P1-01', title: 'Lỗi ghi vào thư mục — Phải dọn file .tmp' }],
        { threadKey: 'task-1-plan', provider: 'chatgpt', round: 1 }
      );
    });
    const remainingEntries = fs.readdirSync(tmpDir);
    assert.deepEqual(remainingEntries, ['DIR_AS_FILE.md']);

    // 2. Khi resolveTechDebt truyền danh sách gồm 1 matcher hợp lệ + 1 matcher lỗi -> toàn bộ file gốc giữ nguyên (all-or-nothing)
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    appendTechDebt(
      tdFile,
      [{ id: 'P1-01', title: 'Kiểm tra tính nguyên tử — Bản ghi gốc' }],
      { threadKey: 'task-1-plan', provider: 'chatgpt', round: 1 }
    );
    const originalContent = fs.readFileSync(tdFile, 'utf8');

    assert.throws(
      () =>
        resolveTechDebt(tdFile, [
          { taskId: 'task-1', id: 'P1-01' },
          'P1-02', // Thiếu taskId -> lỗi UNSCOPED_ID_MATCHER
        ]),
      /UNSCOPED_ID_MATCHER/
    );
    assert.equal(fs.readFileSync(tdFile, 'utf8'), originalContent);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-9 [Review P0-01]: appendTechDebt loại bỏ fingerprint đã tồn tại TRƯỚC KHI áp dụng giới hạn maxItems', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-rev-p0-01-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const now = new Date('2026-11-08T00:00:00Z');

    const initialFive = [
      { id: 'P1-01', title: 'Vấn đề cũ 1 — Chi tiết 1' },
      { id: 'P1-02', title: 'Vấn đề cũ 2 — Chi tiết 2' },
      { id: 'P1-03', title: 'Vấn đề cũ 3 — Chi tiết 3' },
      { id: 'P1-04', title: 'Vấn đề cũ 4 — Chi tiết 4' },
      { id: 'P1-05', title: 'Vấn đề cũ 5 — Chi tiết 5' },
    ];

    const added1 = appendTechDebt(
      tdFile,
      initialFive,
      { threadKey: 'task-1-plan', provider: 'chatgpt', round: 1, maxItems: 5 },
      now
    );
    assert.equal(added1, 5);

    // Lần 2: gửi lại 5 mục cũ ở đầu danh sách + 1 mục mới ở vị trí thứ 6 -> mục thứ 6 KHÔNG ĐƯỢC bị cắt bỏ
    const roundTwoItems = [
      ...initialFive,
      { id: 'P2-06', title: 'Vấn đề mới phát sinh ở vị trí thứ 6 — Không được bỏ sót' },
    ];

    const added2 = appendTechDebt(
      tdFile,
      roundTwoItems,
      { threadKey: 'task-1-plan', provider: 'chatgpt', round: 2, maxItems: 5 },
      now
    );
    assert.equal(added2, 1);

    const summary = summarizeTechDebt(tdFile);
    assert.equal(summary.total, 6);
    assert.equal(summary.open, 6);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-10 [Review P0-02]: resolveTechDebt và parseTechDebtFile bảo toàn bản ghi khi resolutionNote chứa (), _()_ và ký tự đặc biệt', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-rev-p0-02-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const now = new Date('2026-11-08T00:00:00Z');

    appendTechDebt(
      tdFile,
      [
        {
          id: 'P1-01',
          title: 'Xử lý hàm parse(input) _(legacy)_ — Tránh lỗi regex khi có ngoặc đơn',
        },
      ],
      { threadKey: 'task-1-review', provider: 'chatgpt', round: 1 },
      now
    );

    const beforeStats = summarizeTechDebt(tdFile);
    assert.equal(beforeStats.total, 1);
    assert.equal(beforeStats.open, 1);

    const complexNote =
      'Fixed parse() handling, fn(a, b) & _(sub-note)_ [PR #12](https://example.com/pr/12) <!-- comment -->';
    const resolved = resolveTechDebt(
      tdFile,
      { taskId: 'task-1', id: 'P1-01' },
      complexNote,
      now
    );
    assert.equal(resolved, 1);

    const afterStats = summarizeTechDebt(tdFile);
    assert.equal(afterStats.total, 1);
    assert.equal(afterStats.open, 0);
    assert.equal(afterStats.resolved, 1);

    const records = parseTechDebtFile(fs.readFileSync(tdFile, 'utf8'));
    assert.equal(records.length, 1);
    assert.equal(records[0].checked, true);
    assert.equal(records[0].summary, 'Xử lý hàm parse(input) _(legacy)_');
    assert.ok(records[0].resolutionNote.includes('Fixed parse() handling, fn(a, b)'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-11 [P1-02 & P2-01]: Kiểm thử tranh chấp thực tế đa tiến trình qua 2 giai đoạn (5 append + 4 resolve = 9 tiến trình Worker)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-concurrency-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const barrierPhase1 = path.join(tmpDir, 'barrier-phase1.go');
    const barrierPhase2 = path.join(tmpDir, 'barrier-phase2.go');
    const workerScript = path.join(tmpDir, 'worker.mjs');

    fs.writeFileSync(
      workerScript,
      `
import fs from 'node:fs';
import { appendTechDebt, resolveTechDebt } from ${JSON.stringify(MODULE_URL)};

const [mode, tdFile, barrierFile, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson);
const readyFile = barrierFile + '.ready.' + payload.workerId;
fs.writeFileSync(readyFile, '1', 'utf8');

const waitStart = Date.now();
while (!fs.existsSync(barrierFile)) {
  if (Date.now() - waitStart > 10000) {
    throw new Error('Barrier timeout');
  }
}

if (mode === 'append') {
  appendTechDebt(tdFile, payload.items, {
    threadKey: 'task-2-plan',
    provider: 'chatgpt',
    round: payload.workerId,
    lockOptions: { timeoutMs: 15000, retryMinMs: 5, retryMaxMs: 15, holdDelayMs: 35 },
  });
} else if (mode === 'resolve') {
  resolveTechDebt(
    tdFile,
    payload.fingerprint,
    'Closed by worker-' + payload.workerId,
    new Date('2026-11-08T00:00:00Z'),
    { timeoutMs: 15000, retryMinMs: 5, retryMaxMs: 15, holdDelayMs: 25 }
  );
}
`,
      'utf8'
    );

    const runWorker = (mode, barrierFile, payload) =>
      new Promise((resolve, reject) => {
        const child = childProcess.spawn(
          process.execPath,
          [workerScript, mode, tdFile, barrierFile, JSON.stringify(payload)],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
        );
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`Worker ${payload.workerId} (${mode}) exited with ${code}: ${stderr}`));
          } else {
            resolve();
          }
        });
      });

    const waitUntilAllReady = async (barrierFile, count) => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        let readyCount = 0;
        for (let i = 1; i <= count; i += 1) {
          if (fs.existsSync(`${barrierFile}.ready.${i}`)) readyCount += 1;
        }
        if (readyCount === count) return;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error(`Không đủ ${count} tiến trình sẵn sàng tại barrier.`);
    };

    // Giai đoạn 1: 5 tiến trình cùng append (mỗi tiến trình 3 mục riêng + 1 mục dùng chung = 16 mục duy nhất)
    const expectedSummaries = ['Mục dùng chung giữa 5 tiến trình đồng thời'];
    const phase1Promises = [];
    for (let w = 1; w <= 5; w += 1) {
      const s1 = `Mục riêng của tiến trình ${w} số 1`;
      const s2 = `Mục riêng của tiến trình ${w} số 2`;
      const s3 = `Mục riêng của tiến trình ${w} số 3`;
      expectedSummaries.push(s1, s2, s3);

      phase1Promises.push(
        runWorker('append', barrierPhase1, {
          workerId: w,
          items: [
            { id: 'P1-01', title: `${s1} — Chi tiết ${w}.1` },
            { id: 'P1-02', title: `${s2} — Chi tiết ${w}.2` },
            { id: 'P2-01', title: `${s3} — Chi tiết ${w}.3` },
            {
              id: 'P1-03',
              title: `Mục dùng chung giữa 5 tiến trình đồng thời — Ghi bởi worker ${w}`,
            },
          ],
        })
      );
    }

    await waitUntilAllReady(barrierPhase1, 5);
    fs.writeFileSync(barrierPhase1, 'GO', 'utf8');
    await Promise.all(phase1Promises);

    const recordsAfterPhase1 = parseTechDebtFile(fs.readFileSync(tdFile, 'utf8'));
    assert.equal(recordsAfterPhase1.length, 16);

    const actualFingerprints = new Set(recordsAfterPhase1.map((r) => r.fingerprint));
    for (const s of expectedSummaries) {
      const expectedFp = buildTechDebtFingerprint('task-2', s);
      assert.ok(
        actualFingerprints.has(expectedFp),
        `Thiếu fingerprint cho summary "${s}" (${expectedFp})`
      );
    }

    // Giai đoạn 2: 4 tiến trình cùng resolve 4 bản ghi cụ thể theo fingerprint
    const targetsToResolve = [
      buildTechDebtFingerprint('task-2', 'Mục riêng của tiến trình 1 số 1'),
      buildTechDebtFingerprint('task-2', 'Mục riêng của tiến trình 2 số 1'),
      buildTechDebtFingerprint('task-2', 'Mục riêng của tiến trình 3 số 1'),
      buildTechDebtFingerprint('task-2', 'Mục riêng của tiến trình 4 số 1'),
    ];

    const phase2Promises = targetsToResolve.map((fp, idx) =>
      runWorker('resolve', barrierPhase2, {
        workerId: idx + 1,
        fingerprint: fp,
      })
    );

    await waitUntilAllReady(barrierPhase2, 4);
    fs.writeFileSync(barrierPhase2, 'GO', 'utf8');
    await Promise.all(phase2Promises);

    const finalStats = summarizeTechDebt(tdFile);
    assert.equal(finalStats.total, 16);
    assert.equal(finalStats.resolved, 4);
    assert.equal(finalStats.open, 12);

    const finalRecords = parseTechDebtFile(fs.readFileSync(tdFile, 'utf8'));
    for (const targetFp of targetsToResolve) {
      const found = finalRecords.find((r) => r.fingerprint === targetFp);
      assert.ok(found);
      assert.equal(found.checked, true);
    }

    // Đảm bảo không còn tệp .lock hoặc .tmp nào sót lại
    const leftoverLockOrTmp = fs
      .readdirSync(tmpDir)
      .filter((name) => name.endsWith('.lock') || name.includes('.tmp.'));
    assert.deepEqual(leftoverLockOrTmp, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-12 [P0-01/P0-02/P0-03/P1-03/P1-05]: Bảo vệ chủ khóa chạy lâu trước nhiều waiter bị LOCK_TIMEOUT, validateLockOptions và recoverOrphanedLock', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-lock-safety-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const lockFile = `${tdFile}.lock`;

    // 1. Kiểm thử validateLockOptions ([P1-05])
    assert.throws(() => validateLockOptions({ timeoutMs: -5 }), /INVALID_LOCK_OPTIONS/);
    assert.throws(
      () => validateLockOptions({ retryMinMs: 50, retryMaxMs: 10 }),
      /INVALID_LOCK_OPTIONS/
    );
    assert.throws(() => validateLockOptions({ holdDelayMs: -1 }), /INVALID_LOCK_OPTIONS/);
    assert.equal(DEFAULT_LOCK_OPTIONS.timeoutMs, 5000);

    // 2. Kịch bản P0-01 / P0-02 / P0-03: Chủ khóa A giữ khóa 350ms, hai waiter B và C cạnh tranh với timeout 60ms.
    // B và C phải ném LOCK_TIMEOUT mà KHÔNG ĐƯỢC cướp hoặc xóa khóa của A; A vẫn hoàn tất ghi và giải phóng khóa an toàn.
    const holderScript = path.join(tmpDir, 'holder.mjs');
    const holderReady = path.join(tmpDir, 'holder.ready');
    fs.writeFileSync(
      holderScript,
      `
import fs from 'node:fs';
import { withFileLock, appendTechDebt } from ${JSON.stringify(MODULE_URL)};

const [tdFile, holderReady] = process.argv.slice(2);
withFileLock(tdFile, () => {
  fs.writeFileSync(holderReady, 'LOCKED', 'utf8');
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, 350);
  fs.writeFileSync(tdFile, '# TECH_DEBT — Góp ý không chặn (P1/P2) từ Mentor\\n\\n- [ ] **P1-01** Ghi bởi chủ khóa A — Thành công _(task-2 · chatgpt · vòng 1 · 2026-11-08)_ <!-- TD:task-2|' + 'a'.repeat(64) + ' -->\\n', 'utf8');
}, { timeoutMs: 2000 });
`,
      'utf8'
    );

    const holderProc = childProcess.spawn(
      process.execPath,
      [holderScript, tdFile, holderReady],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    const waitReadyStart = Date.now();
    while (!fs.existsSync(holderReady)) {
      if (Date.now() - waitReadyStart > 5000) {
        throw new Error('Holder process did not acquire lock in time');
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    // Trong lúc A đang giữ khóa: cả waiter B và waiter C đều bị LOCK_TIMEOUT và không được cướp khóa của A
    assert.throws(
      () =>
        appendTechDebt(
          tdFile,
          [{ id: 'P1-02', title: 'Waiter B cố ghi khi khóa bận' }],
          {
            threadKey: 'task-2-plan',
            provider: 'chatgpt',
            round: 1,
            lockOptions: { timeoutMs: 60, retryMinMs: 10, retryMaxMs: 20 },
          }
        ),
      /LOCK_TIMEOUT/
    );
    assert.throws(
      () =>
        appendTechDebt(
          tdFile,
          [{ id: 'P1-03', title: 'Waiter C cố ghi khi khóa bận' }],
          {
            threadKey: 'task-2-plan',
            provider: 'chatgpt',
            round: 1,
            lockOptions: { timeoutMs: 60, retryMinMs: 10, retryMaxMs: 20 },
          }
        ),
      /LOCK_TIMEOUT/
    );

    // Tệp khóa của A vẫn phải còn tồn tại khi A đang chạy
    assert.equal(fs.existsSync(lockFile), true);

    await new Promise((resolve, reject) => {
      holderProc.on('error', reject);
      holderProc.on('close', (code) => {
        if (code !== 0) reject(new Error(`Holder exited with code ${code}`));
        else resolve();
      });
    });

    // Sau khi A kết thúc: khóa được dọn sạch và dữ liệu của A nguyên vẹn
    assert.equal(fs.existsSync(lockFile), false);
    const recordsAfterHolder = parseTechDebtFile(fs.readFileSync(tdFile, 'utf8'));
    assert.equal(recordsAfterHolder.length, 1);
    assert.equal(recordsAfterHolder[0].summary, 'Ghi bởi chủ khóa A');

    // 3. Kiểm thử recoverOrphanedLock:
    // 3a. Khi PID là tiến trình đang sống (process.pid) -> từ chối thu hồi với LOCK_OWNER_ALIVE
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: process.pid, token: 'live-token', createdAt: Date.now() - 60000 }),
      'utf8'
    );
    assert.throws(() => recoverOrphanedLock(tdFile), /LOCK_OWNER_ALIVE/);
    assert.equal(fs.existsSync(lockFile), true);

    // 3b. Khi tệp khóa bị hỏng JSON -> ném CORRUPT_LOCK_PAYLOAD và không tự xóa
    fs.writeFileSync(lockFile, '{corrupt-json', 'utf8');
    assert.throws(() => recoverOrphanedLock(tdFile), /CORRUPT_LOCK_PAYLOAD/);
    assert.equal(fs.existsSync(lockFile), true);

    // 3c. Khi PID là tiến trình đã chết (999999 -> ESRCH) -> thu hồi thành công
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, token: 'dead-token-123', createdAt: Date.now() - 60000 }),
      'utf8'
    );
    const recovery = recoverOrphanedLock(tdFile);
    assert.deepEqual(recovery, {
      recovered: true,
      deadPid: 999999,
      token: 'dead-token-123',
      compromised: false,
    });
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-13 [P1-01/P1-04]: Kiểm thử tích hợp End-to-End luồng tiếp nhận báo cáo Mentor (ingestMentorTechDebtReport -> resolveTechDebt -> summarizeTechDebt)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-e2e-review-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const now = new Date('2026-11-08T00:00:00Z');

    // Vòng 1 (Plan Gate): Tiếp nhận báo cáo từ Mentor
    const round1Report = {
      p1: [
        { id: 'P1-01', title: 'Bổ sung kiểm tra đầu vào cho cấu hình khóa — Tránh giá trị âm' },
        { id: 'P1-02', title: 'Kiểm thử tranh chấp đa tiến trình — Cần dùng startup barrier' },
      ],
      p2: [
        { id: 'P2-01', title: 'Không có.' }, // Nhiễu -> tự động bị lọc bỏ
        { id: 'P2-02', title: 'Làm rõ số lượng tiến trình trong tài liệu — Ghi rõ 5 + 4 = 9' },
      ],
    };

    const addedR1 = ingestMentorTechDebtReport(
      tdFile,
      round1Report,
      { threadKey: 'task-2-plan', provider: 'chatgpt', round: 1 },
      now
    );
    assert.equal(addedR1, 3);

    // Vòng 2 (Code Review Gate): Gửi lại 1 mục trùng + 1 mục mới ở vòng 2 (tự động gắn cờ late)
    const round2Report = {
      p1: [
        { id: 'P1-01', title: 'Bổ sung kiểm tra đầu vào cho cấu hình khóa — Đã nhắc ở vòng 1' },
      ],
      p2: [
        { id: 'P2-01', title: 'Thêm chú thích JSDoc cho recoverOrphanedLock — Ghi rõ điều kiện offline' },
      ],
    };

    const addedR2 = ingestMentorTechDebtReport(
      tdFile,
      round2Report,
      { threadKey: 'task-2-review', provider: 'chatgpt', round: 2 },
      now
    );
    assert.equal(addedR2, 1);

    // Đóng 2 mục P1 đã hoàn thành
    const resolvedCount = resolveTechDebt(
      tdFile,
      [
        { taskId: 'task-2', summary: 'Bổ sung kiểm tra đầu vào cho cấu hình khóa' },
        { taskId: 'task-2', summary: 'Kiểm thử tranh chấp đa tiến trình' },
      ],
      'Đã hoàn thành trong Task 2 (withFileLock & TD-11/TD-12)',
      now
    );
    assert.equal(resolvedCount, 2);

    const stats = summarizeTechDebt(tdFile);
    assert.equal(stats.total, 4);
    assert.equal(stats.resolved, 2);
    assert.equal(stats.open, 2);
    assert.deepEqual(stats.byLevel.P1, { open: 0, resolved: 2 });
    assert.deepEqual(stats.byLevel.P2, { open: 2, resolved: 0 });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-14 [P0-01, NEW-P0-01, P1-01, P1-02, P1-03, P2-02]: Kiểm thử Fail-Closed Quarantine (AsyncFunction, Promise .catch throw, getter .then throw, Proxy getPrototypeOf throw, child process delayed Promise) và releaseLockFile retry/preservation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-quarantine-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const lockFile = `${tdFile}.lock`;

    // Kịch bản 1: AsyncFunction bị chặn ngay TRƯỚC khi lấy khóa (không tạo tệp .lock)
    let asyncRan = false;
    assert.throws(
      () =>
        withFileLock(tdFile, async () => {
          asyncRan = true;
        }),
      /ASYNC_LOCK_CALLBACK/
    );
    assert.equal(asyncRan, false);
    assert.equal(fs.existsSync(lockFile), false);

    // Kịch bản 2a: Promise có .catch bị ghi đè ném lỗi đồng bộ -> vẫn quarantineLock = true
    assert.throws(() => {
      withFileLock(tdFile, () => {
        const p = Promise.resolve('ok');
        p.catch = () => {
          throw new Error('CATCH_OVERRIDDEN_THROW');
        };
        return p;
      });
    }, /ASYNC_LOCK_CALLBACK/);
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).compromised, true);
    fs.unlinkSync(lockFile);

    // Kịch bản 2b: Object có getter .then ném lỗi đồng bộ -> vẫn quarantineLock = true
    assert.throws(() => {
      withFileLock(tdFile, () => ({
        get then() {
          throw new Error('THEN_GETTER_BOOM');
        },
      }));
    }, /ASYNC_LOCK_CALLBACK/);
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).compromised, true);
    fs.unlinkSync(lockFile);

    // Kịch bản 2c: Proxy có trap getPrototypeOf ném lỗi khi chạy instanceof Promise -> vẫn quarantineLock = true & chặn Worker B
    const basePromise = new Promise((r) => setTimeout(r, 20));
    const proxyPromise = new Proxy(basePromise, {
      getPrototypeOf() {
        throw new Error('PROTOTYPE_TRAP');
      },
    });
    assert.throws(() => {
      withFileLock(tdFile, () => proxyPromise);
    }, /ASYNC_LOCK_CALLBACK/);
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).compromised, true);
    assert.throws(
      () =>
        appendTechDebt(
          tdFile,
          [{ id: 'P1-01', title: 'Worker B bị chặn bởi khóa Proxy quarantine' }],
          { lockOptions: { timeoutMs: 30, retryMinMs: 5, retryMaxMs: 10 } }
        ),
      /LOCK_TIMEOUT/
    );
    await basePromise;
    fs.unlinkSync(lockFile);

    // Kịch bản 3: Vòng đời khóa cách ly với tiến trình con Worker A trả về Delayed Promise ([P0-01] & [NEW-P0-01])
    const quarantinedWorkerScript = path.join(tmpDir, 'quarantined_worker.mjs');
    const quarantinedSignal = path.join(tmpDir, 'quarantined.signal');
    fs.writeFileSync(
      quarantinedWorkerScript,
      `
import fs from 'node:fs';
import { withFileLock } from ${JSON.stringify(MODULE_URL)};

const [tdFile, signalFile] = process.argv.slice(2);
try {
  withFileLock(tdFile, () => {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve('done');
      }, 300);
    });
  });
} catch (err) {
  if (err && err.code === 'ASYNC_LOCK_CALLBACK') {
    fs.writeFileSync(signalFile, 'QUARANTINED', 'utf8');
  }
}
`,
      'utf8'
    );

    const childA = childProcess.spawn(
      process.execPath,
      [quarantinedWorkerScript, tdFile, quarantinedSignal],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    const waitQuarantineStart = Date.now();
    while (!fs.existsSync(quarantinedSignal)) {
      if (Date.now() - waitQuarantineStart > 5000) {
        throw new Error('Child A did not enter quarantine in time');
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    // Trong lúc tiến trình A còn sống (Promise 300ms chưa xong):
    // 1. recoverOrphanedLock bắt buộc từ chối với LOCK_OWNER_ALIVE ([NEW-P0-01])
    assert.throws(() => recoverOrphanedLock(tdFile), /LOCK_OWNER_ALIVE/);
    // 2. Worker B bắt buộc bị chặn với LOCK_TIMEOUT ([P0-01])
    assert.throws(
      () =>
        appendTechDebt(
          tdFile,
          [{ id: 'P1-01', title: 'Worker B cố ghi khi khóa đang bị cách ly' }],
          { lockOptions: { timeoutMs: 40, retryMinMs: 5, retryMaxMs: 10 } }
        ),
      /LOCK_TIMEOUT/
    );

    // Chờ tiến trình A hoàn tất và thoát hẳn
    await new Promise((resolve, reject) => {
      childA.on('error', reject);
      childA.on('close', () => resolve());
    });

    // Sau khi A đã kết thúc: recoverOrphanedLock thu hồi khóa cách ly thành công
    const rec = recoverOrphanedLock(tdFile);
    assert.equal(rec.recovered, true);
    assert.equal(rec.deadPid, childA.pid);
    assert.equal(rec.compromised, true);
    assert.equal(fs.existsSync(lockFile), false);

    // Worker B giờ có thể ghi thành công
    const addedB = appendTechDebt(
      tdFile,
      [{ id: 'P1-01', title: 'Worker B ghi thành công sau khi thu hồi khóa cách ly' }],
      { threadKey: 'task-3-plan', provider: 'chatgpt', round: 1 }
    );
    assert.equal(addedB, 1);

    // Kịch bản 4: Kiểm thử releaseLockFile retry & bảo toàn lỗi gốc ([P1-01], [P1-02], [P2-02])
    // 4a. Lỗi EPERM tạm thời 2 lần đầu, lần thứ 3 thành công -> attempts = 3
    let epermTransientCount = 0;
    const res4a = withFileLock(
      tdFile,
      () => 'SUCCESS_AFTER_TRANSIENT_EPERM',
      {
        _unlinkSync: (p) => {
          epermTransientCount += 1;
          if (epermTransientCount < 3) {
            const e = new Error('Transient EPERM on unlink');
            e.code = 'EPERM';
            throw e;
          }
          fs.unlinkSync(p);
        },
      }
    );
    assert.equal(res4a, 'SUCCESS_AFTER_TRANSIENT_EPERM');
    assert.equal(epermTransientCount, 3);
    assert.equal(fs.existsSync(lockFile), false);

    // 4b. Lỗi EPERM kéo dài cả 3 lần -> ném LOCK_RELEASE_FAILED với attempts === 3
    let epermPersistentCount = 0;
    let caught4b = null;
    try {
      withFileLock(
        tdFile,
        () => 'OK',
        {
          _unlinkSync: () => {
            epermPersistentCount += 1;
            const e = new Error('Persistent EPERM');
            e.code = 'EPERM';
            throw e;
          },
        }
      );
    } catch (err) {
      caught4b = err;
    }
    assert.ok(caught4b);
    assert.equal(caught4b.code, 'LOCK_RELEASE_FAILED');
    assert.equal(caught4b.attempts, 3);
    assert.equal(caught4b.lockPath, path.resolve(lockFile));
    assert.equal(epermPersistentCount, 3);
    fs.unlinkSync(lockFile);

    // 4c. Lỗi EIO không tạm thời -> dừng ngay ở lần 1 (attempts === 1)
    let eioCount = 0;
    let caught4c = null;
    try {
      withFileLock(
        tdFile,
        () => 'OK',
        {
          _unlinkSync: () => {
            eioCount += 1;
            const e = new Error('Hard disk I/O error');
            e.code = 'EIO';
            throw e;
          },
        }
      );
    } catch (err) {
      caught4c = err;
    }
    assert.ok(caught4c);
    assert.equal(caught4c.code, 'LOCK_RELEASE_FAILED');
    assert.equal(caught4c.attempts, 1);
    assert.equal(eioCount, 1);
    fs.unlinkSync(lockFile);

    // 4d. Callback ném lỗi đã bị Object.freeze() VÀ giải phóng khóa cũng lỗi -> bảo toàn lỗi gốc + báo qua onReleaseError
    let hookReleaseErr = null;
    let hookCallbackErr = null;
    const frozenErr = Object.freeze(new Error('FROZEN_PRIMARY_BUSINESS_ERROR'));
    let caught4d = null;
    try {
      withFileLock(
        tdFile,
        () => {
          throw frozenErr;
        },
        {
          _unlinkSync: () => {
            const e = new Error('Unlink failed while callback also failed');
            e.code = 'EIO';
            throw e;
          },
          onReleaseError: (relErr, cbErr) => {
            hookReleaseErr = relErr;
            hookCallbackErr = cbErr;
          },
        }
      );
    } catch (err) {
      caught4d = err;
    }
    assert.equal(caught4d, frozenErr);
    assert.ok(hookReleaseErr);
    assert.equal(hookReleaseErr.code, 'LOCK_RELEASE_FAILED');
    assert.equal(hookCallbackErr, frozenErr);
    fs.unlinkSync(lockFile);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-15 [P1-02 & P2-01]: Kiểm thử tiến trình con giữ khóa thực tế bị kill (SIGKILL) và khôi phục ngoại tuyến bằng recoverOrphanedLock', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-real-crash-'));
  let child = null;
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const lockFile = `${tdFile}.lock`;
    const lockedSignal = path.join(tmpDir, 'child.locked');
    const crashWorkerScript = path.join(tmpDir, 'crash_worker.mjs');

    fs.writeFileSync(
      crashWorkerScript,
      `
import fs from 'node:fs';
import { withFileLock } from ${JSON.stringify(MODULE_URL)};

const [tdFile, lockedSignal] = process.argv.slice(2);
withFileLock(tdFile, () => {
  fs.writeFileSync(lockedSignal, String(process.pid), 'utf8');
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, 30000);
});
`,
      'utf8'
    );

    child = childProcess.spawn(
      process.execPath,
      [crashWorkerScript, tdFile, lockedSignal],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    const waitStart = Date.now();
    while (!fs.existsSync(lockedSignal)) {
      if (Date.now() - waitStart > 5000) {
        throw new Error('Timeout waiting for child.locked signal');
      }
      await new Promise((r) => setTimeout(r, 15));
    }

    const childPid = child.pid;
    assert.ok(Number.isInteger(childPid) && childPid > 0);

    // Khi tiến trình con đang sống và giữ khóa -> recoverOrphanedLock phải từ chối với LOCK_OWNER_ALIVE
    assert.throws(() => recoverOrphanedLock(tdFile), /LOCK_OWNER_ALIVE/);
    assert.equal(fs.existsSync(lockFile), true);

    // Dừng cưỡng bức tiến trình con và chờ sự kiện close
    const closePromise = new Promise((resolve) => {
      child.once('close', () => resolve());
    });
    const killed = child.kill('SIGKILL');
    assert.equal(killed, true);
    await closePromise;
    child = null;

    // Chờ OS thu hồi hoàn toàn PID (ESRCH)
    const reapStart = Date.now();
    while (Date.now() - reapStart < 3000) {
      try {
        process.kill(childPid, 0);
        await new Promise((r) => setTimeout(r, 15));
      } catch (err) {
        if (err && err.code === 'ESRCH') break;
      }
    }

    // Tệp khóa mồ côi vẫn còn trên đĩa sau khi tiến trình bị kill
    assert.equal(fs.existsSync(lockFile), true);

    // Khôi phục ngoại tuyến thành công
    const rec = recoverOrphanedLock(tdFile);
    assert.equal(rec.recovered, true);
    assert.equal(rec.deadPid, childPid);
    assert.equal(fs.existsSync(lockFile), false);

    // Ghi mục mới thành công sau khi khôi phục khóa
    const added = appendTechDebt(
      tdFile,
      [{ id: 'P1-01', title: 'Ghi thành công sau khi tiến trình giữ khóa bị SIGKILL' }],
      { threadKey: 'task-3-review', provider: 'chatgpt', round: 1 }
    );
    assert.equal(added, 1);
  } finally {
    if (child && child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch (_e) {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TD-16 [P1-03 & P2-01]: Kiểm thử tranh chấp hỗn hợp appendTechDebt và resolveTechDebt chạy xen kẽ qua 2 vòng độc lập', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-interleaved-'));
  try {
    const tdFile = path.join(tmpDir, 'TECH_DEBT.md');
    const now = new Date('2026-11-08T00:00:00Z');

    // Khởi tạo trước 6 bản ghi mở độc lập (seed-1 .. seed-6)
    const seedSummaries = [1, 2, 3, 4, 5, 6].map((i) => `Bản ghi hạt giống ban đầu số ${i}`);
    const seedAdded = appendTechDebt(
      tdFile,
      seedSummaries.map((s, idx) => ({
        id: `P1-0${idx + 1}`,
        title: `${s} — Khởi tạo trước tranh chấp`,
      })),
      { threadKey: 'task-3-plan', provider: 'chatgpt', round: 1, maxItems: 10 },
      now
    );
    assert.equal(seedAdded, 6);

    const mixedWorkerScript = path.join(tmpDir, 'mixed_worker.mjs');
    fs.writeFileSync(
      mixedWorkerScript,
      `
import fs from 'node:fs';
import { appendTechDebt, resolveTechDebt } from ${JSON.stringify(MODULE_URL)};

const [mode, tdFile, barrierFile, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson);
fs.writeFileSync(barrierFile + '.ready.' + payload.slot, '1', 'utf8');

const start = Date.now();
while (!fs.existsSync(barrierFile)) {
  if (Date.now() - start > 10000) throw new Error('Barrier timeout');
}

if (mode === 'append') {
  appendTechDebt(tdFile, payload.items, {
    threadKey: 'task-3-review',
    provider: 'chatgpt',
    round: payload.round,
    lockOptions: { timeoutMs: 15000, retryMinMs: 5, retryMaxMs: 15, holdDelayMs: 20 },
  });
} else {
  resolveTechDebt(
    tdFile,
    payload.fingerprint,
    'Resolved in mixed wave ' + payload.round,
    new Date('2026-11-08T00:00:00Z'),
    { timeoutMs: 15000, retryMinMs: 5, retryMaxMs: 15, holdDelayMs: 20 }
  );
}
`,
      'utf8'
    );

    const runMixedWave = async (waveId, appendBatches, resolveFingerprints) => {
      const barrierFile = path.join(tmpDir, `barrier-wave-${waveId}.go`);
      const tasks = [];
      let slot = 0;

      for (const batch of appendBatches) {
        slot += 1;
        const currentSlot = slot;
        tasks.push(
          new Promise((resolve, reject) => {
            const p = childProcess.spawn(
              process.execPath,
              [
                mixedWorkerScript,
                'append',
                tdFile,
                barrierFile,
                JSON.stringify({ slot: currentSlot, round: waveId, items: batch }),
              ],
              { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
            );
            let stderr = '';
            p.stderr.on('data', (d) => {
              stderr += d.toString();
            });
            p.on('error', reject);
            p.on('close', (code) =>
              code === 0 ? resolve() : reject(new Error(`Append slot ${currentSlot} failed: ${stderr}`))
            );
          })
        );
      }

      for (const fp of resolveFingerprints) {
        slot += 1;
        const currentSlot = slot;
        tasks.push(
          new Promise((resolve, reject) => {
            const p = childProcess.spawn(
              process.execPath,
              [
                mixedWorkerScript,
                'resolve',
                tdFile,
                barrierFile,
                JSON.stringify({ slot: currentSlot, round: waveId, fingerprint: fp }),
              ],
              { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
            );
            let stderr = '';
            p.stderr.on('data', (d) => {
              stderr += d.toString();
            });
            p.on('error', reject);
            p.on('close', (code) =>
              code === 0 ? resolve() : reject(new Error(`Resolve slot ${currentSlot} failed: ${stderr}`))
            );
          })
        );
      }

      const waitStart = Date.now();
      while (Date.now() - waitStart < 10000) {
        let ready = 0;
        for (let s = 1; s <= slot; s += 1) {
          if (fs.existsSync(`${barrierFile}.ready.${s}`)) ready += 1;
        }
        if (ready === slot) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      fs.writeFileSync(barrierFile, 'GO', 'utf8');
      await Promise.all(tasks);
    };

    const wave1Appends = [1, 2, 3].map((w) => [
      { id: 'P1-01', title: `Bản ghi hỗn hợp Vòng A tiến trình ${w} mục 1 — Chi tiết` },
      { id: 'P2-01', title: `Bản ghi hỗn hợp Vòng A tiến trình ${w} mục 2 — Chi tiết` },
    ]);
    const wave1Resolves = [1, 2, 3].map((i) =>
      buildTechDebtFingerprint('task-3', `Bản ghi hạt giống ban đầu số ${i}`)
    );
    await runMixedWave(1, wave1Appends, wave1Resolves);

    const wave2Appends = [1, 2, 3].map((w) => [
      { id: 'P1-01', title: `Bản ghi hỗn hợp Vòng B tiến trình ${w} mục 1 — Chi tiết` },
      { id: 'P2-01', title: `Bản ghi hỗn hợp Vòng B tiến trình ${w} mục 2 — Chi tiết` },
    ]);
    const wave2Resolves = [4, 5, 6].map((i) =>
      buildTechDebtFingerprint('task-3', `Bản ghi hạt giống ban đầu số ${i}`)
    );
    await runMixedWave(2, wave2Appends, wave2Resolves);

    // Xác minh kết quả sau 2 vòng hỗn hợp (12 tiến trình chạy xen kẽ)
    const stats = summarizeTechDebt(tdFile);
    assert.equal(stats.total, 18);
    assert.equal(stats.resolved, 6);
    assert.equal(stats.open, 12);

    const allRecords = parseTechDebtFile(fs.readFileSync(tdFile, 'utf8'));
    assert.equal(allRecords.length, 18);
    const byFp = new Map(allRecords.map((r) => [r.fingerprint, r]));

    // Toàn bộ 6 bản ghi seed-1..6 phải ở trạng thái checked === true
    for (const s of seedSummaries) {
      const fp = buildTechDebtFingerprint('task-3', s);
      const rec = byFp.get(fp);
      assert.ok(rec, `Thiếu bản ghi hạt giống "${s}"`);
      assert.equal(rec.summary, s);
      assert.equal(rec.checked, true);
    }

    // Toàn bộ 12 bản ghi thêm mới ở Vòng A & Vòng B phải có mặt và ở trạng thái checked === false
    for (const waveLabel of ['A', 'B']) {
      for (let w = 1; w <= 3; w += 1) {
        for (let m = 1; m <= 2; m += 1) {
          const s = `Bản ghi hỗn hợp Vòng ${waveLabel} tiến trình ${w} mục ${m}`;
          const fp = buildTechDebtFingerprint('task-3', s);
          const rec = byFp.get(fp);
          assert.ok(rec, `Thiếu bản ghi hỗn hợp "${s}"`);
          assert.equal(rec.summary, s);
          assert.equal(rec.checked, false);
        }
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
