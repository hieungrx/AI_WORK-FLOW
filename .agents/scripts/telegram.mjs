#!/usr/bin/env node
// Module tích hợp Telegram Bot 2 chiều cho AI-WorkFlow (không phụ thuộc thư viện ngoài).
// Hỗ trợ:
//  - Đọc/ghi cấu hình TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID từ file .env (gitignored).
//  - Gửi thông báo Escalation giải thích dễ hiểu kèm bàn phím Inline Buttons 2 chiều.
//  - Lắng nghe quyết định của người dùng (bấm nút hoặc nhắn văn bản trực tiếp) có xác thực chat_id & nonce.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  loadWorkflowConfig,
  loadStateLock,
  saveStateLock,
  computePlanHash,
  computeCodeDiffHash,
} from './verify_guard.mjs';
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

  if (token && !chatId) {
    try {
      const detected = await detectChatIdFromUpdates(token, fetchImpl);
      if (detected?.chatId) {
        chatId = detected.chatId;
        upsertEnvFile(repoRoot, { TELEGRAM_CHAT_ID: chatId });
      }
    } catch (_e) {}
  }

  const sessionData = {
    nonce,
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
    createdAt: new Date().toISOString(),
  };

  if (!token || !chatId) {
    fs.writeFileSync(sessionFile, `${JSON.stringify(sessionData, null, 2)}\n`, 'utf8');
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
    sessionData.messageId = msg?.message_id ?? null;
    fs.writeFileSync(sessionFile, `${JSON.stringify(sessionData, null, 2)}\n`, 'utf8');
    return {
      sent: true,
      nonce,
      chatId,
      messageId: sessionData.messageId,
      plainText,
    };
  } catch (err) {
    fs.writeFileSync(sessionFile, `${JSON.stringify(sessionData, null, 2)}\n`, 'utf8');
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
export function applyHumanDecisionToState({
  repoRoot = REPO_ROOT,
  session,
  action,
  choice = '',
  customInstruction = '',
  decidedBy = 'telegram',
  now = new Date(),
}) {
  const stateDir = path.join(repoRoot, '.agents', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const sessionMapPath = path.join(stateDir, 'SESSION_MAP.json');
  const handoffPath = path.join(stateDir, 'HANDOFF.md');
  const decisionPath = path.join(stateDir, 'HUMAN_DECISION.json');
  const escalationSessionPath = path.join(stateDir, 'ESCALATION_SESSION.json');
  const cfg = loadWorkflowConfig(repoRoot);

  const sessionMap = fs.existsSync(sessionMapPath)
    ? JSON.parse(fs.readFileSync(sessionMapPath, 'utf8'))
    : { projectUrl: '', threads: {}, geminiThreads: {}, stageRounds: {} };

  const taskId = session?.taskId || sessionMap.currentTask || 'task-1';
  const mode = session?.mode || 'plan';
  const threadKey =
    session?.threadKey ||
    `${taskId}-${mode === 'review-code' ? 'review' : mode}`;

  let exitCode = DECISION_EXIT_CODES.EXTEND;
  let summaryNote = '';

  if (action === 'option') {
    exitCode = DECISION_EXIT_CODES.OPTION;
    grantExtraRounds(sessionMap, threadKey, ['chatgpt', 'gemini'], 1, `${decidedBy}:option-${choice}`, now);
    summaryNote = `Người dùng chọn Phương án ${choice} qua Telegram (được cộng +1 vòng cho ${threadKey}).`;
  } else if (action === 'extend') {
    exitCode = DECISION_EXIT_CODES.EXTEND;
    grantExtraRounds(sessionMap, threadKey, ['chatgpt', 'gemini'], 2, `${decidedBy}:extend-2`, now);
    summaryNote = `Người dùng gia hạn +2 vòng review qua Telegram cho ${threadKey}.`;
  } else if (action === 'override') {
    exitCode = DECISION_EXIT_CODES.OVERRIDE;
    const isCodeReview = mode === 'review-code';
    const targetFile = path.join(
      stateDir,
      isCodeReview ? 'CODE_REVIEW_FEEDBACK.md' : 'MENTOR_FEEDBACK.md'
    );
    const statusHeader = isCodeReview ? 'CODE_STATUS: APPROVED' : 'STATUS: APPROVED';

    // Chuyển các P0 còn mở sang TECH_DEBT.md để theo dõi về sau
    const tdFile = path.join(stateDir, 'TECH_DEBT.md');
    const openIssues = session?.openIssues || {};
    for (const [provider, list] of Object.entries(openIssues)) {
      if (!Array.isArray(list) || list.length === 0) continue;
      const debtItems = list.map((item, idx) => ({
        id: `P1-9${idx + 1}`,
        title: `[HUMAN-OVERRIDE từ ${item.id}] ${item.title}`,
        late: false,
      }));
      try {
        appendTechDebt(tdFile, debtItems, { threadKey, provider, round: 99 });
      } catch (_e) {}
    }

    const lock = loadStateLock(repoRoot);
    if (isCodeReview) {
      const codeHash = computeCodeDiffHash(repoRoot, cfg.sourceDirs);
      saveStateLock({ ...lock, taskId, codeDiffHash: codeHash, updatedAt: now.toISOString() }, repoRoot);
      fs.writeFileSync(
        targetFile,
        `${statusHeader}\n\n(Được duyệt trực tiếp bởi người dùng qua Telegram — Chấp nhận rủi ro / Human Override lúc ${now.toISOString()}).\n<!-- CODE_SHA256: ${codeHash} | TASK: ${taskId} | TEST_EXIT: 0 | HUMAN_OVERRIDE: true -->\n`,
        'utf8'
      );
    } else {
      const planHash = computePlanHash(repoRoot);
      saveStateLock({ ...lock, taskId, planHash, updatedAt: now.toISOString() }, repoRoot);
      fs.writeFileSync(
        targetFile,
        `${statusHeader}\n\n(Được duyệt trực tiếp bởi người dùng qua Telegram — Chấp nhận rủi ro / Human Override lúc ${now.toISOString()}).\n<!-- PLAN_SHA256: ${planHash} | TASK: ${taskId} | HUMAN_OVERRIDE: true -->\n`,
        'utf8'
      );
    }
    summaryNote = `Người dùng chọn Chấp nhận rủi ro (Human Override -> ${statusHeader}) qua Telegram cho ${threadKey}.`;
  } else if (action === 'retarget') {
    exitCode = DECISION_EXIT_CODES.RETARGET;
    grantExtraRounds(sessionMap, threadKey, ['chatgpt', 'gemini'], 2, `${decidedBy}:retarget`, now);
    summaryNote = `Người dùng cập nhật mục tiêu/chỉ đạo mới qua Telegram cho ${threadKey}: "${customInstruction}" (được cộng +2 vòng).`;
  } else if (action === 'stop') {
    exitCode = DECISION_EXIT_CODES.STOP;
    summaryNote = `Người dùng yêu cầu DỪNG Task (${taskId}) qua Telegram.`;
  }

  fs.writeFileSync(sessionMapPath, `${JSON.stringify(sessionMap, null, 2)}\n`, 'utf8');

  // Xóa khối ESCALATION khỏi HANDOFF.md (trừ khi chọn stop) và ghi chú quyết định mới
  const rawHandoff = fs.existsSync(handoffPath) ? fs.readFileSync(handoffPath, 'utf8') : '# HANDOFF\n';
  const cleanedHandoff =
    action === 'stop' ? rawHandoff : removeEscalation(rawHandoff, threadKey);
  const decisionSection = [
    '',
    `## ✅ Quyết định từ Người dùng (${now.toISOString()})`,
    `- **Task / Giai đoạn**: \`${taskId}\` (\`${threadKey}\`)`,
    `- **Hành động**: \`${action.toUpperCase()}\`${choice ? ` (Phương án ${choice})` : ''}`,
    ...(customInstruction ? [`- **Chỉ đạo trực tiếp**: ${customInstruction}`] : []),
    `- **Ghi chú**: ${summaryNote}`,
    '',
  ].join('\n');
  fs.writeFileSync(
    handoffPath,
    `${cleanedHandoff.replace(/\s*$/, '')}\n${decisionSection}`,
    'utf8'
  );

  const decisionRecord = {
    nonce: session?.nonce || '',
    taskId,
    threadKey,
    mode,
    action,
    choice,
    customInstruction,
    exitCode,
    summaryNote,
    decidedAt: now.toISOString(),
  };
  fs.writeFileSync(decisionPath, `${JSON.stringify(decisionRecord, null, 2)}\n`, 'utf8');

  if (fs.existsSync(escalationSessionPath)) {
    try {
      const updatedSession = {
        ...session,
        status: 'RESOLVED',
        resolvedAction: action,
        resolvedAt: now.toISOString(),
      };
      fs.writeFileSync(escalationSessionPath, `${JSON.stringify(updatedSession, null, 2)}\n`, 'utf8');
    } catch (_e) {}
  }

  return decisionRecord;
}

/**
 * Lắng nghe quyết định 2 chiều từ người dùng trên Telegram cho phiên Escalation đang mở.
 */
export async function waitForTelegramDecision({
  repoRoot = REPO_ROOT,
  timeoutMs = 60 * 60 * 1000,
  pollIntervalMs = 2000,
  envOverride = null,
  fetchImpl = globalThis.fetch,
}) {
  const stateDir = path.join(repoRoot, '.agents', 'state');
  const sessionFile = path.join(stateDir, 'ESCALATION_SESSION.json');
  if (!fs.existsSync(sessionFile)) {
    throw new Error('Không tìm thấy phiên .agents/state/ESCALATION_SESSION.json đang mở.');
  }
  const session = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  const { token, chatId: envChatId } = getTelegramCredentials(repoRoot, envOverride);
  const expectedChatId = String(envChatId || session.chatId || '').trim();

  if (!token || !expectedChatId) {
    throw new Error(
      'Chưa cấu hình đầy đủ TELEGRAM_BOT_TOKEN và TELEGRAM_CHAT_ID trong .env. Hãy chạy: npm run telegram-setup'
    );
  }

  let offset = 0;
  let awaitingCustomText = false;
  const startTime = Date.now();
  const minMessageId = Number(session.messageId) || 0;

  while (Date.now() - startTime < timeoutMs) {
    const updates = await callTelegramApi(
      token,
      'getUpdates',
      {
        offset,
        limit: 20,
        timeout: 0,
        allowed_updates: ['message', 'callback_query'],
      },
      fetchImpl
    );

    if (Array.isArray(updates)) {
      for (const u of updates) {
        offset = Math.max(offset, (u.update_id || 0) + 1);

        // 1. Xử lý bấm nút Inline Keyboard
        if (u.callback_query) {
          const cb = u.callback_query;
          const fromChatId = String(cb.message?.chat?.id ?? '');
          if (fromChatId !== expectedChatId) continue;

          const data = String(cb.data || '');
          const prefix = `esc:${session.nonce}:`;
          if (!data.startsWith(prefix)) {
            await callTelegramApi(
              token,
              'answerCallbackQuery',
              {
                callback_query_id: cb.id,
                text: 'Phiên quyết định này đã cũ hoặc không còn hiệu lực.',
              },
              fetchImpl
            ).catch(() => {});
            continue;
          }

          const rawAction = data.slice(prefix.length);
          await callTelegramApi(
            token,
            'answerCallbackQuery',
            { callback_query_id: cb.id, text: 'Đã ghi nhận lựa chọn của bạn!' },
            fetchImpl
          ).catch(() => {});

          if (rawAction === 'retarget') {
            awaitingCustomText = true;
            await callTelegramApi(
              token,
              'sendMessage',
              {
                chat_id: expectedChatId,
                text: `✏️ Bạn hãy nhắn trực tiếp mục tiêu / chỉ đạo mới cho Task "${session.taskId}" vào khung chat này:`,
              },
              fetchImpl
            );
            continue;
          }

          let action = 'extend';
          let choice = '';
          if (rawAction === 'opt_a' || rawAction === 'opt_b' || rawAction === 'opt_c') {
            action = 'option';
            choice = rawAction.slice(-1).toUpperCase();
          } else if (rawAction === 'extend_2') {
            action = 'extend';
          } else if (rawAction === 'override') {
            action = 'override';
          } else if (rawAction === 'stop') {
            action = 'stop';
          }

          const record = applyHumanDecisionToState({
            repoRoot,
            session,
            action,
            choice,
            decidedBy: 'telegram',
          });

          await callTelegramApi(
            token,
            'sendMessage',
            {
              chat_id: expectedChatId,
              text: `✅ Đã thực thi quyết định: ${record.summaryNote}`,
            },
            fetchImpl
          ).catch(() => {});

          return record;
        }

        // 2. Xử lý khi người dùng nhắn tin văn bản trực tiếp (hoặc sau khi bấm "Đổi mục tiêu")
        if (u.message && typeof u.message.text === 'string') {
          const fromChatId = String(u.message.chat?.id ?? '');
          if (fromChatId !== expectedChatId) continue;
          const msgId = Number(u.message.message_id) || 0;
          if (!awaitingCustomText && minMessageId > 0 && msgId <= minMessageId) continue;
          const text = u.message.text.trim();
          if (!text || text.startsWith('/start')) continue;

          if (awaitingCustomText || text.length > 0) {
            const record = applyHumanDecisionToState({
              repoRoot,
              session,
              action: 'retarget',
              customInstruction: text,
              decidedBy: 'telegram-text',
            });
            await callTelegramApi(
              token,
              'sendMessage',
              {
                chat_id: expectedChatId,
                text: `✅ Đã nhận chỉ đạo mới của bạn cho ${session.taskId} (+2 vòng):\n"${text}"`,
              },
              fetchImpl
            ).catch(() => {});
            return record;
          }
        }
      }
    }

    if (pollIntervalMs > 0) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  return {
    nonce: session.nonce,
    taskId: session.taskId,
    threadKey: session.threadKey,
    mode: session.mode,
    action: 'timeout',
    choice: '',
    customInstruction: '',
    exitCode: DECISION_EXIT_CODES.TIMEOUT,
    summaryNote: 'Hết thời gian chờ phản hồi từ Telegram.',
    decidedAt: new Date().toISOString(),
  };
}
