// Module quản lý vòng đời, lọc nhiễu và khử trùng lặp Nợ Kỹ thuật (TECH_DEBT.md).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_MAX_TECH_DEBT_PER_ROUND = 5;

export const DEFAULT_LOCK_OPTIONS = Object.freeze({
  timeoutMs: 5000,
  retryMinMs: 10,
  retryMaxMs: 30,
  holdDelayMs: 0,
});

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  const duration = Math.max(1, Math.trunc(Number(ms) || 1));
  Atomics.wait(SLEEP_BUFFER, 0, 0, duration);
}

/**
 * Kiểm tra tính hợp lệ của cấu hình khóa tệp ([P1-05]).
 *
 * @param {{ timeoutMs?: number, retryMinMs?: number, retryMaxMs?: number, holdDelayMs?: number }} [options={}]
 */
export function validateLockOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('INVALID_LOCK_OPTIONS: Tham số options phải là một object.');
  }
  const cfg = {
    timeoutMs:
      options.timeoutMs === undefined ? DEFAULT_LOCK_OPTIONS.timeoutMs : options.timeoutMs,
    retryMinMs:
      options.retryMinMs === undefined ? DEFAULT_LOCK_OPTIONS.retryMinMs : options.retryMinMs,
    retryMaxMs:
      options.retryMaxMs === undefined ? DEFAULT_LOCK_OPTIONS.retryMaxMs : options.retryMaxMs,
    holdDelayMs:
      options.holdDelayMs === undefined ? DEFAULT_LOCK_OPTIONS.holdDelayMs : options.holdDelayMs,
  };

  if (!Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs < 0 || cfg.timeoutMs > 300_000) {
    throw new Error(
      `INVALID_LOCK_OPTIONS: timeoutMs phải là số nguyên trong đoạn [0, 300000] (nhận: ${cfg.timeoutMs}).`
    );
  }
  if (!Number.isInteger(cfg.retryMinMs) || cfg.retryMinMs < 1 || cfg.retryMinMs > 10_000) {
    throw new Error(
      `INVALID_LOCK_OPTIONS: retryMinMs phải là số nguyên trong đoạn [1, 10000] (nhận: ${cfg.retryMinMs}).`
    );
  }
  if (
    !Number.isInteger(cfg.retryMaxMs) ||
    cfg.retryMaxMs < cfg.retryMinMs ||
    cfg.retryMaxMs > 10_000
  ) {
    throw new Error(
      `INVALID_LOCK_OPTIONS: retryMaxMs phải là số nguyên >= retryMinMs và <= 10000 (nhận: ${cfg.retryMaxMs}).`
    );
  }
  if (!Number.isInteger(cfg.holdDelayMs) || cfg.holdDelayMs < 0 || cfg.holdDelayMs > 60_000) {
    throw new Error(
      `INVALID_LOCK_OPTIONS: holdDelayMs phải là số nguyên trong đoạn [0, 60000] (nhận: ${cfg.holdDelayMs}).`
    );
  }
  return cfg;
}

/**
 * Thực thi hàm đồng bộ `fn()` bên trong khóa độc quyền liên tiến trình gắn với `filePath`
 * theo giao thức Strict Mutual Exclusion (Phương án A — [P0-01], [P0-02], [P0-03], [P1-01], [P1-06], [P1-07]):
 * - Tạo khóa nguyên tử qua `fs.openSync(lockPath, 'wx')` trên hệ thống tệp cục bộ (POSIX / NTFS).
 * - Không tự động cướp hoặc xóa khóa của tiến trình khác theo tuổi tệp để loại bỏ hoàn toàn TOCTOU.
 * - Chỉ retry khi gặp `EEXIST`; các lỗi quyền truy cập (`EACCES`, `EPERM`, ...) được ném ngay lập tức.
 *
 * @template T
 * @param {string} filePath
 * @param {() => T} fn
 * @param {{ timeoutMs?: number, retryMinMs?: number, retryMaxMs?: number, holdDelayMs?: number }} [options={}]
 * @returns {T}
 */
export function withFileLock(filePath, fn, options = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('INVALID_LOCK_TARGET: Đường dẫn filePath cần khóa không được rỗng.');
  }
  if (typeof fn !== 'function') {
    throw new Error('INVALID_LOCK_CALLBACK: Tham số fn phải là một hàm đồng bộ.');
  }
  const cfg = validateLockOptions(options);
  const resolvedTarget = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  const lockPath = `${resolvedTarget}.lock`;

  const startMs = Date.now();
  const deadlineMs = startMs + cfg.timeoutMs;
  const token = crypto.randomUUID();
  let acquired = false;

  while (!acquired) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
      const payload = JSON.stringify({
        pid: process.pid,
        token,
        createdAt: Date.now(),
      });
      try {
        fs.writeFileSync(fd, payload, 'utf8');
        fs.closeSync(fd);
        fd = null;
      } catch (writeErr) {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch (_closeErr) {}
          fd = null;
        }
        try {
          fs.unlinkSync(lockPath);
        } catch (_unlinkErr) {}
        throw writeErr;
      }
      acquired = true;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        const nowMs = Date.now();
        if (nowMs >= deadlineMs) {
          throw new Error(
            `LOCK_TIMEOUT: Không thể lấy khóa tệp "${lockPath}" sau ${cfg.timeoutMs}ms.`
          );
        }
        const span = cfg.retryMaxMs - cfg.retryMinMs + 1;
        const rawJitter = cfg.retryMinMs + Math.floor(Math.random() * span);
        const delayMs = Math.min(rawJitter, Math.max(1, deadlineMs - nowMs));
        sleepSync(delayMs);
        continue;
      }
      throw err;
    }
  }

  try {
    if (cfg.holdDelayMs > 0) {
      sleepSync(cfg.holdDelayMs);
    }
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch (_releaseErr) {}
  }
}

/**
 * Kiểm tra một tiến trình `pid` còn tồn tại trên hệ thống hay đã kết thúc (`ESRCH`).
 *
 * @param {number} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && err.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

/**
 * Công cụ bảo trì ngoại tuyến: thu hồi tệp `.lock` bị bỏ rơi sau khi tiến trình giữ khóa bị crash cưỡng bức.
 * - Chỉ được gọi khi toàn bộ Worker đang dừng hoạt động.
 * - Nếu payload khóa bị hỏng hoặc không có `pid` hợp lệ -> ném `CORRUPT_LOCK_PAYLOAD` (yêu cầu kiểm tra thủ công).
 * - Nếu `pid` vẫn còn sống -> ném `LOCK_OWNER_ALIVE` và giữ nguyên tệp khóa.
 *
 * @param {string} filePath
 * @returns {{ recovered: boolean, deadPid: number | null, token: string }}
 */
export function recoverOrphanedLock(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('INVALID_LOCK_TARGET: Đường dẫn filePath không được rỗng.');
  }
  const resolvedTarget = path.resolve(filePath);
  const lockPath = `${resolvedTarget}.lock`;
  if (!fs.existsSync(lockPath)) {
    return { recovered: false, deadPid: null, token: '' };
  }

  let parsed = null;
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (_err) {
    throw new Error(
      `CORRUPT_LOCK_PAYLOAD: Tệp khóa "${lockPath}" không chứa JSON hợp lệ; yêu cầu kiểm tra thủ công khi toàn bộ Worker đã dừng.`
    );
  }

  const pid = Number(parsed?.pid);
  const token = typeof parsed?.token === 'string' ? parsed.token : '';
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      `CORRUPT_LOCK_PAYLOAD: Tệp khóa "${lockPath}" không chứa PID nguyên dương hợp lệ.`
    );
  }

  if (isProcessAlive(pid)) {
    throw new Error(
      `LOCK_OWNER_ALIVE: Tiến trình giữ khóa (PID ${pid}) vẫn đang hoạt động; không được phép thu hồi khóa.`
    );
  }

  fs.unlinkSync(lockPath);
  return { recovered: true, deadPid: pid, token };
}

const normalizeNewlines = (text) => String(text ?? '').replace(/\r\n/g, '\n');

const NOISE_SUMMARY_REGEX =
  /^\s*(?:[-*+•]\s*)?(?:không có|không phát hiện|không có góp ý(?: mới)?[^—:]*|none|n\/a|trống)\.?\s*$/i;

const FINGERPRINT_FORMAT_REGEX = /^([a-z0-9_-]+)\|([0-9a-f]{64})$/i;
const SCOPED_ID_STRING_REGEX = /^([a-z0-9_-]+)\s*:\s*((?:NEW-)?P[12]-\d+)$/i;
const UNSCOPED_ID_STRING_REGEX = /^(?:NEW-)?P[12]-\d+$/i;

/**
 * Băm SHA-256 trả về chuỗi hex 64 ký tự chữ thường.
 *
 * @param {string} text
 * @returns {string}
 */
export function sha256Hex(text) {
  return crypto
    .createHash('sha256')
    .update(String(text ?? ''), 'utf8')
    .digest('hex');
}

/**
 * Làm sạch chuỗi văn bản do Mentor sinh ra để đảm bảo an toàn tuyệt đối trên 1 dòng Markdown
 * và không phá vỡ thẻ HTML comment `<!-- TD:... -->` ([P0-03]).
 *
 * @param {string} rawText
 * @returns {string}
 */
export function sanitizeSingleLineMarkdown(rawText) {
  if (typeof rawText !== 'string') return '';
  return rawText
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .replace(/\*\*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Chuẩn hóa mã định danh mục nợ kỹ thuật về dạng `P1-01` hoặc `P2-01` ([P0-03]).
 *
 * @param {string} rawId
 * @returns {string}
 */
export function sanitizeIssueId(rawId) {
  const m = String(rawId ?? '')
    .trim()
    .match(/^(?:NEW-)?(P[12])-(\d+)$/i);
  if (!m) return 'P2-00';
  return `${m[1].toUpperCase()}-${m[2].padStart(2, '0')}`;
}

/**
 * Tách chuỗi tiêu đề của Mentor thành `{ summary, detail }` theo dấu phân cách đầu tiên.
 *
 * @param {string} rawTitle
 * @returns {{ summary: string, detail: string }}
 */
export function splitIssueTitle(rawTitle) {
  const singleLine = String(rawTitle ?? '')
    .normalize('NFC')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!singleLine) {
    return { summary: '', detail: '' };
  }

  const sepMatch = singleLine.match(/\s+(?:—|–|-)\s+|:\s+/);
  if (!sepMatch || sepMatch.index === undefined) {
    return {
      summary: sanitizeSingleLineMarkdown(singleLine),
      detail: '',
    };
  }

  const rawSummary = singleLine.slice(0, sepMatch.index);
  const rawDetail = singleLine.slice(sepMatch.index + sepMatch[0].length);
  return {
    summary: sanitizeSingleLineMarkdown(rawSummary),
    detail: sanitizeSingleLineMarkdown(rawDetail),
  };
}

/**
 * Trích xuất mã `taskId` gốc từ `threadKey` (VD: `task-1-plan` -> `task-1`).
 * Chỉ giữ ký tự `[a-z0-9_-]` để chống tiêm ký tự lạ vào fingerprint.
 *
 * @param {string} threadKeyOrTaskId
 * @returns {string}
 */
export function extractTaskIdFromThreadKey(threadKeyOrTaskId) {
  const cleaned = String(threadKeyOrTaskId ?? '')
    .trim()
    .toLowerCase()
    .replace(/-(?:plan|review-code|review|rescue)$/i, '')
    .replace(/[^a-z0-9_-]/g, '');
  return cleaned || 'task-unknown';
}

/**
 * Chuẩn hóa toàn bộ chiều dài `summary` để tính danh tính ([P0-02] — KHÔNG cắt 80 ký tự).
 *
 * @param {string} summary
 * @returns {string}
 */
export function normalizeCanonicalSummary(summary) {
  return String(summary ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/<!--|-->/g, ' ')
    .replace(/[*_`[\]()~<>#"']/g, ' ')
    .replace(/[.,;:!?/\\|+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tạo fingerprint định danh duy nhất cho một vấn đề trong phạm vi một Task:
 * `${taskId}|${sha256Hex(normalizeCanonicalSummary(summary))}` ([P0-02]).
 *
 * @param {string} taskIdOrThreadKey
 * @param {string} summary
 * @returns {string}
 */
export function buildTechDebtFingerprint(taskIdOrThreadKey, summary) {
  const taskId = extractTaskIdFromThreadKey(taskIdOrThreadKey);
  const canonical = normalizeCanonicalSummary(summary);
  return `${taskId}|${sha256Hex(canonical)}`;
}

/**
 * Ghi file nguyên tử qua file tạm cùng thư mục rồi `renameSync` ([P1-03]).
 * Có retry ngắn nếu gặp lỗi khóa hệ thống tệp tạm thời trên Windows (`EPERM`, `EACCES`, `EBUSY`).
 *
 * @param {string} filePath
 * @param {string} content
 */
export function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const rand = crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}.${rand}`
  );
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      const dirErr = new Error(`EISDIR: Đích ghi "${filePath}" là một thư mục.`);
      dirErr.code = 'EISDIR';
      throw dirErr;
    }
    fs.writeFileSync(tmpPath, content, 'utf8');
    let lastRenameErr = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.renameSync(tmpPath, filePath);
        lastRenameErr = null;
        break;
      } catch (renameErr) {
        lastRenameErr = renameErr;
        const code = renameErr && renameErr.code;
        if ((code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') && attempt < 4) {
          sleepSync(15);
          continue;
        }
        throw renameErr;
      }
    }
    if (lastRenameErr) throw lastRenameErr;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.rmSync(tmpPath, { force: true });
      }
    } catch (_cleanupErr) {}
    throw err;
  }
}

/**
 * Đọc tập hợp các fingerprint đã tồn tại trong nội dung `TECH_DEBT.md`.
 * Hỗ trợ cả định dạng mới (`taskId|<64-hex>`) và định dạng legacy (`threadKey|provider|id|rawTitle`) ([P1-01]).
 *
 * @param {string} content
 * @returns {Set<string>}
 */
export function extractExistingFingerprints(content) {
  const set = new Set();
  const text = normalizeNewlines(content);
  const markerRegex = /<!--\s*TD:(.*?)\s*-->/g;
  let match;
  while ((match = markerRegex.exec(text)) !== null) {
    const rawKey = (match[1] || '').trim();
    if (!rawKey) continue;
    set.add(rawKey);
    const fpMatch = rawKey.match(FINGERPRINT_FORMAT_REGEX);
    if (fpMatch) {
      set.add(`${fpMatch[1].toLowerCase()}|${fpMatch[2].toLowerCase()}`);
      continue;
    }
    const parts = rawKey.split('|');
    if (parts.length >= 4) {
      const legacyThreadKey = parts[0];
      const legacyTitle = parts.slice(3).join('|');
      const { summary } = splitIssueTitle(legacyTitle);
      if (summary) {
        set.add(buildTechDebtFingerprint(legacyThreadKey, summary));
      }
    }
  }
  return set;
}

/**
 * Lọc nhiễu, khử trùng lặp trong cùng lô (và đối chiếu với tập fingerprint đã tồn tại nếu có),
 * sau đó mới xếp hạng ưu tiên P1 trước P2 và áp dụng giới hạn `maxItems` ([P0-01]).
 *
 * @param {Array<{ id?: string, title?: string, level?: string, late?: boolean }>} items
 * @param {{
 *   maxItems?: number,
 *   existingFingerprints?: Set<string> | Iterable<string>,
 *   taskId?: string,
 *   threadKey?: string,
 *   provider?: string
 * }} [options={}]
 */
export function filterAndRankTechDebt(items, options = {}) {
  const maxItems =
    options.maxItems === undefined ? DEFAULT_MAX_TECH_DEBT_PER_ROUND : Number(options.maxItems);
  const knownSet =
    options.existingFingerprints instanceof Set
      ? options.existingFingerprints
      : options.existingFingerprints
        ? new Set(options.existingFingerprints)
        : null;
  const scopeKey = options.taskId || options.threadKey || 'task-unknown';
  const legacyThreadKey = options.threadKey || '';
  const legacyProvider = options.provider || '';

  const stats = {
    filteredNoise: 0,
    deduplicatedInBatch: 0,
    deduplicatedExisting: 0,
    cappedByLimit: 0,
  };

  if (!Array.isArray(items) || items.length === 0) {
    return { selected: [], droppedCount: 0, stats };
  }

  const byCanonical = new Map();

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object') {
      stats.filteredNoise += 1;
      continue;
    }
    const rawTitle = String(rawItem.title ?? '').trim();
    if (!rawTitle || NOISE_SUMMARY_REGEX.test(rawTitle)) {
      stats.filteredNoise += 1;
      continue;
    }

    const { summary, detail } = splitIssueTitle(rawTitle);
    const canonical = normalizeCanonicalSummary(summary);
    if (!summary || !canonical || NOISE_SUMMARY_REGEX.test(summary)) {
      stats.filteredNoise += 1;
      continue;
    }

    const safeId = sanitizeIssueId(rawItem.id);
    const level =
      String(rawItem.level || '').toUpperCase() === 'P1' || safeId.startsWith('P1-')
        ? 'P1'
        : 'P2';

    const candidate = {
      id: safeId,
      level,
      summary,
      detail,
      title: detail ? `${summary} — ${detail}` : summary,
      rawTitle,
      late: Boolean(rawItem.late),
      canonical,
    };

    if (byCanonical.has(canonical)) {
      stats.deduplicatedInBatch += 1;
      const existing = byCanonical.get(canonical);
      if (existing.level === 'P2' && candidate.level === 'P1') {
        byCanonical.set(canonical, candidate);
      }
      continue;
    }

    byCanonical.set(canonical, candidate);
  }

  // Loại bỏ các mục đã tồn tại trong TECH_DEBT.md TRƯỚC KHI áp dụng trần maxItems ([P0-01])
  const deduplicated = [];
  for (const candidate of byCanonical.values()) {
    if (knownSet && knownSet.size > 0) {
      const fp = buildTechDebtFingerprint(scopeKey, candidate.summary);
      const legacyKey1 = `${legacyThreadKey}|${legacyProvider}|${candidate.id}|${candidate.title}`.replace(
        /-->/g,
        ''
      );
      const legacyKey2 = `${legacyThreadKey}|${legacyProvider}|${candidate.id}|${candidate.rawTitle}`.replace(
        /-->/g,
        ''
      );
      if (knownSet.has(fp) || knownSet.has(legacyKey1) || knownSet.has(legacyKey2)) {
        stats.deduplicatedExisting += 1;
        continue;
      }
    }
    deduplicated.push(candidate);
  }

  const p1List = deduplicated.filter((i) => i.level === 'P1');
  const p2List = deduplicated.filter((i) => i.level !== 'P1');
  const ranked = [...p1List, ...p2List];

  if (Number.isInteger(maxItems) && maxItems > 0 && ranked.length > maxItems) {
    stats.cappedByLimit = ranked.length - maxItems;
    const selected = ranked.slice(0, maxItems);
    return {
      selected,
      droppedCount:
        stats.filteredNoise +
        stats.deduplicatedInBatch +
        stats.deduplicatedExisting +
        stats.cappedByLimit,
      stats,
    };
  }

  return {
    selected: ranked,
    droppedCount: stats.filteredNoise + stats.deduplicatedInBatch + stats.deduplicatedExisting,
    stats,
  };
}

/**
 * Nối các mục P1/P2 vào `TECH_DEBT.md` với cơ chế khóa tệp độc quyền liên tiến trình (`withFileLock`),
 * khử trùng lặp theo fingerprint SHA-256 trước khi áp dụng giới hạn `maxItems` và ghi file nguyên tử
 * ([P0-01], [P0-02], [P0-03], [P1-01], [P1-02], [P1-03]).
 *
 * @param {string} filePath
 * @param {Array<{ id: string, title: string, late?: boolean }>} items
 * @param {{
 *   threadKey?: string,
 *   taskId?: string,
 *   provider?: string,
 *   round?: number,
 *   maxItems?: number,
 *   lockOptions?: { timeoutMs?: number, retryMinMs?: number, retryMaxMs?: number, holdDelayMs?: number }
 * }} [meta={}]
 * @param {Date} [now=new Date()]
 * @returns {number} Số lượng mục mới được ghi thêm
 */
export function appendTechDebt(filePath, items, meta = {}, now = new Date()) {
  const lockOpts = meta?.lockOptions ? validateLockOptions(meta.lockOptions) : {};
  if (!Array.isArray(items) || items.length === 0) return 0;

  return withFileLock(
    filePath,
    () => {
      const existing = fs.existsSync(filePath)
        ? normalizeNewlines(fs.readFileSync(filePath, 'utf8'))
        : '';
      const header = existing || '# TECH_DEBT — Góp ý không chặn (P1/P2) từ Mentor\n\n';
      const knownFingerprints = extractExistingFingerprints(header);

      const scopeKey = meta?.taskId || meta?.threadKey || 'task-unknown';
      const { selected } = filterAndRankTechDebt(items, {
        maxItems: meta?.maxItems ?? DEFAULT_MAX_TECH_DEBT_PER_ROUND,
        existingFingerprints: knownFingerprints,
        taskId: scopeKey,
        threadKey: meta?.threadKey || '',
        provider: meta?.provider || '',
      });
      if (selected.length === 0) return 0;

      const threadKey = sanitizeSingleLineMarkdown(
        String(meta?.threadKey || meta?.taskId || 'task-unknown')
      )
        .replace(/[()]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      const provider = sanitizeSingleLineMarkdown(String(meta?.provider || 'mentor'))
        .replace(/[()]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
      const roundNum = Number(meta?.round) || 1;
      const dateStr = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);

      const lines = [];
      for (const item of selected) {
        const fingerprint = buildTechDebtFingerprint(scopeKey, item.summary);
        if (knownFingerprints.has(fingerprint)) {
          continue;
        }

        knownFingerprints.add(fingerprint);
        const tags = [threadKey, provider, `vòng ${roundNum}`];
        if (item.late) tags.push('late');

        const bodyText = item.detail ? `${item.summary} — ${item.detail}` : item.summary;
        lines.push(
          `- [ ] **${item.id}** ${bodyText} _(${tags.join(' · ')} · ${dateStr})_ <!-- TD:${fingerprint} -->`
        );
      }

      if (lines.length === 0) return 0;

      const baseBody = header.endsWith('\n') ? header : `${header}\n`;
      writeFileAtomic(filePath, `${baseBody}${lines.join('\n')}\n`);
      return lines.length;
    },
    lockOpts
  );
}

/**
 * Tiếp nhận báo cáo phân tích mức độ của Mentor (`{ p1: [...], p2: [...] }`) và ghi nhận
 * các mục nợ kỹ thuật không chặn vào `TECH_DEBT.md` dưới sự bảo vệ của `withFileLock` ([P1-01], [P1-04]).
 *
 * @param {string} filePath
 * @param {{ p1?: Array<{ id?: string, title?: string, late?: boolean }>, p2?: Array<{ id?: string, title?: string, late?: boolean }> }} report
 * @param {{
 *   threadKey?: string,
 *   taskId?: string,
 *   provider?: string,
 *   round?: number,
 *   maxItems?: number,
 *   late?: boolean,
 *   lockOptions?: { timeoutMs?: number, retryMinMs?: number, retryMaxMs?: number, holdDelayMs?: number }
 * }} [meta={}]
 * @param {Date} [now=new Date()]
 * @returns {number}
 */
export function ingestMentorTechDebtReport(filePath, report, meta = {}, now = new Date()) {
  if (!report || typeof report !== 'object') return 0;
  const isLateRound = Boolean(meta?.late) || Number(meta?.round) > 1;
  const p1Items = Array.isArray(report.p1)
    ? report.p1.map((item) => ({
        ...item,
        level: 'P1',
        late: item?.late !== undefined ? Boolean(item.late) : isLateRound,
      }))
    : [];
  const p2Items = Array.isArray(report.p2)
    ? report.p2.map((item) => ({
        ...item,
        level: 'P2',
        late: item?.late !== undefined ? Boolean(item.late) : isLateRound,
      }))
    : [];
  const combined = [...p1Items, ...p2Items];
  if (combined.length === 0) return 0;
  return appendTechDebt(filePath, combined, meta, now);
}

/**
 * Phân tích nội dung `TECH_DEBT.md` thành danh sách các bản ghi có cấu trúc.
 * Hỗ trợ đầy đủ ký tự `()`, Markdown và ký tự đặc biệt trong `resolutionNote` ([P0-02]).
 *
 * @param {string} content
 */
export function parseTechDebtFile(content) {
  const lines = normalizeNewlines(content).split('\n');
  const records = [];
  const outerLineRegex =
    /^\s*-\s*\[([ xX])\]\s+\*\*([^*]+)\*\*\s+(.*?)\s*<!--\s*TD:(.*?)\s*-->\s*$/;
  const resolvedSuffixRegex = /^(.*\s+_\([^()]+\)_)\s+_\(Đã xử lý:\s*(.*)\)_$/;
  const bodyMetaRegex = /^(.*)\s+_\(([^()]+)\)_$/;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const outerMatch = rawLine.match(outerLineRegex);
    if (!outerMatch) continue;

    const checked = outerMatch[1].toLowerCase() === 'x';
    const id = sanitizeIssueId(outerMatch[2]);
    const level = id.startsWith('P1-') ? 'P1' : id.startsWith('P2-') ? 'P2' : 'OTHER';
    const middle = outerMatch[3].trim();
    const rawMarker = outerMatch[4].trim();

    let beforeResolution = middle;
    let resolutionNote = '';
    const resolvedMatch = middle.match(resolvedSuffixRegex);
    if (resolvedMatch) {
      beforeResolution = resolvedMatch[1];
      resolutionNote = resolvedMatch[2].trim();
    }

    const bodyMetaMatch = beforeResolution.match(bodyMetaRegex);
    if (!bodyMetaMatch) continue;

    const rawBody = bodyMetaMatch[1].trim();
    const metaText = bodyMetaMatch[2].trim();

    const { summary, detail } = splitIssueTitle(rawBody);
    const metaFirstToken = (metaText.split('·')[0] || '').trim();

    let taskId = extractTaskIdFromThreadKey(metaFirstToken);
    let fingerprint = rawMarker;

    const fpMatch = rawMarker.match(FINGERPRINT_FORMAT_REGEX);
    if (fpMatch) {
      taskId = fpMatch[1].toLowerCase();
      fingerprint = `${fpMatch[1].toLowerCase()}|${fpMatch[2].toLowerCase()}`;
    } else {
      const parts = rawMarker.split('|');
      if (parts.length >= 4) {
        taskId = extractTaskIdFromThreadKey(parts[0]);
        fingerprint = buildTechDebtFingerprint(taskId, summary);
      }
    }

    records.push({
      checked,
      id,
      level,
      taskId,
      summary,
      detail,
      metaText,
      resolutionNote,
      fingerprint,
      rawMarker,
      rawLine,
      lineIndex: i,
    });
  }

  return records;
}

/**
 * Chuẩn hóa một điều kiện truy vấn (`matcher`) cho `resolveTechDebt` ([P0-01]).
 *
 * @param {string | { fingerprint?: string, taskId?: string, id?: string, summary?: string }} matcher
 */
function normalizeMatcher(matcher) {
  if (typeof matcher === 'string') {
    const trimmed = matcher.trim();
    if (!trimmed) {
      throw new Error('INVALID_MATCHER: Matcher không được rỗng.');
    }
    const fpMatch = trimmed.match(FINGERPRINT_FORMAT_REGEX);
    if (fpMatch) {
      return {
        kind: 'fingerprint',
        fingerprint: `${fpMatch[1].toLowerCase()}|${fpMatch[2].toLowerCase()}`,
      };
    }
    if (UNSCOPED_ID_STRING_REGEX.test(trimmed)) {
      throw new Error(
        `UNSCOPED_ID_MATCHER: Khi tìm theo ID ("${trimmed}") bắt buộc phải cung cấp taskId (VD: "task-1:${trimmed}" hoặc { taskId, id }).`
      );
    }
    const scopedMatch = trimmed.match(SCOPED_ID_STRING_REGEX);
    if (scopedMatch) {
      return {
        kind: 'id',
        taskId: extractTaskIdFromThreadKey(scopedMatch[1]),
        id: sanitizeIssueId(scopedMatch[2]),
      };
    }
    return {
      kind: 'summary',
      taskId: '',
      summary: trimmed,
    };
  }

  if (matcher && typeof matcher === 'object') {
    if (typeof matcher.fingerprint === 'string' && matcher.fingerprint.trim()) {
      const fpMatch = matcher.fingerprint.trim().match(FINGERPRINT_FORMAT_REGEX);
      if (!fpMatch) {
        throw new Error(`INVALID_FINGERPRINT: Fingerprint không đúng định dạng taskId|<64-hex>: "${matcher.fingerprint}".`);
      }
      return {
        kind: 'fingerprint',
        fingerprint: `${fpMatch[1].toLowerCase()}|${fpMatch[2].toLowerCase()}`,
      };
    }
    if (typeof matcher.id === 'string' && matcher.id.trim()) {
      if (typeof matcher.taskId !== 'string' || !matcher.taskId.trim()) {
        throw new Error(
          `UNSCOPED_ID_MATCHER: Khi tìm theo ID ("${matcher.id}") bắt buộc phải cung cấp taskId.`
        );
      }
      return {
        kind: 'id',
        taskId: extractTaskIdFromThreadKey(matcher.taskId),
        id: sanitizeIssueId(matcher.id),
      };
    }
    if (typeof matcher.summary === 'string' && matcher.summary.trim()) {
      return {
        kind: 'summary',
        taskId:
          typeof matcher.taskId === 'string' && matcher.taskId.trim()
            ? extractTaskIdFromThreadKey(matcher.taskId)
            : '',
        summary: matcher.summary.trim(),
      };
    }
  }

  throw new Error('INVALID_MATCHER: Matcher phải chứa fingerprint, { taskId, id } hoặc { summary }.');
}

/**
 * Đánh dấu hoàn thành `- [x]` các mục nợ kỹ thuật theo định danh chặt chẽ dưới sự bảo vệ
 * của khóa tệp độc quyền liên tiến trình `withFileLock` ([P0-01], [P1-02]).
 * - Nếu tìm theo `id` mà thiếu `taskId` -> ném lỗi `UNSCOPED_ID_MATCHER`, không sửa file.
 * - Nếu bất kỳ matcher nào khớp `> 1` bản ghi đang mở -> ném lỗi `AMBIGUOUS_MATCH`, không sửa file.
 * - Ghi cập nhật nguyên tử qua `writeFileAtomic`.
 *
 * @param {string} filePath
 * @param {Array<string | { fingerprint?: string, taskId?: string, id?: string, summary?: string }> | string | object} matchers
 * @param {string} [resolutionNote='']
 * @param {Date} [now=new Date()]
 * @param {{ timeoutMs?: number, retryMinMs?: number, retryMaxMs?: number, holdDelayMs?: number }} [lockOptions={}]
 * @returns {number} Số bản ghi được chuyển từ `[ ]` sang `[x]`
 */
export function resolveTechDebt(
  filePath,
  matchers,
  resolutionNote = '',
  now = new Date(),
  lockOptions = {}
) {
  const lockCfg = validateLockOptions(lockOptions);
  const matcherList = Array.isArray(matchers) ? matchers : [matchers];
  if (matcherList.length === 0) return 0;

  const normalizedMatchers = matcherList.map(normalizeMatcher);

  return withFileLock(
    filePath,
    () => {
      if (!fs.existsSync(filePath)) return 0;

      const rawContent = normalizeNewlines(fs.readFileSync(filePath, 'utf8'));
      const lines = rawContent.split('\n');
      const records = parseTechDebtFile(rawContent);
      const openRecords = records.filter((r) => !r.checked);

      const lineIndicesToResolve = new Set();

      for (const m of normalizedMatchers) {
        let candidates = [];
        if (m.kind === 'fingerprint') {
          candidates = openRecords.filter(
            (r) => r.fingerprint === m.fingerprint || r.rawMarker === m.fingerprint
          );
        } else if (m.kind === 'id') {
          candidates = openRecords.filter((r) => r.taskId === m.taskId && r.id === m.id);
        } else if (m.kind === 'summary') {
          const needle = normalizeCanonicalSummary(m.summary);
          if (!needle) {
            throw new Error('INVALID_MATCHER: Summary tìm kiếm không hợp lệ.');
          }
          candidates = openRecords.filter((r) => {
            if (m.taskId && r.taskId !== m.taskId) return false;
            return normalizeCanonicalSummary(r.summary).includes(needle);
          });
        }

        if (candidates.length > 1) {
          throw new Error(
            `AMBIGUOUS_MATCH: Điều kiện (${m.kind}) khớp ${candidates.length} bản ghi đang mở. Hãy chỉ định bằng fingerprint đầy đủ.`
          );
        }

        if (candidates.length === 1) {
          lineIndicesToResolve.add(candidates[0].lineIndex);
        }
      }

      if (lineIndicesToResolve.size === 0) return 0;

      const safeNote = sanitizeSingleLineMarkdown(resolutionNote);
      const dateStr = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);

      for (const lineIdx of lineIndicesToResolve) {
        let updatedLine = lines[lineIdx].replace(/^(\s*-\s*)\[\s\]/, '$1[x]');
        if (safeNote) {
          updatedLine = updatedLine.replace(
            /(\s*<!--\s*TD:.*?-->\s*)$/,
            ` _(Đã xử lý: ${safeNote} · ${dateStr})_$1`
          );
        }
        lines[lineIdx] = updatedLine;
      }

      writeFileAtomic(filePath, lines.join('\n'));
      return lineIndicesToResolve.size;
    },
    lockCfg
  );
}

/**
 * Thống kê tổng hợp trạng thái các mục trong `TECH_DEBT.md`.
 *
 * @param {string} filePath
 */
export function summarizeTechDebt(filePath) {
  const summary = {
    total: 0,
    open: 0,
    resolved: 0,
    byLevel: {
      P1: { open: 0, resolved: 0 },
      P2: { open: 0, resolved: 0 },
    },
    byTask: {},
  };

  if (!fs.existsSync(filePath)) {
    return summary;
  }

  const content = normalizeNewlines(fs.readFileSync(filePath, 'utf8'));
  const records = parseTechDebtFile(content);

  for (const r of records) {
    summary.total += 1;
    if (r.checked) {
      summary.resolved += 1;
    } else {
      summary.open += 1;
    }

    const lvl = r.level === 'P1' ? 'P1' : 'P2';
    if (r.checked) {
      summary.byLevel[lvl].resolved += 1;
    } else {
      summary.byLevel[lvl].open += 1;
    }

    if (!summary.byTask[r.taskId]) {
      summary.byTask[r.taskId] = { open: 0, resolved: 0 };
    }
    if (r.checked) {
      summary.byTask[r.taskId].resolved += 1;
    } else {
      summary.byTask[r.taskId].open += 1;
    }
  }

  return summary;
}
