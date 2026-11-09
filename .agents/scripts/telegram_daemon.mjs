#!/usr/bin/env node
/**
 * Module Daemon Telegram 2 Chiều Thời gian thực (Real-time 24/7) cho AI_WORK-FLOW.
 * Tương thích kép:
 *  1. Chạy trực tiếp trong dự án tại `.agents/scripts/telegram_daemon.mjs` (npm run telegram-daemon)
 *  2. Chạy độc lập ngoài dự án tại `ai-telegram-hub/daemon.mjs` (quản lý qua projects.json)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const IS_INSIDE_AGENTS =
  path.basename(SCRIPT_DIR) === 'scripts' &&
  path.basename(path.dirname(SCRIPT_DIR)) === '.agents';
const DEFAULT_REPO_ROOT = IS_INSIDE_AGENTS
  ? path.resolve(SCRIPT_DIR, '..', '..')
  : 'D:\\laragon\\www\\TechPilot';
const PROJECTS_FILE = path.join(SCRIPT_DIR, 'projects.json');

function loadProjectsRegistry() {
  if (fs.existsSync(PROJECTS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    } catch (_e) {}
  }
  return {
    activeProject: path.basename(DEFAULT_REPO_ROOT),
    projects: { [path.basename(DEFAULT_REPO_ROOT)]: DEFAULT_REPO_ROOT },
  };
}

function getActiveProjectRoot() {
  const cfg = loadProjectsRegistry();
  return cfg.projects?.[cfg.activeProject] || DEFAULT_REPO_ROOT;
}

function switchActiveProject(projectName) {
  const cfg = loadProjectsRegistry();
  if (!cfg.projects || !cfg.projects[projectName]) return null;
  cfg.activeProject = projectName;
  fs.writeFileSync(PROJECTS_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return cfg.projects[projectName];
}

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function getCredentials() {
  const localEnv = parseEnvFile(path.join(SCRIPT_DIR, '.env'));
  const projEnv = parseEnvFile(path.join(getActiveProjectRoot(), '.env'));
  const fallbackEnv = parseEnvFile(path.join(DEFAULT_REPO_ROOT, '.env'));
  const token =
    process.env.TELEGRAM_BOT_TOKEN ||
    localEnv.TELEGRAM_BOT_TOKEN ||
    projEnv.TELEGRAM_BOT_TOKEN ||
    fallbackEnv.TELEGRAM_BOT_TOKEN ||
    '';
  const chatId =
    process.env.TELEGRAM_CHAT_ID ||
    localEnv.TELEGRAM_CHAT_ID ||
    projEnv.TELEGRAM_CHAT_ID ||
    fallbackEnv.TELEGRAM_CHAT_ID ||
    '';
  return { token: token.trim(), chatId: String(chatId).trim() };
}

async function tgApi(token, method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data || !data.ok) {
    throw new Error(`Telegram ${method} error: ${data?.description || res.statusText}`);
  }
  return data.result;
}

function openInAntigravityIde(projectPath) {
  const candidates = [
    path.join(
      process.env.LOCALAPPDATA || 'C:\\Users\\Admin\\AppData\\Local',
      'Programs',
      'antigravity',
      'Antigravity.exe'
    ),
    'C:\\Users\\Admin\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
  ];
  const exePath = candidates.find((p) => fs.existsSync(p)) || 'Antigravity.exe';
  try {
    const child = spawn(exePath, [projectPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch (_e) {
    return false;
  }
}

function buildQuickKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Trạng thái', callback_data: 'hub:status' },
        { text: '🗺️ Roadmap', callback_data: 'hub:roadmap' },
        { text: '🧪 Chạy Test', callback_data: 'hub:test' },
      ],
      [
        { text: '✅ Duyệt Gate (Override)', callback_data: 'hub:approve' },
        { text: '⏩ Gia hạn +2 vòng', callback_data: 'hub:extend' },
      ],
      [
        { text: '📸 Lưu Checkpoint', callback_data: 'hub:checkpoint' },
        { text: '🆕 Tạo Phiên Mới', callback_data: 'hub:newchat' },
      ],
      [
        { text: '📂 Đổi dự án', callback_data: 'hub:projects' },
        { text: '🖥️ Mở trên Antigravity IDE', callback_data: 'hub:open_ide' },
      ],
    ],
  };
}

function buildProjectsKeyboard() {
  const cfg = loadProjectsRegistry();
  const names = Object.keys(cfg.projects || {});
  const rows = [];
  for (let i = 0; i < names.length; i += 2) {
    const pair = names.slice(i, i + 2).map((name) => ({
      text: `${name === cfg.activeProject ? '✅ ' : '📁 '}${name}`,
      callback_data: `proj:${name}`,
    }));
    rows.push(pair);
  }
  rows.push([{ text: '🔙 Quay lại bảng điều khiển', callback_data: 'hub:status' }]);
  return { inline_keyboard: rows };
}

function loadProjectTestCommand(repoRoot) {
  const cfgPath = path.join(repoRoot, '.agents', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (cfg.testCommand) return cfg.testCommand;
    } catch (_e) {}
  }
  return 'npm test';
}

function readProjectSummary(repoRoot) {
  const stateDir = path.join(repoRoot, '.agents', 'state');
  const roadmapPath = path.join(stateDir, 'ROADMAP.md');
  const mentorPath = path.join(stateDir, 'MENTOR_FEEDBACK.md');
  const codeReviewPath = path.join(stateDir, 'CODE_REVIEW_FEEDBACK.md');
  const sessionPath = path.join(stateDir, 'SESSION_MAP.json');
  const inboxPath = path.join(stateDir, 'TELEGRAM_INBOX.json');

  const roadmap = fs.existsSync(roadmapPath) ? fs.readFileSync(roadmapPath, 'utf8') : '';
  const mentor = fs.existsSync(mentorPath) ? fs.readFileSync(mentorPath, 'utf8') : '';
  const codeRev = fs.existsSync(codeReviewPath) ? fs.readFileSync(codeReviewPath, 'utf8') : '';
  const sessionMap = fs.existsSync(sessionPath) ? JSON.parse(fs.readFileSync(sessionPath, 'utf8')) : {};
  const inbox = fs.existsSync(inboxPath) ? JSON.parse(fs.readFileSync(inboxPath, 'utf8')) : [];

  const tasks = [];
  let activeTask = null;
  for (const line of roadmap.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*\*\*(Task\s+\d+[^*]*)\*\*\s*[:：-]?\s*(.*)/);
    if (m) {
      const done = m[1].toLowerCase() === 'x';
      const title = m[2].trim();
      const desc = m[3].replace(/\[WORKER_MODEL:[^\]]+\]/gi, '').trim();
      tasks.push({ done, title, desc });
      if (!done && !activeTask) {
        activeTask = { title, desc };
      }
    }
  }

  const planStatusMatch = mentor.match(/STATUS:\s*(APPROVED|REJECTED|PENDING)/i);
  const codeStatusMatch = codeRev.match(/CODE_STATUS:\s*(APPROVED|REJECTED|PENDING)/i);

  return {
    projectName: path.basename(repoRoot),
    tasks,
    doneCount: tasks.filter((t) => t.done).length,
    totalCount: tasks.length,
    activeTask,
    planStatus: planStatusMatch ? planStatusMatch[1].toUpperCase() : 'UNKNOWN',
    codeStatus: codeStatusMatch ? codeStatusMatch[1].toUpperCase() : 'PENDING',
    currentTaskKey: sessionMap.currentTask || 'task-1',
    inboxCount: Array.isArray(inbox) ? inbox.filter((i) => !i.processed).length : 0,
  };
}

function formatStatusReport(repoRoot) {
  const s = readProjectSummary(repoRoot);
  const lines = [
    `⚡ [TRẠNG THÁI DỰ ÁN: ${s.projectName.toUpperCase()}]`,
    `⏱️ Cập nhật lúc: ${new Date().toLocaleTimeString('vi-VN')} (${new Date().toLocaleDateString('vi-VN')})`,
    '',
    `📈 Tiến độ tổng thể: Hoàn thành ${s.doneCount}/${s.totalCount} Task`,
    `🎯 Task đang thực hiện: ${
      s.activeTask ? `${s.activeTask.title} — ${s.activeTask.desc}` : 'Đã hoàn thành toàn bộ!'
    }`,
    `🛡️ Chốt duyệt Kế hoạch (Plan Gate): ${
      s.planStatus === 'APPROVED' ? '✅ APPROVED' : `⏳ ${s.planStatus}`
    }`,
    `🔍 Chốt duyệt Code (Code Gate): ${
      s.codeStatus === 'APPROVED' ? '✅ APPROVED' : `⏳ ${s.codeStatus}`
    }`,
    `📥 Lệnh chờ trong Inbox: ${s.inboxCount} tin nhắn`,
    '',
    '💡 Bạn có thể bấm nút bên dưới hoặc nhắn tin/gửi voice bất kỳ lúc nào, hệ thống phản hồi tức thì (< 0.5s)!',
  ];
  return lines.join('\n');
}

function formatRoadmapReport(repoRoot) {
  const s = readProjectSummary(repoRoot);
  const lines = [
    `🗺️ [LỘ TRÌNH ROADMAP — ${s.projectName.toUpperCase()}]`,
    `Tiến độ: ${s.doneCount}/${s.totalCount} Task hoàn tất`,
    '',
  ];
  for (const t of s.tasks) {
    lines.push(`${t.done ? '✅' : '⏳'} ${t.title}: ${t.desc}`);
  }
  return lines.join('\n');
}

function appendToInbox(repoRoot, item) {
  const entry = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    processed: false,
    project: path.basename(repoRoot),
    projectRoot: repoRoot,
    ...item,
  };
  const targets = [repoRoot];
  if (path.resolve(repoRoot) !== path.resolve(DEFAULT_REPO_ROOT)) {
    targets.push(DEFAULT_REPO_ROOT);
  }
  for (const targetRoot of targets) {
    const stateDir = path.join(targetRoot, '.agents', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const inboxPath = path.join(stateDir, 'TELEGRAM_INBOX.json');
    let list = [];
    if (fs.existsSync(inboxPath)) {
      try {
        list = JSON.parse(fs.readFileSync(inboxPath, 'utf8'));
      } catch (_e) {
        list = [];
      }
    }
    list.push(entry);
    fs.writeFileSync(inboxPath, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  }
  return entry;
}

async function executeProjectAction(repoRoot, action, choice = '', customInstruction = '') {
  const tgModulePath = pathToFileURL(path.join(repoRoot, '.agents', 'scripts', 'telegram.mjs')).href;
  const tgModule = await import(tgModulePath);
  const stateDir = path.join(repoRoot, '.agents', 'state');
  const escPath = path.join(stateDir, 'ESCALATION_SESSION.json');
  const session = fs.existsSync(escPath)
    ? JSON.parse(fs.readFileSync(escPath, 'utf8'))
    : {
        nonce: 'hub-direct',
        taskId: 'task-2',
        threadKey: 'task-2-plan',
        mode: 'plan',
      };
  return tgModule.applyHumanDecisionToState({
    repoRoot,
    session,
    action,
    choice,
    customInstruction,
    decidedBy: 'telegram-daemon',
  });
}

async function runProjectTestsLive(token, chatId, repoRoot) {
  const testCmd = loadProjectTestCommand(repoRoot);
  const sent = await tgApi(token, 'sendMessage', {
    chat_id: chatId,
    text: `🧪 Đang khởi chạy bộ kiểm thử tự động (\`${testCmd}\`) trên dự án ${path.basename(
      repoRoot
    )}... Vui lòng đợi vài giây ⏳`,
  });

  const startTime = Date.now();
  const child = spawn(testCmd, [], {
    cwd: repoRoot,
    shell: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  child.on('close', async (code) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const passMatches = stdout.match(/\[PASS\]/g) || [];
    const failMatches = stdout.match(/\[FAIL\]/g) || [];
    const summaryLine = stdout
      .split(/\r?\n/)
      .filter((l) => l.includes('PASS') || l.includes('FAIL') || l.includes('Result'))
      .slice(-4)
      .join('\n');

    const resultText = [
      code === 0 ? '✅ [KIỂM THỬ THÀNH CÔNG — PASS]' : '❌ [KIỂM THỬ CÓ LỖI — FAIL]',
      `⏱️ Thời gian chạy: ${elapsed}s | Mã thoát: ${code}`,
      passMatches.length || failMatches.length
        ? `📊 Thống kê: ${passMatches.length} PASS / ${failMatches.length} FAIL`
        : '',
      summaryLine ? `\n📝 Kết quả cuối:\n${summaryLine}` : '',
      stderr ? `\n⚠️ Cảnh báo:\n${stderr.slice(0, 300)}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await tgApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: sent.message_id,
      text: resultText,
      reply_markup: buildQuickKeyboard(),
    }).catch(() => {});
  });
}

async function runProjectCheckpoint(token, chatId, repoRoot, customNote = '') {
  const checkpointScript = path.join(repoRoot, '.agents', 'scripts', 'checkpoint.mjs');
  const note = customNote || `Checkpoint từ Telegram lúc ${new Date().toLocaleTimeString('vi-VN')}`;
  if (!fs.existsSync(checkpointScript)) {
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `⚠️ Dự án **${path.basename(repoRoot)}** chưa có \`.agents/scripts/checkpoint.mjs\`.`,
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  const child = spawn('node', [checkpointScript, '--note', note], {
    cwd: repoRoot,
    windowsHide: true,
  });

  let stdout = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });

  child.on('close', async (code) => {
    const s = readProjectSummary(repoRoot);
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: [
        code === 0 ? '📸 **[ĐÃ LƯU CHECKPOINT BÀN GIAO THÀNH CÔNG]**' : '⚠️ **[CHECKPOINT CÓ CẢNH BÁO]**',
        `📁 Dự án: **${s.projectName}**`,
        `📝 Ghi chú: *"${note}"*`,
        `🎯 Task hiện tại: ${s.activeTask ? s.activeTask.title : 'Hoàn tất'}`,
        stdout.trim() ? `\n📋 Chi tiết:\n${stdout.trim().slice(0, 400)}` : '',
        '\n💡 Bạn có thể bấm **🆕 Tạo Phiên Mới** để khởi tạo phiên chat mới sạch sẽ từ Checkpoint này!',
      ]
        .filter(Boolean)
        .join('\n'),
      reply_markup: buildQuickKeyboard(),
    }).catch(() => {});
  });
}

async function startNewAntigravitySessionLive(token, chatId, repoRoot) {
  const projName = path.basename(repoRoot);
  const checkpointScript = path.join(repoRoot, '.agents', 'scripts', 'checkpoint.mjs');

  // Bước 1: Tự động chạy checkpoint trước khi mở phiên mới
  if (fs.existsSync(checkpointScript)) {
    await new Promise((resolve) => {
      const cp = spawn(
        'node',
        [checkpointScript, '--note', 'Auto-checkpoint trước khi tạo phiên mới từ Telegram'],
        { cwd: repoRoot, windowsHide: true }
      );
      cp.on('close', () => resolve());
      cp.on('error', () => resolve());
    });
  }

  const sent = await tgApi(token, 'sendMessage', {
    chat_id: chatId,
    text: [
      `🆕 **[ĐANG KHỞI TẠO PHIÊN CHAT MỚI — ${projName.toUpperCase()}]**`,
      '1️⃣ Đã tự động chốt Checkpoint trạng thái vào `.agents/state/HANDOFF.md`.',
      '2️⃣ Đang gọi Antigravity CLI (`agy`) tạo một phiên hội thoại mới tinh và nạp ngữ cảnh bàn giao... ⏳',
    ].join('\n'),
  });

  const agyExe =
    'C:\\Users\\Admin\\AppData\\Local\\agy\\bin\\agy.exe';
  const bootstrapPrompt =
    'Đọc GEMINI.md, .agents/state/HANDOFF.md, .agents/state/ROADMAP.md và tóm tắt ngắn gọn (dưới 10 dòng) trạng thái hiện tại cùng bước tiếp theo để bắt đầu phiên làm việc mới này.';

  const child = spawn(
    fs.existsSync(agyExe) ? agyExe : 'agy',
    ['--mode', 'auto', '-p', bootstrapPrompt],
    {
      cwd: repoRoot,
      windowsHide: true,
    }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  child.on('close', async (code) => {
    const cleanOut = stdout.trim().slice(0, 2500);
    const resultText = [
      code === 0
        ? `✅ **[ĐÃ KHỞI TẠO PHIÊN MỚI THÀNH CÔNG — ${projName.toUpperCase()}]**`
        : `⚡ **[ĐÃ CHỐT HANDOFF CHO PHIÊN MỚI — ${projName.toUpperCase()}]**`,
      `📁 Thư mục: \`${repoRoot}\``,
      cleanOut
        ? `\n🤖 **Báo cáo từ Phiên Mới:**\n${cleanOut}`
        : '\n📄 Đã lưu toàn bộ ngữ cảnh vào `.agents/state/HANDOFF.md`. Khi mở cuộc hội thoại mới trong Antigravity, chỉ cần nhắn: *"Đọc HANDOFF.md và tiếp tục"*!',
    ]
      .filter(Boolean)
      .join('\n');

    await tgApi(token, 'editMessageText', {
      chat_id: chatId,
      message_id: sent.message_id,
      text: resultText,
      reply_markup: buildQuickKeyboard(),
    }).catch(() => {});
  });
}

async function handleTextMessage(token, expectedChatId, msg, repoRoot) {
  const chatId = String(msg.chat?.id || '');
  if (chatId !== expectedChatId) return;

  const text = String(msg.text || '').trim();
  const lower = text.toLowerCase();

  tgApi(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  if (
    lower === '/start' ||
    lower === '/help' ||
    lower === 'alo' ||
    lower === 'hi' ||
    lower === 'hello' ||
    lower === 'chào'
  ) {
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: [
        '🤖 Xin chào! **AI Workflow Telegram Daemon (Real-time 24/7)** đang trực tuyến!',
        '',
        '⚡ Bất kỳ tin nhắn nào bạn gửi lúc này đều được phản hồi ngay lập tức (< 0.5 giây).',
        '',
        '📌 **Các lệnh & câu nói tự nhiên bạn có thể dùng:**',
        '• Nhắn *"trạng thái"* hoặc `/status`: Xem tiến độ ngay lập tức',
        '• Nhắn *"roadmap"* hoặc `/roadmap`: Xem danh sách các Task',
        '• Nhắn *"chạy test"* hoặc `/test`: Chạy kiểm thử trực tiếp từ xa',
        '• Nhắn *"duyệt"* hoặc `/approve`: Mở khóa Gate hiện tại',
        '• Nhắn bất kỳ chỉ đạo nào hoặc gửi **Voice/Ghi âm**: Tự động lưu vào hộp thư lệnh của Agent và phản hồi ngay!',
      ].join('\n'),
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (
    lower === '/status' ||
    lower.includes('trạng thái') ||
    lower.includes('tiến độ') ||
    lower.includes('sao rồi') ||
    lower.includes('đang làm gì')
  ) {
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: formatStatusReport(repoRoot),
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (lower === '/roadmap' || lower.includes('roadmap') || lower.includes('lộ trình')) {
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: formatRoadmapReport(repoRoot),
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (lower === '/test' || lower.includes('chạy test') || lower.includes('kiểm thử')) {
    await runProjectTestsLive(token, chatId, repoRoot);
    return;
  }

  if (lower === '/approve' || lower === '/override' || lower === 'duyệt' || lower === 'ok duyệt') {
    const rec = await executeProjectAction(repoRoot, 'override');
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Đã thực thi phê duyệt trực tiếp từ xa:\n${rec.summaryNote}`,
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (lower === '/extend' || lower.includes('gia hạn')) {
    const rec = await executeProjectAction(repoRoot, 'extend');
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `⏩ Đã gia hạn thêm vòng review:\n${rec.summaryNote}`,
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (lower === '/projects' || lower === '/project' || lower.includes('đổi dự án') || lower.includes('chuyển dự án')) {
    const cfg = loadProjectsRegistry();
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `📂 **[DANH BẠ ĐA DỰ ÁN — MULTI-PROJECT HUB]**\n🎯 Dự án đang kích hoạt: **${cfg.activeProject}** (\`${cfg.projects?.[cfg.activeProject]}\`)\n\n👇 Bấm chọn dự án bên dưới để chuyển quyền điều khiển ngay lập tức:`,
      reply_markup: buildProjectsKeyboard(),
    });
    return;
  }

  if (lower === '/checkpoint' || lower.includes('lưu checkpoint') || lower === 'checkpoint') {
    await runProjectCheckpoint(token, chatId, repoRoot);
    return;
  }

  if (lower === '/newchat' || lower === '/newsession' || lower.includes('tạo phiên mới') || lower.includes('phiên mới')) {
    await startNewAntigravitySessionLive(token, chatId, repoRoot);
    return;
  }

  if (lower === '/inbox') {
    const inboxPath = path.join(repoRoot, '.agents', 'state', 'TELEGRAM_INBOX.json');
    const list = fs.existsSync(inboxPath) ? JSON.parse(fs.readFileSync(inboxPath, 'utf8')) : [];
    const recent = list.slice(-5);
    const msgLines =
      recent.length > 0
        ? recent.map((item, idx) => `${idx + 1}. [${item.type}] "${item.text}" (${item.createdAt})`)
        : ['Hộp thư hiện đang trống.'];
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `📥 [5 CHỈ ĐẠO GẦN NHẤT TRONG INBOX]\n\n${msgLines.join('\n')}`,
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  appendToInbox(repoRoot, {
    type: 'text',
    messageId: msg.message_id,
    text,
  });

  const escPath = path.join(repoRoot, '.agents', 'state', 'ESCALATION_SESSION.json');
  let escNote = '';
  if (fs.existsSync(escPath)) {
    try {
      const esc = JSON.parse(fs.readFileSync(escPath, 'utf8'));
      if (esc.status === 'PENDING') {
        const rec = await executeProjectAction(repoRoot, 'retarget', '', text);
        escNote = `\n🔓 Đã tự động mở khóa phiên Escalation đang chờ: ${rec.summaryNote}`;
      }
    } catch (_e) {}
  }

  const s = readProjectSummary(repoRoot);
  await tgApi(token, 'sendMessage', {
    chat_id: chatId,
    text: [
      '⚡ **Đã nhận chỉ đạo tức thì!**',
      `💬 Nội dung bạn vừa gửi: *"${text}"*`,
      `📥 Đã lưu vào hàng đợi chỉ đạo (\`TELEGRAM_INBOX.json\`) của dự án **${s.projectName}**.`,
      escNote,
      `🎯 Task hiện tại: ${s.activeTask ? s.activeTask.title : 'Hoàn tất'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    reply_markup: buildQuickKeyboard(),
  });
}

async function handleMediaMessage(token, expectedChatId, msg, repoRoot) {
  const chatId = String(msg.chat?.id || '');
  if (chatId !== expectedChatId) return;

  const isVoice = Boolean(msg.voice);
  const isVideoNote = Boolean(msg.video_note);
  const isAudio = Boolean(msg.audio);
  const duration = msg.voice?.duration || msg.video_note?.duration || msg.audio?.duration || 0;
  const fileId = msg.voice?.file_id || msg.video_note?.file_id || msg.audio?.file_id || '';
  const mediaLabel = isVoice
    ? `Tin nhắn thoại (Voice ${duration}s)`
    : isVideoNote
    ? `Video Note (${duration}s)`
    : isAudio
    ? `File âm thanh (${duration}s)`
    : 'Tệp đa phương tiện';

  // Tự động tải file âm thanh/video về ổ cứng để AI Agent nghe và thực thi ngay khi thức dậy
  let localFilePath = '';
  if (fileId) {
    try {
      const fileInfo = await tgApi(token, 'getFile', { file_id: fileId });
      if (fileInfo?.file_path) {
        const rawExt = path.extname(fileInfo.file_path);
        const ext = rawExt === '.oga' || !rawExt ? (isVoice ? '.ogg' : '.mp4') : rawExt;
        const mediaDir = path.join(repoRoot, '.agents', 'state', 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        localFilePath = path.join(mediaDir, `tg_media_${msg.message_id}${ext}`);
        const dlRes = await fetch(`https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`);
        const buf = Buffer.from(await dlRes.arrayBuffer());
        fs.writeFileSync(localFilePath, buf);
      }
    } catch (dlErr) {
      console.error('[MEDIA DOWNLOAD WARN]:', dlErr.message);
    }
  }

  appendToInbox(repoRoot, {
    type: isVoice ? 'voice' : isVideoNote ? 'video_note' : 'media',
    messageId: msg.message_id,
    duration,
    fileId,
    localFilePath,
    text: `[${mediaLabel}]`,
  });

  await tgApi(token, 'sendMessage', {
    chat_id: chatId,
    text: [
      `🎙️ **Đã nhận ngay ${mediaLabel} của bạn!**`,
      '⚡ Đang đánh thức AI Agent nghe nội dung và thực thi yêu cầu của bạn ngay lập tức...',
    ].join('\n'),
    reply_markup: buildQuickKeyboard(),
  });
}

async function handleCallbackQuery(token, expectedChatId, cb, repoRoot) {
  const chatId = String(cb.message?.chat?.id || '');
  if (chatId !== expectedChatId) return;
  const data = String(cb.data || '');

  await tgApi(token, 'answerCallbackQuery', {
    callback_query_id: cb.id,
    text: '⚡ Đang thực thi lệnh...',
  }).catch(() => {});

  if (data === 'hub:status') {
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: formatStatusReport(repoRoot),
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (data === 'hub:roadmap') {
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: formatRoadmapReport(repoRoot),
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (data === 'hub:test') {
    await runProjectTestsLive(token, chatId, repoRoot);
    return;
  }

  if (data === 'hub:approve') {
    const rec = await executeProjectAction(repoRoot, 'override');
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Đã thực thi Duyệt Gate (Override):\n${rec.summaryNote}`,
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (data === 'hub:extend') {
    const rec = await executeProjectAction(repoRoot, 'extend');
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `⏩ Đã gia hạn +2 vòng review:\n${rec.summaryNote}`,
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (data === 'hub:checkpoint') {
    await runProjectCheckpoint(token, chatId, repoRoot);
    return;
  }

  if (data === 'hub:newchat') {
    await startNewAntigravitySessionLive(token, chatId, repoRoot);
    return;
  }

  if (data === 'hub:open_ide') {
    const cfg = loadProjectsRegistry();
    const activePath = getActiveProjectRoot();
    openInAntigravityIde(activePath);
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `🖥️ **Đã gửi lệnh mở dự án "${cfg.activeProject}" trên Antigravity IDE!**\n📁 Đường dẫn: \`${activePath}\``,
      reply_markup: buildQuickKeyboard(),
    });
    return;
  }

  if (data === 'hub:projects') {
    const cfg = loadProjectsRegistry();
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `📂 **[DANH BẠ ĐA DỰ ÁN — MULTI-PROJECT HUB]**\n🎯 Dự án đang kích hoạt: **${cfg.activeProject}** (\`${cfg.projects?.[cfg.activeProject]}\`)\n\n👇 Bấm chọn dự án bên dưới để chuyển quyền điều khiển từ xa:`,
      reply_markup: buildProjectsKeyboard(),
    });
    return;
  }

  if (data.startsWith('proj:')) {
    const targetName = data.slice('proj:'.length);
    const switchedPath = switchActiveProject(targetName);
    if (switchedPath) {
      await tgApi(token, 'sendMessage', {
        chat_id: chatId,
        text: `🔄 **Đã chuyển mục tiêu điều khiển sang dự án: ${targetName}**\n📁 Đường dẫn: \`${switchedPath}\`\n\n${formatStatusReport(switchedPath)}`,
        reply_markup: buildQuickKeyboard(),
      });
    }
    return;
  }

  if (data.startsWith('esc:')) {
    const parts = data.split(':');
    const rawAction = parts[2] || 'extend_2';
    let action = 'extend';
    let choice = '';
    if (rawAction === 'opt_a' || rawAction === 'opt_b' || rawAction === 'opt_c') {
      action = 'option';
      choice = rawAction.slice(-1).toUpperCase();
    } else if (rawAction === 'override') {
      action = 'override';
    } else if (rawAction === 'stop') {
      action = 'stop';
    } else if (rawAction === 'retarget') {
      await tgApi(token, 'sendMessage', {
        chat_id: chatId,
        text: '✏️ Bạn hãy gõ trực tiếp mục tiêu / chỉ đạo mới vào khung chat này:',
      });
      return;
    }

    const rec = await executeProjectAction(repoRoot, action, choice);
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Đã xử lý quyết định Escalation tức thì:\n${rec.summaryNote}`,
      reply_markup: buildQuickKeyboard(),
    });
  }
}

async function startDaemon() {
  const { token, chatId } = getCredentials();
  if (!token || !chatId) {
    console.error('[DAEMON ERROR]: Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
    process.exit(1);
  }

  const repoRoot = getActiveProjectRoot();
  const lockFile = path.join(repoRoot, '.agents', 'state', 'HUB_ACTIVE.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );

  const cleanupLock = () => {
    try {
      if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    } catch (_e) {}
    process.exit(0);
  };
  process.on('SIGINT', cleanupLock);
  process.on('SIGTERM', cleanupLock);

  await tgApi(token, 'setMyCommands', {
    commands: [
      { command: 'status', description: '📊 Xem trạng thái & tiến độ dự án hiện tại' },
      { command: 'projects', description: '📂 Đổi dự án đang điều khiển (Multi-Project)' },
      { command: 'roadmap', description: '🗺️ Xem danh sách các Task trong Roadmap' },
      { command: 'test', description: '🧪 Chạy bộ kiểm thử tự động từ xa' },
      { command: 'checkpoint', description: '📸 Lưu Checkpoint bàn giao ngữ cảnh' },
      { command: 'newchat', description: '🆕 Khởi tạo phiên chat mới trên Antigravity' },
      { command: 'approve', description: '✅ Duyệt nhanh Gate hiện tại (Override)' },
      { command: 'extend', description: '⏩ Gia hạn thêm +2 vòng review Mentor' },
      { command: 'inbox', description: '📥 Xem các chỉ đạo đã gửi trong hộp thư' },
      { command: 'help', description: '🤖 Hiện bảng điều khiển tương tác' },
    ],
  }).catch((e) => console.warn('[WARN setMyCommands]:', e.message));

  console.log(`[TELEGRAM DAEMON]: Đang chạy nền 24/7 (PID: ${process.pid}) cho dự án ${repoRoot}`);

  if (!process.argv.includes('--no-banner')) {
    await tgApi(token, 'sendMessage', {
      chat_id: chatId,
      text: [
        '🚀 **[AI WORKFLOW TELEGRAM DAEMON ĐÃ KÍCH HOẠT REAL-TIME 24/7]**',
        '',
        '⚡ Từ bây giờ, bất kỳ lúc nào bạn nhắn tin chữ, gửi voice hoặc bấm nút bên dưới, hệ thống sẽ **phản hồi ngay lập tức (< 0.5 giây)** như Messenger!',
        '',
        '👇 Hãy thử nhắn bất kỳ câu gì (ví dụ: *"trạng thái"*, *"alo"*, hoặc bấm nút bên dưới) để trải nghiệm ngay:',
      ].join('\n'),
      reply_markup: buildQuickKeyboard(),
    }).catch((e) => console.warn('[WARN initial message]:', e.message));
  }

  let offset = 0;
  while (true) {
    try {
      const updates = await tgApi(token, 'getUpdates', {
        offset,
        limit: 20,
        timeout: 20,
        allowed_updates: ['message', 'callback_query'],
      });

      if (Array.isArray(updates) && updates.length > 0) {
        const activeRoot = getActiveProjectRoot();
        for (const u of updates) {
          offset = Math.max(offset, (u.update_id || 0) + 1);
          try {
            if (u.callback_query) {
              await handleCallbackQuery(token, chatId, u.callback_query, activeRoot);
            } else if (u.message) {
              if (typeof u.message.text === 'string') {
                await handleTextMessage(token, chatId, u.message, activeRoot);
              } else if (
                u.message.voice ||
                u.message.video_note ||
                u.message.audio ||
                u.message.photo
              ) {
                await handleMediaMessage(token, chatId, u.message, activeRoot);
              }
            }
          } catch (handlerErr) {
            console.error('[HANDLER ERROR]:', handlerErr.message);
          }
        }
      }
    } catch (pollErr) {
      console.error('[POLL WARNING]:', pollErr.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

startDaemon();
