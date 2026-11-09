// Review Policy v2 cho ask_mentor.mjs — các hàm chính sách thuần (không điều khiển trình duyệt).
//   1. Bộ đếm vòng theo giai đoạn (stageRounds) — không bị reset bởi --new-thread.
//   2. Severity Gate — chỉ P0 mới được chặn; P1/P2 -> TECH_DEBT.md.
//   3. Quy tắc hội tụ — từ vòng 2 chỉ xác nhận lỗi cũ + NEW-P0 do bản sửa gây ra (REVIEW_LEDGER.json).
//   4. Delta Review — chỉ gửi phần thay đổi của CURRENT_PLAN.md khi tiếp tục cùng luồng.
//   5. Escalation — khối ESCALATION trong HANDOFF.md + exit code 3 khi hết vòng.
//   6. Chuẩn hóa phản hồi Gemini + chính sách 2 Mentor (ChatGPT quyết định, Gemini góp ý).
import fs from 'node:fs';
import { readJson, writeJson, writeAtomic } from './workflow_state.mjs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {
  appendTechDebt,
  filterAndRankTechDebt,
  resolveTechDebt,
  summarizeTechDebt,
  parseTechDebtFile,
  buildTechDebtFingerprint,
} from './tech_debt.mjs';

export {
  appendTechDebt,
  filterAndRankTechDebt,
  resolveTechDebt,
  summarizeTechDebt,
  parseTechDebtFile,
  buildTechDebtFingerprint,
};

export const PROVIDERS = ['chatgpt', 'gemini'];
export const ESCALATION_EXIT_CODE = 3;
export const DEFAULT_MAX_ROUNDS = Object.freeze({
  chatgpt: Object.freeze({ plan: 3, 'review-code': 2, rescue: 2 }),
  gemini: Object.freeze({ plan: 2, 'review-code': 2, rescue: 2 }),
});
export const DEFAULT_ADAPTIVE_ROUNDS = Object.freeze({
  enabled: true,
  hardCap: Object.freeze({ plan: 6, 'review-code': 4, rescue: 3 }),
  stallRounds: 2,
});
export const DEFAULT_DUAL_MENTOR_POLICY = 'chatgpt-gate';
export const DELTA_MAX_RATIO = 0.6;

/** Lỗi dừng có chủ đích để chờ người quyết định (exit code 3). */
export class EscalationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EscalationError';
    this.exitCode = ESCALATION_EXIT_CODE;
  }
}

const normalizeNewlines = (text) => String(text ?? '').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// 1. Bộ đếm vòng theo giai đoạn
// ---------------------------------------------------------------------------

/**
 * Giới hạn số vòng cho (provider, mode).
 * Chấp nhận: số (kiểu cũ, áp dụng chung) | object `{ chatgpt: { plan: 3, ... }, gemini: {...} }` | không cấu hình.
 */
export function resolveMaxRounds(configValue, provider, mode) {
  const fallback = DEFAULT_MAX_ROUNDS[provider]?.[mode] ?? 2;
  if (typeof configValue === 'number' || (typeof configValue === 'string' && configValue.trim())) {
    const n = Number(configValue);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  }
  if (configValue && typeof configValue === 'object' && !Array.isArray(configValue)) {
    const perProvider = configValue[provider];
    if (typeof perProvider === 'number' && Number.isInteger(perProvider) && perProvider > 0) {
      return perProvider;
    }
    const n = Number(perProvider?.[mode]);
    if (Number.isInteger(n) && n > 0) {
      return n;
    }
  }
  return fallback;
}

/** Chuẩn hóa `stageRounds` đọc từ SESSION_MAP.json. */
export function normalizeStageRounds(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  for (const [key, val] of Object.entries(raw)) {
    if (!key || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const entry = { updatedAt: typeof val.updatedAt === 'string' ? val.updatedAt : '' };
    for (const p of PROVIDERS) {
      const n = Number(val[p]);
      entry[p] = Number.isInteger(n) && n > 0 ? n : 0;
    }
    entry.resets = Array.isArray(val.resets)
      ? val.resets.filter((r) => r && typeof r === 'object').map((r) => ({ ...r }))
      : [];
    if (val.autoExtended && typeof val.autoExtended === 'object' && !Array.isArray(val.autoExtended)) {
      entry.autoExtended = {};
      for (const p of PROVIDERS) {
        const n = Number(val.autoExtended[p]);
        if (Number.isInteger(n) && n > 0) entry.autoExtended[p] = n;
      }
    }
    if (val.humanExtra && typeof val.humanExtra === 'object' && !Array.isArray(val.humanExtra)) {
      entry.humanExtra = {};
      for (const p of PROVIDERS) {
        const n = Number(val.humanExtra[p]);
        if (Number.isInteger(n) && n > 0) entry.humanExtra[p] = n;
      }
    }
    out[key] = entry;
  }
  return out;
}

/**
 * Di trú lần đầu: suy ra `stageRounds` từ `threads[*].rounds` (ChatGPT) và `geminiThreads[*].rounds` (Gemini).
 * Chỉ dùng các khóa giai đoạn (`task-N-plan|review|rescue`), bỏ qua khóa gương `task-N`.
 */
export function seedStageRounds(threads = {}, geminiThreads = {}) {
  const out = {};
  const stageKey = /-(plan|review|rescue)$/;
  const take = (table, provider) => {
    for (const [key, val] of Object.entries(table || {})) {
      if (!stageKey.test(key)) continue;
      const n = Number(val?.rounds);
      if (!Number.isInteger(n) || n <= 0) continue;
      out[key] = out[key] || { chatgpt: 0, gemini: 0, updatedAt: '', resets: [] };
      out[key][provider] = Math.max(out[key][provider], n);
      out[key].updatedAt = typeof val.updatedAt === 'string' ? val.updatedAt : out[key].updatedAt;
    }
  };
  take(threads, 'chatgpt');
  take(geminiThreads, 'gemini');
  return out;
}

export function getStageRounds(sessionMap, threadKey, provider) {
  const n = Number(sessionMap?.stageRounds?.[threadKey]?.[provider]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Tăng bộ đếm (mutate sessionMap) và trả về số vòng mới. Người gọi chịu trách nhiệm lưu xuống đĩa. */
export function incrementStageRound(sessionMap, threadKey, provider, now = new Date()) {
  sessionMap.stageRounds = sessionMap.stageRounds || {};
  const entry =
    sessionMap.stageRounds[threadKey] ||
    (sessionMap.stageRounds[threadKey] = { chatgpt: 0, gemini: 0, updatedAt: '', resets: [] });
  entry[provider] = (Number(entry[provider]) || 0) + 1;
  entry.updatedAt = now.toISOString();
  return entry[provider];
}

/** Đặt lại bộ đếm của một giai đoạn (chỉ dành cho người, có ghi vết `resets[]`). */
export function resetStageRounds(sessionMap, threadKey, providers = PROVIDERS, now = new Date()) {
  sessionMap.stageRounds = sessionMap.stageRounds || {};
  const entry =
    sessionMap.stageRounds[threadKey] ||
    (sessionMap.stageRounds[threadKey] = { chatgpt: 0, gemini: 0, updatedAt: '', resets: [] });
  const before = {};
  for (const p of providers) {
    before[p] = Number(entry[p]) || 0;
    entry[p] = 0;
    if (entry.autoExtended) delete entry.autoExtended[p];
    if (entry.humanExtra) delete entry.humanExtra[p];
  }
  entry.resets = Array.isArray(entry.resets) ? entry.resets : [];
  entry.resets.push({ at: now.toISOString(), by: '--reset-rounds', before });
  entry.updatedAt = now.toISOString();
  return entry;
}

/** Tổng số vòng được cộng thêm (do tự động co giãn + do người cấp qua Telegram). */
export function getBonusRounds(sessionMap, threadKey, provider) {
  const entry = sessionMap?.stageRounds?.[threadKey];
  if (!entry || typeof entry !== 'object') return 0;
  const autoExt = Number(entry?.autoExtended?.[provider]) || 0;
  const humanExt = Number(entry?.humanExtra?.[provider]) || 0;
  return Math.max(0, autoExt) + Math.max(0, humanExt);
}

/** Cấp thêm N vòng từ quyết định của người dùng (Telegram / CLI) mà không xóa lịch sử số vòng đã dùng. */
export function grantExtraRounds(
  sessionMap,
  threadKey,
  providers = PROVIDERS,
  extra = 2,
  by = 'telegram',
  now = new Date()
) {
  const add = Math.max(1, Number(extra) || 1);
  sessionMap.stageRounds = sessionMap.stageRounds || {};
  const entry =
    sessionMap.stageRounds[threadKey] ||
    (sessionMap.stageRounds[threadKey] = { chatgpt: 0, gemini: 0, updatedAt: '', resets: [] });
  entry.humanExtra = entry.humanExtra || {};
  const granted = {};
  for (const p of providers) {
    entry.humanExtra[p] = (Number(entry.humanExtra[p]) || 0) + add;
    granted[p] = entry.humanExtra[p];
  }
  entry.resets = Array.isArray(entry.resets) ? entry.resets : [];
  entry.resets.push({ at: now.toISOString(), by, extra: add, granted });
  entry.updatedAt = now.toISOString();
  return entry;
}

/** Tự động cộng thêm 1 vòng khi số lượng P0 đang giảm (hội tụ tốt) và chưa chạm trần hardCap. */
export function autoExtendStageRound(
  sessionMap,
  threadKey,
  provider,
  reason = 'P0 giảm qua các vòng',
  now = new Date()
) {
  sessionMap.stageRounds = sessionMap.stageRounds || {};
  const entry =
    sessionMap.stageRounds[threadKey] ||
    (sessionMap.stageRounds[threadKey] = { chatgpt: 0, gemini: 0, updatedAt: '', resets: [] });
  entry.autoExtended = entry.autoExtended || {};
  entry.autoExtended[provider] = (Number(entry.autoExtended[provider]) || 0) + 1;
  entry.resets = Array.isArray(entry.resets) ? entry.resets : [];
  entry.resets.push({
    at: now.toISOString(),
    by: 'adaptive-auto-extend',
    provider,
    reason,
    autoExtended: entry.autoExtended[provider],
  });
  entry.updatedAt = now.toISOString();
  return entry.autoExtended[provider];
}

/**
 * Kiểm tra ngân sách vòng cho các provider sắp gửi (đã tính cả autoExtended + humanExtra).
 * @returns {{ ok: boolean, details: Array<{ provider: string, used: number, max: number, baseMax: number, bonus: number, next: number }>, exhausted: string[] }}
 */
export function checkRoundBudget(sessionMap, threadKey, providers, maxRoundsConfig, mode) {
  const details = providers.map((provider) => {
    const used = getStageRounds(sessionMap, threadKey, provider);
    const baseMax = resolveMaxRounds(maxRoundsConfig, provider, mode);
    const bonus = getBonusRounds(sessionMap, threadKey, provider);
    const max = baseMax + bonus;
    return { provider, used, max, baseMax, bonus, next: used + 1 };
  });
  const exhausted = details.filter((d) => d.used >= d.max).map((d) => d.provider);
  return { ok: exhausted.length === 0, details, exhausted };
}

/**
 * Đánh giá hội tụ sau mỗi vòng REJECTED để quyết định:
 * - Tự động cộng thêm 1 vòng (`extended: true`) nếu P0 giảm so với vòng trước và chưa chạm `hardCap`.
 * - Báo bế tắc sớm (`stalled: true`) nếu cùng tập P0 lặp lại `stallRounds` vòng liên tiếp không giảm.
 */
export function evaluateAdaptiveRound({
  ledger,
  sessionMap,
  threadKey,
  provider,
  mode,
  maxRoundsConfig,
  adaptiveConfig = DEFAULT_ADAPTIVE_ROUNDS,
  now = new Date(),
}) {
  const cfg = {
    ...DEFAULT_ADAPTIVE_ROUNDS,
    ...(adaptiveConfig && typeof adaptiveConfig === 'object' ? adaptiveConfig : {}),
    hardCap: {
      ...DEFAULT_ADAPTIVE_ROUNDS.hardCap,
      ...(adaptiveConfig?.hardCap && typeof adaptiveConfig.hardCap === 'object'
        ? adaptiveConfig.hardCap
        : {}),
    },
  };
  const used = getStageRounds(sessionMap, threadKey, provider);
  const baseMax = resolveMaxRounds(maxRoundsConfig, provider, mode);
  const bonus = getBonusRounds(sessionMap, threadKey, provider);
  const currentMax = baseMax + bonus;
  const hardCap = Math.max(currentMax, Number(cfg.hardCap?.[mode]) || currentMax);

  if (!cfg.enabled) {
    return {
      extended: false,
      stalled: false,
      shouldEscalate: used >= currentMax,
      reason: used >= currentMax ? `Đã dùng hết ${used}/${currentMax} vòng` : '',
      used,
      max: currentMax,
      hardCap,
    };
  }

  const rounds = Array.isArray(ledger?.[threadKey]?.[provider])
    ? ledger[threadKey][provider]
    : [];
  if (rounds.length < 2) {
    return {
      extended: false,
      stalled: false,
      shouldEscalate: used >= currentMax,
      reason: used >= currentMax ? `Đã dùng hết ${used}/${currentMax} vòng` : '',
      used,
      max: currentMax,
      hardCap,
    };
  }

  const currRound = rounds[rounds.length - 1];
  const prevRound = rounds[rounds.length - 2];
  const currP0 = Array.isArray(currRound?.p0) ? currRound.p0 : [];
  const prevP0 = Array.isArray(prevRound?.p0) ? prevRound.p0 : [];

  // 1. Kiểm tra bế tắc (Stall): cùng tập ID P0 (>0) lặp lại stallRounds vòng liên tiếp
  const stallCount = Math.max(2, Number(cfg.stallRounds) || 2);
  if (rounds.length >= stallCount && currP0.length > 0) {
    const tail = rounds.slice(-stallCount);
    const sigs = tail.map((r) =>
      (Array.isArray(r?.p0) ? r.p0 : [])
        .map((i) => String(i.id || '').toUpperCase())
        .filter(Boolean)
        .sort()
        .join(',')
    );
    if (sigs[0] && sigs.every((s) => s === sigs[0])) {
      return {
        extended: false,
        stalled: true,
        shouldEscalate: true,
        reason: `Bế tắc (Stall): Cùng lỗi P0 [${sigs[0]}] lặp lại ${stallCount} vòng liên tiếp không giảm (${used}/${currentMax} vòng)`,
        used,
        max: currentMax,
        hardCap,
      };
    }
  }

  // 2. Nếu chạm ngân sách hiện tại nhưng số lượng P0 đang giảm và chưa chạm hardCap -> tự động gia hạn +1 vòng
  if (
    used >= currentMax &&
    currentMax < hardCap &&
    prevP0.length > 0 &&
    currP0.length > 0 &&
    currP0.length < prevP0.length
  ) {
    const reason = `Số lỗi P0 giảm từ ${prevP0.length} xuống ${currP0.length} — tự động cộng +1 vòng (tối đa ${hardCap})`;
    autoExtendStageRound(sessionMap, threadKey, provider, reason, now);
    const newMax = baseMax + getBonusRounds(sessionMap, threadKey, provider);
    return {
      extended: true,
      stalled: false,
      shouldEscalate: false,
      reason,
      used,
      max: newMax,
      hardCap,
    };
  }

  const exhausted = used >= currentMax;
  return {
    extended: false,
    stalled: false,
    shouldEscalate: exhausted,
    reason: exhausted
      ? `Đã dùng hết ${used}/${currentMax} vòng (trần tối đa: ${hardCap})`
      : '',
    used,
    max: currentMax,
    hardCap,
  };
}

// ---------------------------------------------------------------------------
// 2. Severity Gate
// ---------------------------------------------------------------------------

/** Khối quy tắc mức độ & định dạng bắt buộc chèn vào prompt (plan / review-code). */
export function buildSeverityRules(mode) {
  const statusLine = mode === 'review-code' ? 'CODE_STATUS' : 'STATUS';
  return [
    '--- QUY TẮC PHÂN LOẠI MỨC ĐỘ (SEVERITY GATE) ---',
    '- P0 (BLOCKING): sai chức năng, lỗ hổng bảo mật, nguy cơ mất/hỏng dữ liệu, hoặc vi phạm hợp đồng/thiết kế đã duyệt.',
    '- P1 (NON-BLOCKING): nên sửa nhưng không chặn triển khai — sẽ được ghi vào sổ nợ kỹ thuật (TECH_DEBT.md).',
    '- P2 (NON-BLOCKING): góp ý nhỏ, văn phong, tối ưu tùy chọn.',
    `- Chỉ được ghi \`${statusLine}: REJECTED\` khi có ÍT NHẤT MỘT mục P0. Nếu chỉ còn P1/P2, BẮT BUỘC ghi \`${statusLine}: APPROVED\`.`,
    '- Định dạng bắt buộc sau dòng trạng thái (giữ nguyên tiêu đề, mỗi mục một dòng, ID dạng [P0-01]):',
    '  ## BLOCKING (P0)',
    '  - [P0-01] <tiêu đề ngắn> — <lý do chặn và cách khắc phục>',
    '  (ghi "- Không có" nếu không còn P0)',
    '  ## NON-BLOCKING (P1/P2)',
    '  - [P1-01] <tiêu đề> — <gợi ý>',
    '  - [P2-01] <tiêu đề> — <gợi ý>',
    '- Mục BLOCKING (P0) chỉ liệt kê các P0 CÒN MỞ. P0 đã được giải quyết KHÔNG được liệt kê lại ở đây.',
    '--- KẾT THÚC QUY TẮC PHÂN LOẠI MỨC ĐỘ ---',
  ].join('\n');
}

const ITEM_REGEX = /^\[?\s*(NEW-)?(P[0-2])-(\d+)\s*\]?\s*[:：\-–—.)]?\s*(.*)$/i;

function stripDecorations(line) {
  return line
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
    .replace(/[*_`]+/g, '')
    .trim();
}

function classifyHeader(cleanLine) {
  const l = cleanLine.replace(/^#+\s*/, '').trim();
  if (/^NON[\s-]?BLOCKING\b/i.test(l)) return 'nonblocking';
  if (/^BLOCKING\b/i.test(l)) return 'blocking';
  if (/^(ISSUE STATUS|TRẠNG THÁI|OPEN ISSUES|ĐÁNH GIÁ|SECOND OPINION|KẾT LUẬN|TỔNG KẾT|NHẬN XÉT|GHI CHÚ)\b/i.test(l)) return 'other';
  if (/^#{1,6}\s/.test(cleanLine)) return 'other';
  return null;
}

/**
 * Phân tích báo cáo mức độ trong phản hồi Mentor.
 * Chỉ tính P0 nằm trong mục `BLOCKING (P0)` và P1/P2 trong mục `NON-BLOCKING` (tránh đếm nhầm ID được nhắc trong văn xuôi).
 * Mục `ISSUE STATUS` được đọc để lấy trạng thái RESOLVED/STILL_OPEN của các ID cũ.
 *
 * @returns {{ structured: boolean, p0: Array<{id:string,title:string,isNew:boolean}>, p1: Array<{id:string,title:string}>, p2: Array<{id:string,title:string}>, statuses: Record<string,string> }}
 */
export function parseSeverityReport(text) {
  const report = { structured: false, p0: [], p1: [], p2: [], statuses: {} };
  let section = null;
  const headers = new Set();
  for (const rawLine of normalizeNewlines(text).split('\n')) {
    const clean = stripDecorations(rawLine);
    if (!clean) continue;
    const header = classifyHeader(clean);
    if (header) {
      section = header;
      headers.add(header);
      report.structured = headers.has('blocking') && headers.has('nonblocking');
      continue;
    }
    const m = clean.match(ITEM_REGEX);
    if (!m) continue;
    const isNew = Boolean(m[1]);
    const level = m[2].toUpperCase();
    const id = `${isNew ? 'NEW-' : ''}${level}-${m[3].padStart(2, '0')}`;
    const title = (m[4] || '').trim();
    const statusMatch = title.match(/\b(RESOLVED|STILL[_\s-]?OPEN)\b/i);
    if (statusMatch) {
      report.statuses[id] = statusMatch[1].toUpperCase().replace(/[\s-]/g, '_');
    }
    if (section === 'blocking' && level === 'P0') {
      if (statusMatch && statusMatch[1].toUpperCase() === 'RESOLVED') continue;
      report.p0.push({ id, title, isNew });
    } else if (section === 'nonblocking' && (level === 'P1' || level === 'P2')) {
      report[level.toLowerCase()].push({ id, title });
    }
  }
  return report;
}

/**
 * Áp luật Severity Gate lên trạng thái Mentor trả về (fail-closed).
 * - APPROVED nhưng còn P0 -> ép REJECTED.
 * - REJECTED nhưng không có P0 -> giữ REJECTED, cảnh báo REJECT_WITHOUT_P0.
 * - Thiếu cấu trúc BLOCKING/NON-BLOCKING -> REJECTED, cảnh báo FORMAT_MISSING.
 */
export function applySeverityGate(status, report) {
  const warnings = [];
  let finalStatus = status === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  if (!report?.structured) {
    warnings.push('FORMAT_MISSING');
    return { status: 'REJECTED', warnings };
  }
  if (finalStatus === 'APPROVED' && report.p0.length > 0) {
    finalStatus = 'REJECTED';
    warnings.push('APPROVED_WITH_P0_FORCED_REJECT');
  } else if (finalStatus === 'REJECTED' && report.p0.length === 0) {
    warnings.push('REJECT_WITHOUT_P0');
  }
  return { status: finalStatus, warnings };
}

export const WARNING_TEXT = Object.freeze({
  FORMAT_MISSING:
    'Mentor không trả về mục "BLOCKING (P0)" / "NON-BLOCKING (P1/P2)" — không thể kiểm tra Severity Gate tự động.',
  APPROVED_WITH_P0_FORCED_REJECT:
    'Mentor ghi APPROVED nhưng vẫn liệt kê P0 còn mở -> script ép về REJECTED (fail-closed).',
  REJECT_WITHOUT_P0:
    'Mentor ghi REJECTED nhưng không nêu P0 nào -> giữ REJECTED, người cần xem lại phản hồi.',
  CONVERGENCE_VIOLATION:
    'Mentor nêu P0 mới không có tiền tố NEW- (vi phạm quy tắc hội tụ) -> giữ trạng thái, người cần xem lại.',
});

// Runtime tech-debt nằm cùng scripts để có thể đưa workflow vào dự án có sẵn.

// ---------------------------------------------------------------------------
// 3. Ledger & quy tắc hội tụ
// ---------------------------------------------------------------------------

export function loadLedger(filePath) {
  return readJson(filePath, { missing: {} });
}
export function saveLedger(filePath, ledger) {
  writeJson(filePath, ledger);
}

export function appendLedgerRound(ledger, threadKey, provider, entry) {
  ledger[threadKey] = ledger[threadKey] || {};
  ledger[threadKey][provider] = Array.isArray(ledger[threadKey][provider]) ? ledger[threadKey][provider] : [];
  if (entry.requestId && ledger[threadKey][provider].some((r) => r.requestId === entry.requestId)) return ledger;
  const open = getOpenIssues(ledger, threadKey, provider);
  const nextOpen = new Map(open.map((issue) => [issue.id, issue]));
  for (const [id, status] of Object.entries(entry.statuses || {})) if (status === 'RESOLVED') nextOpen.delete(id);
  for (const issue of entry.p0 || []) nextOpen.set(issue.id, issue);
  ledger[threadKey][provider].push({ ...entry, p0: [...nextOpen.values()] });
  return ledger;
}

export function getLastLedgerRound(ledger, threadKey, provider) {
  const rounds = ledger?.[threadKey]?.[provider];
  return Array.isArray(rounds) && rounds.length > 0 ? rounds[rounds.length - 1] : null;
}

/** Vòng cuối lưu toàn bộ P0 chưa được đóng rõ ràng, kể cả ID bị phản hồi mới bỏ sót. */
export function getOpenIssues(ledger, threadKey, provider) {
  const last = getLastLedgerRound(ledger, threadKey, provider);
  return last && Array.isArray(last.p0) ? last.p0 : [];
}

/** Khối "OPEN ISSUES" + quy tắc hội tụ chèn vào prompt từ vòng 2. */
export function buildConvergenceBlock(openIssues, round) {
  if (round < 2) return '';
  const list = openIssues.length > 0
    ? openIssues.map((i) => `- [${i.id}] ${i.title}`).join('\n')
    : '- (Vòng trước không còn P0 nào mở)';
  return [
    `--- OPEN ISSUES TỪ VÒNG TRƯỚC (vòng hiện tại: ${round}) ---`,
    list,
    '--- QUY TẮC HỘI TỤ (CONVERGENCE RULE) ---',
    '- Thêm mục "## ISSUE STATUS" và xác nhận TỪNG ID ở trên là `RESOLVED` hoặc `STILL_OPEN` (ví dụ: `- [P0-01] RESOLVED`).',
    '- Mục BLOCKING (P0) chỉ chứa: các ID còn `STILL_OPEN` (giữ nguyên ID) + lỗi mới do CHÍNH bản sửa gây ra.',
    '- Lỗi mới bắt buộc dùng ID `[NEW-P0-xx]` và nêu rõ "phát sinh từ thay đổi ở <mục>".',
    '- KHÔNG thêm góp ý P1/P2 mới ở vòng này (nếu có sẽ chỉ được ghi vào sổ nợ kỹ thuật).',
    '--- KẾT THÚC QUY TẮC HỘI TỤ ---',
  ].join('\n');
}

/** P0 mới (không có trong danh sách mở, không có tiền tố NEW-) ở vòng >= 2. */
export function detectConvergenceViolations(report, openIssues, round) {
  if (round < 2 || (!report?.structured && !(Array.isArray(report?.p0) && report.p0.length > 0))) return [];
  const openIds = new Set((openIssues || []).map((i) => i.id));
  const missing = (openIssues || []).filter((i) => !['RESOLVED', 'STILL_OPEN'].includes(report.statuses?.[i.id])).map((i) => ({ ...i, missingStatus: true }));
  return [...report.p0.filter((i) => !i.isNew && !openIds.has(i.id)), ...missing];
}

// ---------------------------------------------------------------------------
// 4. Delta Review
// ---------------------------------------------------------------------------

export function snapshotPath(stateDir, threadKey, provider) {
  const safeKey = String(threadKey).replace(/[^a-z0-9_-]/gi, '_');
  return path.join(stateDir, 'review_snapshots', `${safeKey}.${provider}.md`);
}

export function readSnapshot(filePath) {
  try {
    return fs.existsSync(filePath) ? normalizeNewlines(fs.readFileSync(filePath, 'utf8')) : null;
  } catch (_e) {
    return null;
  }
}

export function writeSnapshot(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeAtomic(filePath, normalizeNewlines(content));
}

export function isSameContent(a, b) {
  return normalizeNewlines(a).trim() === normalizeNewlines(b).trim();
}

/** Unified diff giữa 2 phiên bản plan (dùng `git diff --no-index`, exit 1 = có khác biệt). */
export function computeUnifiedDiff(previousText, currentText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-delta-'));
  const prev = path.join(dir, 'previous_CURRENT_PLAN.md');
  const curr = path.join(dir, 'CURRENT_PLAN.md');
  try {
    fs.writeFileSync(prev, normalizeNewlines(previousText), 'utf8');
    fs.writeFileSync(curr, normalizeNewlines(currentText), 'utf8');
    const res = childProcess.spawnSync(
      'git',
      ['diff', '--no-index', '--no-color', '-U3', '--', prev, curr],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, windowsHide: true }
    );
    if (res.error || (res.status !== 0 && res.status !== 1)) {
      return null;
    }
    // Bỏ phần header chứa đường dẫn tạm, giữ từ hunk đầu tiên
    const out = normalizeNewlines(res.stdout || '');
    const idx = out.indexOf('\n@@');
    return idx >= 0 ? out.slice(idx + 1) : out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Quyết định gửi bản plan đầy đủ hay chỉ phần thay đổi.
 * @returns {{ kind: 'full' | 'delta' | 'unchanged', reason: string }}
 */
export function decidePlanPayload({ effectiveNewThread, usedRounds, previousSnapshot, planContent, diffText }) {
  if (previousSnapshot != null && isSameContent(previousSnapshot, planContent)) {
    return { kind: 'unchanged', reason: 'CURRENT_PLAN.md không đổi so với lần gửi trước' };
  }
  if (effectiveNewThread) return { kind: 'full', reason: 'luồng mới (Mentor chưa có ngữ cảnh)' };
  if (usedRounds < 1 || previousSnapshot == null) return { kind: 'full', reason: 'chưa có bản đã gửi để so sánh' };
  if (!diffText) return { kind: 'full', reason: 'không tạo được diff' };
  if (diffText.length > DELTA_MAX_RATIO * normalizeNewlines(planContent).length) {
    return { kind: 'full', reason: `diff > ${Math.round(DELTA_MAX_RATIO * 100)}% kích thước plan` };
  }
  return { kind: 'delta', reason: 'tiếp tục cùng luồng, chỉ gửi phần thay đổi' };
}

/** Phần thân prompt cho chế độ plan (thay khối CURRENT_PLAN đầy đủ khi gửi delta). */
export function buildPlanDeltaBody(diffText, reviewResponse = '') {
  return [
    'Đây là vòng review tiếp theo trong CÙNG luồng chat. Bản CURRENT_PLAN.md đầy đủ đã được gửi ở các lượt trước;',
    'dưới đây CHỈ là phần thay đổi (unified diff) so với bản bạn đã review lần gần nhất.',
    '',
    '--- BẮT ĐẦU DIFF CURRENT_PLAN.md ---',
    diffText,
    '--- KẾT THÚC DIFF CURRENT_PLAN.md ---',
    reviewResponse
      ? `\n--- BẢNG PHẢN HỒI REVIEW CỦA WORKER (REVIEW_RESPONSE.md) ---\n${reviewResponse}\n--- KẾT THÚC BẢNG PHẢN HỒI ---`
      : '',
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// 5. Escalation
// ---------------------------------------------------------------------------

const escStart = (key) => `<!-- ESCALATION_START:${key} -->`;
const escEnd = (key) => `<!-- ESCALATION_END:${key} -->`;

export function renderEscalationBlock({
  taskId,
  threadKey,
  reason,
  budget = [],
  openIssues = {},
  lastStatus = {},
  plainSummary = '',
  now = new Date(),
}) {
  const budgetLines = budget.map((b) => `  - ${b.provider}: đã dùng ${b.used}/${b.max} vòng`);
  const issueLines = [];
  for (const [provider, list] of Object.entries(openIssues)) {
    if (!list || list.length === 0) continue;
    issueLines.push(`  - **${provider}**:`);
    for (const i of list) issueLines.push(`    - [${i.id}] ${i.title}`);
  }
  const statusLines = Object.entries(lastStatus)
    .filter(([, v]) => v)
    .map(([p, v]) => `  - ${p}: ${v}`);
  return [
    escStart(threadKey),
    `## ⚠️ ESCALATION — Cần người quyết định (\`${threadKey}\`)`,
    `- **Thời điểm**: \`${now.toISOString()}\``,
    `- **Task**: \`${taskId}\``,
    `- **Lý do**: ${reason}`,
    ...(plainSummary
      ? ['- **Tóm tắt dễ hiểu cho bạn**:', ...plainSummary.split('\n').map((l) => `  ${l}`)]
      : []),
    '- **Ngân sách vòng**:',
    ...(budgetLines.length ? budgetLines : ['  - (không có dữ liệu)']),
    '- **Trạng thái gần nhất**:',
    ...(statusLines.length ? statusLines : ['  - (chưa có)']),
    '- **P0 còn mở**:',
    ...(issueLines.length ? issueLines : ['  - (không có P0 nào được ghi nhận)']),
    '- **Lựa chọn cho người**: (1) Bấm nút quyết định trực tiếp trên Telegram (chạy `node .agents/scripts/await_decision.mjs --task ' +
      taskId +
      '`); (2) chấp nhận rủi ro và tự duyệt; (3) tách phạm vi Task; (4) chạy `node .agents/scripts/ask_mentor.mjs --reset-rounds --task <task> --mode <mode>`.',
    '- **Agent**: Chạy `node .agents/scripts/await_decision.mjs --task ' +
      taskId +
      '` để chờ quyết định từ Telegram (hoặc dừng chờ người dùng), tuyệt đối không tự mở luồng mới / không tự reset.',
    escEnd(threadKey),
  ].join('\n');
}

export function upsertEscalation(handoffText, threadKey, block) {
  const text = removeEscalation(handoffText, threadKey);
  const base = normalizeNewlines(text).replace(/\s*$/, '');
  return `${base}\n\n${block}\n`;
}

export function removeEscalation(handoffText, threadKey) {
  const text = normalizeNewlines(handoffText);
  const start = text.indexOf(escStart(threadKey));
  if (start < 0) return text;
  const endMarker = escEnd(threadKey);
  const end = text.indexOf(endMarker, start);
  if (end < 0) return text;
  const before = text.slice(0, start).replace(/\n+$/, '\n');
  const after = text.slice(end + endMarker.length).replace(/^\n+/, '\n');
  return `${before}${after}`.replace(/\n{3,}/g, '\n\n');
}

export function hasEscalation(handoffText, threadKey) {
  return normalizeNewlines(handoffText).includes(escStart(threadKey));
}

// ---------------------------------------------------------------------------
// 6. Gemini & chính sách 2 Mentor
// ---------------------------------------------------------------------------

export function resolveDualMentorPolicy(value) {
  return value === 'both-required' ? 'both-required' : DEFAULT_DUAL_MENTOR_POLICY;
}

/** Chuẩn hóa phản hồi Gemini: dòng đầu `STATUS:`/`CODE_STATUS:` + thân phản hồi (đã bỏ dòng trạng thái gốc). */
export function normalizeMentorFeedback(responseText, status, mode) {
  const label = mode === 'review-code' ? 'CODE_STATUS' : 'STATUS';
  const body = normalizeNewlines(responseText)
    .replace(/^\s*(?:CODE_)?STATUS\s*:\s*(APPROVED|REJECTED)[^\n]*\n?/i, '')
    .trim();
  return `${label}: ${status}\n\n${body}\n`;
}

/** Khối góp ý của Mentor thứ hai (Gemini) chèn vào prompt ChatGPT. */
export function buildSecondOpinionBlock(geminiResult) {
  if (!geminiResult) return '';
  if (geminiResult.unavailable) {
    return [
      '--- GÓP Ý TỪ MENTOR THỨ HAI (GEMINI) ---',
      `Gemini không phản hồi được ở vòng này (${geminiResult.error || 'không rõ lỗi'}). Hãy review độc lập như bình thường.`,
      '--- KẾT THÚC GÓP Ý TỪ MENTOR THỨ HAI ---',
    ].join('\n');
  }
  const p0 = geminiResult.report?.p0 || [];
  const p1 = [...(geminiResult.report?.p1 || []), ...(geminiResult.report?.p2 || [])];
  return [
    '--- GÓP Ý TỪ MENTOR THỨ HAI (GEMINI) — THAM KHẢO, BẠN LÀ NGƯỜI QUYẾT ĐỊNH ---',
    `Gemini đánh giá: ${geminiResult.status}.`,
    p0.length
      ? `Các P0 Gemini nêu:\n${p0.map((i) => `- [GEMINI-${i.id}] ${i.title}`).join('\n')}`
      : 'Gemini không nêu P0 nào.',
    p1.length ? `Góp ý không chặn của Gemini:\n${p1.map((i) => `- [GEMINI-${i.id}] ${i.title}`).join('\n')}` : '',
    'Yêu cầu: thêm mục "## ĐÁNH GIÁ GÓP Ý GEMINI" — với MỖI P0 của Gemini ghi `ACCEPTED` (và đưa vào BLOCKING (P0) với ID của bạn) hoặc `DISMISSED` kèm lý do ngắn.',
    '--- KẾT THÚC GÓP Ý TỪ MENTOR THỨ HAI ---',
  ].filter(Boolean).join('\n');
}

/** Mục góp ý Gemini nối vào cuối MENTOR_FEEDBACK.md / CODE_REVIEW_FEEDBACK.md (không đổi dòng STATUS). */
export function renderAdvisorySection(geminiResult, policy = DEFAULT_DUAL_MENTOR_POLICY) {
  if (!geminiResult) return '';
  const header = `## GÓP Ý TỪ GEMINI (${policy === 'chatgpt-gate' ? 'tham khảo — ChatGPT quyết định' : 'bắt buộc đồng thuận'})`;
  if (geminiResult.unavailable) {
    return `\n---\n${header}\n- Gemini không phản hồi được: ${geminiResult.error || 'không rõ lỗi'}\n`;
  }
  const p0 = geminiResult.report?.p0 || [];
  return [
    '',
    '---',
    header,
    `- Trạng thái Gemini: **${geminiResult.status}**${geminiResult.url ? ` — ${geminiResult.url}` : ''}`,
    p0.length ? `- P0 Gemini nêu:\n${p0.map((i) => `  - [${i.id}] ${i.title}`).join('\n')}` : '- Gemini không nêu P0 nào.',
    '- Chi tiết đầy đủ: `.agents/state/GEMINI_FEEDBACK.md`',
    '',
  ].join('\n');
}

/**
 * Kết hợp trạng thái 2 Mentor.
 * - `chatgpt-gate`: trạng thái cuối = ChatGPT.
 * - `both-required`: APPROVED chỉ khi cả hai APPROVED (Gemini không phản hồi được -> REJECTED).
 */
export function combineDualStatus(chatgptStatus, geminiResult, policy = DEFAULT_DUAL_MENTOR_POLICY) {
  const geminiStatus = geminiResult?.unavailable ? 'UNAVAILABLE' : geminiResult?.status || 'N/A';
  const consensus =
    geminiStatus === chatgptStatus ? 'CONSENSUS' : geminiStatus === 'UNAVAILABLE' ? 'GEMINI_UNAVAILABLE' : 'CONFLICT';
  let finalStatus = chatgptStatus;
  if (policy === 'both-required' && chatgptStatus === 'APPROVED' && geminiStatus !== 'APPROVED') {
    finalStatus = 'REJECTED';
  }
  return { finalStatus, geminiStatus, consensus };
}
