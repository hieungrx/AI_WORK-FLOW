import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_MAX_TECH_DEBT_PER_ROUND,
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
  parseTechDebtFile,
  resolveTechDebt,
  summarizeTechDebt,
} from '../src/tech_debt.mjs';

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
