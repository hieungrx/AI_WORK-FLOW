#!/usr/bin/env node
// Module tích hợp Telegram Bot 2 chiều cho AI-WorkFlow (không phụ thuộc thư viện ngoài).
// Hỗ trợ:
//  - Đọc/ghi cấu hình TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID từ file .env (gitignored).
//  - Gửi thông báo Escalation giải thích dễ hiểu kèm bàn phím Inline Buttons 2 chiều.
//  - Lắng nghe quyết định của người dùng (bấm nút hoặc nhắn văn bản trực tiếp) có xác thực chat_id & nonce.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { readJson, writeJson, withStateLock, commitStateFiles, hasPendingTransaction, acquireLease, digest } from './workflow_state.mjs';
import { captureBinding, assertBindingCurrent, collectSnapshot } from './review_artifact.mjs';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig, publishApproval } from './verify_guard.mjs';
import {
  grantExtraRounds,
  removeEscalation,
  appendTechDebt,
} from './review_policy.mjs';

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');

export const DECISION_EXIT_CODES = Object.freeze({
  OPTION: 10,     // Chọn phương án A / B / C (+1 vòng)
  EXTEND: 11,     // Gia hạn thêm +2 vòng review
  OVERRIDE: 12,   // Chấp nhận rủi ro (ép APPROVED + đẩy P0 sang TECH_DEBT.md)
  RETARGET: 13,   // Đổi mục tiêu / nhập chỉ đạo mới bằng văn bản (+2 vòng)
  STOP: 14,       // Dừng Task hiện tại
  TIMEOUT: 15,    // Hết thời gian chờ phản hồi
});

export function parseEnvContent(text) {
  const out = {};
  for (const rawLine of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadEnvFile(repoRoot = REPO_ROOT) {
  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) return {};
  try {
    return parseEnvContent(fs.readFileSync(envPath, 'utf8'));
  } catch (_e) {
    return {};
  }
}

export function upsertEnvFile(repoRoot = REPO_ROOT, updates = {}) {
  const envPath = path.join(repoRoot, '.env');
  const existingText = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8').replace(/\r\n/g, '\n')
    : '# Cấu hình Telegram Bot thông báo & quyết định 2 chiều khi Escalation\n';
  const lines = existingText.split('\n');
  const touched = new Set();

  const updatedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      touched.add(key);
      return `${key}=${updates[key] ?? ''}`;
    }
    return line;
  });

  for (const [key, val] of Object.entries(updates)) {
    if (!touched.has(key)) {
      if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1] === '') {
        updatedLines.splice(updatedLines.length - 1, 0, `${key}=${val ?? ''}`);
      } else {
        updatedLines.push(`${key}=${val ?? ''}`);
      }
    }
  }

  const finalContent = `${updatedLines.join('\n').replace(/\n+$/, '')}\n`;
  fs.writeFileSync(envPath, finalContent, 'utf8');
  return envPath;
}

export function getTelegramCredentials(repoRoot = REPO_ROOT, envOverride = null) {
  const fileEnv = loadEnvFile(repoRoot);
  const src = envOverride || process.env || {};
  const token = String(src.TELEGRAM_BOT_TOKEN || fileEnv.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(src.TELEGRAM_CHAT_ID || fileEnv.TELEGRAM_CHAT_ID || '').trim();
  return { token, chatId };
}

export async function callTelegramApi(
  token,
  method,
  payload = {},
  fetchImpl = globalThis.fetch
) {
  if (!token) {
    throw new Error('Thiếu TELEGRAM_BOT_TOKEN.');
  }
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json();
  if (!data || data.ok !== true) {
    throw new Error(
      `Telegram API ${method} lỗi: ${data?.description || res.statusText || 'Unknown error'}`
    );
  }
  return data.result;
}

export async function getBotInfo(token, fetchImpl = globalThis.fetch) {
  return callTelegramApi(token, 'getMe', {}, fetchImpl);
}

/**
 * Tự động dò `chat_id` từ các tin nhắn người dùng đã gửi cho Bot (`/start` hoặc bất kỳ tin nhắn nào).
 */
export async function detectChatIdFromUpdates(token, fetchImpl = globalThis.fetch) {
  const updates = await callTelegramApi(
    token,
    'getUpdates',
    { limit: 50, allowed_updates: ['message', 'callback_query'] },
    fetchImpl
  );
  if (!Array.isArray(updates) || updates.length === 0) {
    return null;
  }
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const u = updates[i];
    const msg = u?.message || u?.callback_query?.message;
    const from = u?.message?.from || u?.callback_query?.from;
    const chat = msg?.chat;
    if (chat && chat.id != null) {
      return {
        chatId: String(chat.id),
        username: from?.username || chat?.username || '',
        firstName: from?.first_name || chat?.first_name || '',
        lastText: u?.message?.text || '',
        lastUpdateId: u.update_id,
      };
    }
  }
  return null;
}

/**
 * Tạo bản giải thích dễ hiểu bằng tiếng Việt cho người dùng khi xảy ra Escalation.
 */
export function buildPlainEscalationSummary({
  projectName = 'AI-WORKSPACE',
  taskId = 'task-1',
  threadKey = 'task-1-plan',
  mode = 'plan',
  reason = '',
  budget = [],
  openIssues = {},
  taskTitle = '',
  mentorDigest = '',
}) {
  const modeLabel =
    mode === 'plan'
      ? 'Duyệt Kế hoạch Thiết kế (Design Gate)'
      : mode === 'review-code'
      ? 'Duyệt Mã nguồn & Kiểm thử (Code Review Gate)'
      : 'Cứu hộ Lỗi (Circuit Breaker)';

  const allP0 = [];
  for (const [provider, list] of Object.entries(openIssues || {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      allP0.push({ provider, id: item.id, title: item.title });
    }
  }

  const budgetSummary =
    Array.isArray(budget) && budget.length > 0
      ? budget
          .map(
            (b) =>
              `${b.provider.toUpperCase()}: đã thử ${b.used}/${b.max} vòng${
                b.bonus ? ` (đã gồm +${b.bonus} vòng cộng thêm)` : ''
              }`
          )
          .join(' | ')
      : 'Đã chạm giới hạn vòng lặp';

  const issueBullets =
    allP0.length > 0
      ? allP0
          .slice(0, 5)
          .map((i) => `• [${i.id}] ${i.title}`)
          .join('\n')
      : '• Mentor trả về REJECTED nhưng không liệt kê mã lỗi P0 chuẩn (cần bạn xác nhận hướng xử lý).';

  const lines = [
    `🚨 [CẦN BẠN QUYẾT ĐỊNH] — Dự án: ${projectName}`,
    `🎯 Task đang làm: ${taskId}${taskTitle ? ` — ${taskTitle}` : ''}`,
    `🧭 Giai đoạn: ${modeLabel} (${threadKey})`,
    `🔁 Tiến độ: ${budgetSummary}`,
    `⚠️ Lý do leo thang: ${reason}`,
    '',
    '🧱 Vấn đề Mentor đang yêu cầu chỉnh sửa (Blocking P0):',
    issueBullets,
  ];

  if (mentorDigest && String(mentorDigest).trim()) {
    lines.push('', '💡 Tóm tắt từ Mentor:', String(mentorDigest).trim());
  }

  lines.push(
    '',
    '👇 Bạn hãy chọn 1 nút bên dưới (hoặc nhắn tin trực tiếp mục tiêu mới vào khung chat này):',
    '• [⏩ Gia hạn +2 vòng]: Cho phép AI tự sửa tiếp thêm 2 vòng nữa.',
    '• [✅ Chấp nhận rủi ro]: Bỏ qua lỗi trên, duyệt luôn để chuyển sang bước tiếp theo (lỗi cũ được lưu vào TECH_DEBT.md).',
    '• [🅰️ / 🅱️ / 🅲]: Chỉ định phương án A/B/C và cấp thêm 1 vòng.',
    '• [🎯 Đổi mục tiêu]: Nhập hướng dẫn / yêu cầu mới bằng chữ.',
    '• [⛔ Dừng Task]: Tạm dừng để bạn kiểm tra trực tiếp trên máy.'
  );

  return lines.join('\n');
}

export function buildEscalationKeyboard(nonce) {
  return {
    inline_keyboard: [
      [
        { text: '⏩ Gia hạn +2 vòng', callback_data: `esc:${nonce}:extend_2` },
        { text: '✅ Chấp nhận rủi ro (Duyệt)', callback_data: `esc:${nonce}:override` },
      ],
      [
        { text: '🅰️ Phương án A', callback_data: `esc:${nonce}:opt_a` },
        { text: '🅱️ Phương án B', callback_data: `esc:${nonce}:opt_b` },
        { text: '🅲 Phương án C', callback_data: `esc:${nonce}:opt_c` },
      ],
      [
        { text: '🎯 Đổi mục tiêu (Nhập chữ)', callback_data: `esc:${nonce}:retarget` },
        { text: '⛔ Dừng Task', callback_data: `esc:${nonce}:stop` },
      ],
    ],
  };
}

export function findTaskTitleFromRoadmap(roadmapText, taskId) {
  const numMatch = String(taskId || '').match(/(\d+)/);
  if (!numMatch) return '';
  const num = numMatch[1];
  const regex = new RegExp(`Task\\s+${num}\\s*[:：\\-]\\s*(.+)`, 'i');
  for (const line of String(roadmapText ?? '').split(/\r?\n/)) {
    const m = line.match(regex);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

/**
 * Gửi thông báo Escalation kèm nút bấm 2 chiều qua Telegram và lưu phiên vào `.agents/state/ESCALATION_SESSION.json`.
 */
export async function sendEscalationTelegram({
  repoRoot = REPO_ROOT,
  projectName = '',
  taskId = 'task-1',
  threadKey = 'task-1-plan',
  mode = 'plan',
  reason = '',
  budget = [],
  openIssues = {},
  mentorDigest = '',
  envOverride = null,
  fetchImpl = globalThis.fetch,
}) {
  const cfg = loadWorkflowConfig(repoRoot);
  const resolvedProject = projectName || cfg.projectName || path.basename(repoRoot);
  const stateDir = path.join(repoRoot, '.agents', 'state');
  const roadmapPath = path.join(stateDir, 'ROADMAP.md');
  const roadmapText = fs.existsSync(roadmapPath) ? fs.readFileSync(roadmapPath, 'utf8') : '';
  const taskTitle = findTaskTitleFromRoadmap(roadmapText, taskId);

  const plainText = buildPlainEscalationSummary({
    projectName: resolvedProject,
    taskId,
    threadKey,
    mode,
    reason,
    budget,
    openIssues,
    taskTitle,
    mentorDigest,
  });

  const nonce = crypto.randomBytes(6).toString('hex');
  const sessionFile = path.join(stateDir, 'ESCALATION_SESSION.json');
  fs.mkdirSync(stateDir, { recursive: true });

  const { token, chatId: configuredChatId } = getTelegramCredentials(repoRoot, envOverride);
  let chatId = configuredChatId;

  // Chat identity must be configured explicitly; never infer an approver from unrelated updates.
  const binding = captureBinding(repoRoot, cfg, { taskId, mode });
  const sessionData = {
    nonce,
    schemaVersion: 2,
    binding,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    projectName: resolvedProject,
    taskId,
    threadKey,
    mode,
    reason,
    openIssues,
    plainText,
    chatId: chatId || '',
    messageId: null,
    status: 'PENDING',
    deliveryStatus: token && chatId ? 'SENDING' : 'NOT_SENT',
    createdAt: new Date().toISOString(),
  };

  // Reserve the nonce before sending. A second caller must never send another
  // approval request while this one is in flight or its delivery is uncertain.
  withStateLock(repoRoot, () => {
    if (hasPendingTransaction(repoRoot)) throw new Error('STATE_RECOVERY_REQUIRED');
    if (fs.existsSync(sessionFile) && readJson(sessionFile).status === 'PENDING') {
      throw new Error('ESCALATION_ALREADY_PENDING: resolve or explicitly stop the existing session.');
    }
    writeJson(sessionFile, sessionData);
  });
  const saveDelivery = (patch) => withStateLock(repoRoot, () => {
    if (hasPendingTransaction(repoRoot)) throw new Error('STATE_RECOVERY_REQUIRED');
    const current = readJson(sessionFile);
    if (current.nonce !== nonce || current.status !== 'PENDING') throw new Error('STALE_DECISION_SESSION');
    writeJson(sessionFile, { ...current, ...patch });
  });

  if (!token || !chatId) {
    return {
      sent: false,
      reason: !token ? 'missing_bot_token' : 'missing_chat_id',
      nonce,
      plainText,
    };
  }

  try {
    const msg = await callTelegramApi(
      token,
      'sendMessage',
      {
        chat_id: chatId,
        text: plainText,
        reply_markup: buildEscalationKeyboard(nonce),
      },
      fetchImpl
    );
    if (!Number.isSafeInteger(msg?.message_id) || msg.message_id <= 0) throw new Error('INVALID_TELEGRAM_MESSAGE_ID');
    sessionData.messageId = msg.message_id;
    saveDelivery({ messageId: sessionData.messageId, deliveryStatus: 'SENT' });
    return {
      sent: true,
      nonce,
      chatId,
      messageId: sessionData.messageId,
      plainText,
    };
  } catch (err) {
    // No automatic resend: a transport failure may happen after Telegram sent
    // the message. Keep the reservation for explicit recovery or stop.
    saveDelivery({ deliveryStatus: 'UNCERTAIN' });
    return {
      sent: false,
      reason: err.message,
      nonce,
      plainText,
    };
  }
}

/**
 * Gửi thông báo 1 chiều (khi Plan APPROVED, Code APPROVED, Rescue...) nếu được bật trong config.
 */
export async function sendWorkflowNotification({
  repoRoot = REPO_ROOT,
  eventType = 'info',
  text = '',
  envOverride = null,
  fetchImpl = globalThis.fetch,
}) {
  const cfg = loadWorkflowConfig(repoRoot);
  const enabledEvents = Array.isArray(cfg?.telegram?.notify)
    ? cfg.telegram.notify
    : ['escalation', 'plan-approved', 'code-approved', 'rescue'];
  if (!enabledEvents.includes(eventType)) {
    return { sent: false, reason: 'event_disabled' };
  }
  const { token, chatId } = getTelegramCredentials(repoRoot, envOverride);
  if (!token || !chatId) {
    return { sent: false, reason: 'missing_credentials' };
  }
  try {
    const msg = await callTelegramApi(
      token,
      'sendMessage',
      { chat_id: chatId, text },
      fetchImpl
    );
    return { sent: true, messageId: msg?.message_id ?? null };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

/**
 * Áp dụng quyết định của người dùng vào các file `.agents/state/*`.
 */
function readDecisionSession(repoRoot, expected = {}) {
  if (hasPendingTransaction(repoRoot)) throw new Error('STATE_RECOVERY_REQUIRED');
  const session = readJson(path.join(repoRoot, '.agents/state/ESCALATION_SESSION.json'));
  if (session.schemaVersion !== 2 || typeof session.nonce !== 'string' || !session.nonce ||
      typeof session.taskId !== 'string' || !session.taskId || typeof session.threadKey !== 'string' || !session.threadKey ||
      !['plan', 'review-code', 'rescue'].includes(session.mode) || !['PENDING', 'RESOLVED'].includes(session.status) ||
      session.binding?.taskId !== session.taskId || session.binding?.mode !== session.mode) {
    throw new Error('INVALID_DECISION_SESSION');
  }
  for (const key of ['nonce', 'taskId', 'threadKey', 'mode', 'chatId', 'messageId']) {
    if (expected[key] !== undefined && session[key] !== expected[key]) throw new Error('STALE_DECISION_SESSION');
  }
  return session;
}

function readResolvedDecision(repoRoot, session) {
  const record = readJson(path.join(repoRoot, '.agents/state/HUMAN_DECISION.json'));
  if (['nonce', 'taskId', 'threadKey', 'mode'].some((key) => record[key] !== session[key])) {
    throw new Error('DECISION_RECOVERY_REQUIRED');
  }
  return record;
}

function readTelegramCursor(stateDir) {
  const cursor = readJson(path.join(stateDir, 'TELEGRAM_CURSOR.json'), { missing: { offset: 0 } });
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('INVALID_TELEGRAM_CURSOR');
  return cursor.offset;
}

export function applyHumanDecisionToState({
  repoRoot = REPO_ROOT, session, action, choice = '', customInstruction = '',
  decidedBy = 'telegram', updateId = null, now = new Date(),
}) {
  return withStateLock(repoRoot, () => {
    if (hasPendingTransaction(repoRoot)) throw new Error('STATE_RECOVERY_REQUIRED');
    const stateDir = path.join(repoRoot, '.agents/state');
    if (!session?.nonce) throw new Error('STALE_DECISION_SESSION');
    const current = readDecisionSession(repoRoot, session);
    if (current.status === 'RESOLVED') return readResolvedDecision(repoRoot, current);
    if (!['option', 'extend', 'override', 'retarget', 'stop'].includes(action)) throw new Error('UNKNOWN_DECISION_ACTION');
    if (action === 'option' && !['A', 'B', 'C'].includes(choice)) throw new Error('INVALID_OPTION');
    if (action === 'retarget' && !customInstruction.trim()) throw new Error('EMPTY_RETARGET');
    const previousOffset = readTelegramCursor(stateDir);
    if (updateId !== null && (!Number.isSafeInteger(updateId) || updateId < previousOffset || updateId >= Number.MAX_SAFE_INTEGER)) {
      throw new Error('STALE_OR_INVALID_TELEGRAM_UPDATE');
    }
    const config = loadWorkflowConfig(repoRoot);
    if (action !== 'stop') {
      if (Date.parse(current.expiresAt) < now.getTime() || !Number.isFinite(Date.parse(current.expiresAt))) throw new Error('DECISION_EXPIRED');
      assertBindingCurrent(repoRoot, config, current.binding);
    }
    const sessionMap = readJson(path.join(stateDir, 'SESSION_MAP.json'));
    if (sessionMap.currentTask && sessionMap.currentTask !== current.taskId) throw new Error('DECISION_TASK_MISMATCH');
    sessionMap.currentTask = current.taskId;
    let exitCode, summaryNote;
    if (action === 'option' || action === 'extend' || action === 'retarget') {
      const amount = action === 'option' ? 1 : 2;
      grantExtraRounds(sessionMap, current.threadKey, ['chatgpt', 'gemini'], amount, decidedBy + ':' + action, now);
      exitCode = action === 'option' ? DECISION_EXIT_CODES.OPTION : action === 'extend' ? DECISION_EXIT_CODES.EXTEND : DECISION_EXIT_CODES.RETARGET;
      summaryNote = action + (choice ? ':' + choice : '') + ' (+' + amount + ' rounds)';
    } else {
      exitCode = action === 'override' ? DECISION_EXIT_CODES.OVERRIDE : DECISION_EXIT_CODES.STOP;
      summaryNote = action === 'override' ? 'Human accepted the reviewed risk for this exact artifact.' : 'Task stopped by user.';
    }
    let testSnapshot;
    if (action === 'override') {
      if (current.mode === 'review-code') {
        testSnapshot = collectSnapshot(repoRoot, config, current.taskId, current.mode);
        if (testSnapshot.positiveTestExitCode !== 0) throw new Error('OVERRIDE_REQUIRES_PASSING_TESTS');
      }
      for (const [provider, issues] of Object.entries(current.openIssues || {})) {
        for (const [i, issue] of issues.entries()) appendTechDebt(path.join(stateDir, 'TECH_DEBT.md'), [{ id: 'P1-' + String(90 + i).padStart(2, '0'), title: '[HUMAN-OVERRIDE ' + issue.id + '] ' + issue.title }], { threadKey: current.threadKey, provider, round: 99 });
      }
    }
    const record = { nonce: current.nonce, taskId: current.taskId, threadKey: current.threadKey, mode: current.mode, action, choice, customInstruction, updateId, exitCode, summaryNote, decidedAt: now.toISOString() };
    const handoffFile = path.join(stateDir, 'HANDOFF.md');
    const raw = fs.existsSync(handoffFile) ? fs.readFileSync(handoffFile, 'utf8') : '# HANDOFF\n';
    const handoff = (action === 'stop' ? raw : removeEscalation(raw, current.threadKey)).trimEnd() + '\n\n## Human decision\n- Task: ' + current.taskId + '\n- Action: ' + action + '\n- Note: ' + summaryNote + '\n' + (customInstruction ? '- Instruction: ' + customInstruction + '\n' : '');
    const writes = {
      'SESSION_MAP.json': JSON.stringify(sessionMap, null, 2) + '\n',
      'HANDOFF.md': handoff,
      'HUMAN_DECISION.json': JSON.stringify(record, null, 2) + '\n',
      'ESCALATION_SESSION.json': JSON.stringify({ ...current, status: 'RESOLVED', resolvedAction: action, resolvedAt: now.toISOString() }, null, 2) + '\n',
    };
    if (action === 'stop') {
      // STOP revokes existing authorizations in the same transaction. A new,
      // explicitly requested plan review is required before implementation.
      writes['STATE_LOCK.json'] = JSON.stringify({ schemaVersion: 2, taskId: current.taskId, plan: null, code: null, planHash: '', codeDiffHash: '', updatedAt: now.toISOString() }, null, 2) + '\n';
      writes['MENTOR_FEEDBACK.md'] = 'STATUS: PENDING\n\nSTOPPED_BY_USER: ' + current.taskId + '\n';
      writes['CODE_REVIEW_FEEDBACK.md'] = 'CODE_STATUS: PENDING\n\nSTOPPED_BY_USER: ' + current.taskId + '\n';
    }
    if (Number.isSafeInteger(updateId)) writes['TELEGRAM_CURSOR.json'] = JSON.stringify({ offset: Math.max(previousOffset, updateId + 1) }) + '\n';
    if (action === 'override') publishApproval(repoRoot, current.binding, { requestId: 'human-' + current.nonce, provider: 'human', approvedBy: decidedBy, humanOverride: true, testExitCode: testSnapshot?.positiveTestExitCode ?? null, testEvidenceHash: testSnapshot?.testEvidenceHash || '', extraWrites: writes });
    else commitStateFiles(repoRoot, writes);
    return record;
  });
}

/**
 * Lắng nghe quyết định 2 chiều từ người dùng trên Telegram cho phiên Escalation đang mở.
 */
export async function waitForTelegramDecision({
  repoRoot = REPO_ROOT, timeoutMs = 60 * 60 * 1000, pollIntervalMs = 2000,
  envOverride = null, fetchImpl = globalThis.fetch, expectedTaskId = '', expectedMode = '',
}) {
  const stateDir = path.join(repoRoot, '.agents/state');
  const sessionFile = path.join(stateDir, 'ESCALATION_SESSION.json');
  let session = readDecisionSession(repoRoot);
  if ((expectedTaskId && session.taskId !== expectedTaskId) || (expectedMode && session.mode !== expectedMode)) throw new Error('DECISION_TASK_MISMATCH');
  if (session.status === 'RESOLVED') return readResolvedDecision(repoRoot, session);
  if (!Number.isSafeInteger(session.messageId) || session.messageId <= 0) throw new Error('ESCALATION_NOT_DELIVERED');
  // Pin the session that the caller selected. Do not silently switch tasks or
  // nonces when another process replaces the session during a network await.
  const expected = Object.fromEntries(['nonce', 'taskId', 'threadKey', 'mode', 'chatId', 'messageId'].map((key) => [key, session[key]]));
  const { token, chatId } = getTelegramCredentials(repoRoot, envOverride);
  if (!token || !chatId || String(chatId) !== String(session.chatId)) throw new Error('TELEGRAM_APPROVER_NOT_CONFIGURED');
  const release = acquireLease(path.join(os.tmpdir(), 'ai-workflow-telegram-' + digest(token) + '.lock'));
  try {
    const cursorFile = path.join(stateDir, 'TELEGRAM_CURSOR.json');
    let offset = readTelegramCursor(stateDir);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      session = readDecisionSession(repoRoot, expected);
      if (session.status === 'RESOLVED') return readResolvedDecision(repoRoot, session);
      const updates = await callTelegramApi(token, 'getUpdates', { offset, limit: 20, timeout: 0, allowed_updates: ['message', 'callback_query'] }, fetchImpl);
      session = readDecisionSession(repoRoot, expected);
      if (session.status === 'RESOLVED') return readResolvedDecision(repoRoot, session);
      for (const update of Array.isArray(updates) ? updates : []) {
        session = readDecisionSession(repoRoot, expected);
        if (session.status === 'RESOLVED') return readResolvedDecision(repoRoot, session);
        if (!Number.isSafeInteger(update.update_id) || update.update_id < offset || update.update_id >= Number.MAX_SAFE_INTEGER) continue;
        let action = '', choice = '', customInstruction = '';
        const cb = update.callback_query;
        if (cb && String(cb.message?.chat?.id) === String(chatId) && Number(cb.message?.message_id) === Number(session.messageId)) {
          const data = String(cb.data || '');
          const prefix = 'esc:' + session.nonce + ':';
          if (data.startsWith(prefix)) {
            const raw = data.slice(prefix.length);
            if (/^opt_[abc]$/.test(raw)) { action = 'option'; choice = raw.slice(-1).toUpperCase(); }
            else if (raw === 'extend_2') action = 'extend';
            else if (raw === 'override' || raw === 'stop') action = raw;
            else if (raw === 'retarget') {
              withStateLock(repoRoot, () => {
                const latest = readDecisionSession(repoRoot, expected);
                if (latest.status !== 'PENDING') throw new Error('STALE_DECISION_SESSION');
                writeJson(sessionFile, { ...latest, awaitingCustomText: true });
              });
              await callTelegramApi(token, 'sendMessage', { chat_id: chatId, text: 'Chọn Trả lời (Reply) vào thông báo yêu cầu quyết định ban đầu phía trên, rồi nhập hướng dẫn mới.' }, fetchImpl);
              await callTelegramApi(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Đang chờ hướng dẫn mới.' }, fetchImpl).catch(() => {});
            }
          }
        }
        const message = update.message;
        if (message && String(message.chat?.id) === String(chatId) && typeof message.text === 'string' && message.text.trim() && !message.text.startsWith('/')) {
          // Free text must explicitly reply to this escalation; unrelated messages never retarget a task.
          if (Number(message.reply_to_message?.message_id) === Number(session.messageId) && Number(session.messageId) > 0) { action = 'retarget'; customInstruction = message.text.trim(); }
        }
        if (action) {
          const record = applyHumanDecisionToState({ repoRoot, session, action, choice, customInstruction, decidedBy: cb ? 'telegram:' + String(cb.from?.id || chatId) : 'telegram:' + String(message.from?.id || chatId), updateId: update.update_id });
          if (cb) await callTelegramApi(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Decision recorded.' }, fetchImpl).catch(() => {});
          // Local state is committed before this best-effort acknowledgement.
          await callTelegramApi(token, 'getUpdates', { offset: update.update_id + 1, limit: 1, timeout: 0 }, fetchImpl).catch(() => {});
          return record;
        }
        offset = withStateLock(repoRoot, () => {
          readDecisionSession(repoRoot, expected);
          const next = Math.max(readTelegramCursor(stateDir), update.update_id + 1);
          writeJson(cursorFile, { offset: next });
          return next;
        });
      }
      if (pollIntervalMs > 0) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return { nonce: session.nonce, taskId: session.taskId, action: 'timeout', exitCode: DECISION_EXIT_CODES.TIMEOUT, summaryNote: 'Telegram decision timeout.' };
  } finally { release(); }
}
