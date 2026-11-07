#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import os from 'node:os';
import {
  loadWorkflowConfig,
  stageIntentToAdd,
  computePlanHash,
  computeCodeDiffHash,
  loadStateLock,
  saveStateLock,
} from './verify_guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WORKFLOW_CONFIG = loadWorkflowConfig(REPO_ROOT);
const DEFAULT_PROJECT_NAME = WORKFLOW_CONFIG.projectName || 'AI-WORKSPACE';
const DEFAULT_CDP_URL = WORKFLOW_CONFIG.cdpUrl || 'http://127.0.0.1:9222';
const DEFAULT_GEMINI_CDP_URL = WORKFLOW_CONFIG.geminiCdpUrl || 'http://127.0.0.1:9223';
const DEFAULT_PROJECT_URL = 'https://chatgpt.com/';
const DEFAULT_GEMINI_URL = 'https://gemini.google.com/app';
const DEFAULT_MODE = 'plan';
const DEFAULT_PROVIDER = 'chatgpt';
const VALID_MODES = new Set(['plan', 'review-code', 'rescue']);
const VALID_PROVIDERS = new Set(['chatgpt', 'gemini', 'both']);
const VALID_EFFORTS = new Set(['high', 'standard']);
const MAX_DIFF_CHARS = 300_000;
const MAX_SKELETON_LINES = 150;
// Phạm vi review code: đọc từ .agents/config.json (mặc định ['src', 'tests']), tuyệt đối không gửi .agents/
const REVIEW_SCOPE =
  Array.isArray(WORKFLOW_CONFIG.sourceDirs) && WORKFLOW_CONFIG.sourceDirs.length > 0
    ? WORKFLOW_CONFIG.sourceDirs
    : ['src', 'tests'];
const TEST_COMMAND = WORKFLOW_CONFIG.testCommand || 'npm test';
// Nếu phần code (diff + file mới) dài hơn ngưỡng này -> đính kèm dạng tệp thay vì dán vào ô chat
const MAX_INLINE_CODE_CHARS = 20_000;
// Giới hạn cứng số vòng review cho cùng một giai đoạn (đọc từ .agents/config.json, mặc định 2)
const MAX_ROUNDS_PER_STAGE =
  Number(WORKFLOW_CONFIG.maxReviewRounds) > 0 ? Number(WORKFLOW_CONFIG.maxReviewRounds) : 2;

const STATE_DIR = path.join(REPO_ROOT, '.agents', 'state');
const ROLES_FILE = path.join(REPO_ROOT, '.agents', 'roles.json');
const PLAN_FILE = path.join(STATE_DIR, 'CURRENT_PLAN.md');
const ROADMAP_FILE = path.join(STATE_DIR, 'ROADMAP.md');
const HANDOFF_FILE = path.join(STATE_DIR, 'HANDOFF.md');
const FEEDBACK_FILE = path.join(STATE_DIR, 'MENTOR_FEEDBACK.md');
const GEMINI_FEEDBACK_FILE = path.join(STATE_DIR, 'GEMINI_FEEDBACK.md');
const CODE_REVIEW_FILE = path.join(STATE_DIR, 'CODE_REVIEW_FEEDBACK.md');
const SESSION_MAP_FILE = path.join(STATE_DIR, 'SESSION_MAP.json');
const SOURCE_DIR_NAME = 'src';

const PROMPT_SELECTOR =
  '#prompt-textarea, div.ProseMirror[data-composer-markdown], div.ProseMirror[contenteditable="true"][aria-label*="ChatGPT"], [contenteditable="true"][aria-label*="ChatGPT"]';
const SEND_BUTTON_SELECTOR =
  '[data-testid="send-button"], button[aria-label="Gửi"], button[aria-label*="Gửi"], button[aria-label="Send prompt"], button[aria-label*="Send"]';
const STOP_BUTTON_SELECTOR =
  '[data-testid="stop-button"], button[aria-label*="Ngừng"], button[aria-label*="Dừng"], button[aria-label*="Stop"]';
const ASSISTANT_MESSAGE_SELECTOR =
  '[data-message-author-role="assistant"], [class*="--entity-prose-inset"], article[data-turn="assistant"], [data-testid*="conversation-turn"] .markdown';
const NEW_CHAT_BUTTON_SELECTOR =
  '[data-testid="create-new-chat-button"], a[data-testid="create-new-chat-button"], nav a[href="/"], a[href="/"]';
const CONVERSATION_URL_REGEX = /\/(?:g\/[^/]+\/)?c\/([a-z0-9-]+)/i;

/**
 * Chuẩn hóa mã định danh Task về dạng `task-<id>` (chữ thường).
 * Ví dụ: "3" -> "task-3", "Task 2" -> "task-2", "task-3" -> "task-3".
 *
 * @param {string} rawTask
 * @returns {string}
 */
function normalizeTaskId(rawTask) {
  if (typeof rawTask !== 'string') {
    return '';
  }
  const trimmed = rawTask.trim();
  if (!trimmed) {
    return '';
  }
  const prefixedMatch = trimmed.match(/^task[-_\s#:]*([a-z0-9_-]+)$/i);
  if (prefixedMatch) {
    return `task-${prefixedMatch[1].toLowerCase()}`;
  }
  if (/^\d+[a-z0-9_-]*$/i.test(trimmed)) {
    return `task-${trimmed.toLowerCase()}`;
  }
  return trimmed.toLowerCase().replace(/\s+/g, '-');
}

/**
 * Chuẩn hóa mức độ suy luận (`--effort`) về `'high'` hoặc `'standard'`.
 *
 * @param {string} rawEffort
 * @returns {string}
 */
function normalizeEffort(rawEffort) {
  if (typeof rawEffort !== 'string') {
    return '';
  }
  const val = rawEffort.trim().toLowerCase();
  if (!val) {
    return '';
  }
  if (val === 'high' || val === 'cao') {
    return 'high';
  }
  if (
    val === 'standard' ||
    val === 'medium' ||
    val === 'chuẩn' ||
    val === 'chuan' ||
    val === 'trung bình' ||
    val === 'vừa'
  ) {
    return 'standard';
  }
  return val;
}

/**
 * Chuẩn hóa tham số CLI:
 * - Bỏ hẳn tham số mặc định `--model gpt-4o`.
 * - Hỗ trợ `--mode <plan|review-code|rescue>` (mặc định: `plan`).
 * - Hỗ trợ `--effort <high|standard>` (mặc định: `high` cho plan/rescue, `standard` cho review-code).
 * - Hỗ trợ `--task <task_id>` và `--new-thread` cho tính năng xoay vòng luồng chat theo Task.
 * - Hỗ trợ `--error "<tóm tắt lỗi>"` cho chế độ `rescue`.
 *
 * @param {string[]} argv
 * @returns {{ mode: 'plan' | 'review-code' | 'rescue', provider: 'chatgpt' | 'gemini' | 'both', taskArg: string, roleArg: string, effortArg: string, newThread: boolean, errorSummary: string, model: string, projectName: string, cdpUrl: string }}
 */
function parseArgs(argv) {
  let mode = DEFAULT_MODE;
  let provider = DEFAULT_PROVIDER;
  let taskArg = '';
  let roleArg = '';
  let effortArg = '';
  let newThread = false;
  let errorSummary = '';
  let model = '';
  let projectName = '';
  let cdpUrl = process.env.CDP_URL || DEFAULT_CDP_URL;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode' && i + 1 < argv.length) {
      mode = argv[i + 1].trim().toLowerCase();
      i += 1;
    } else if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length).trim().toLowerCase();
    } else if (arg === '--provider' && i + 1 < argv.length) {
      provider = argv[i + 1].trim().toLowerCase();
      i += 1;
    } else if (arg.startsWith('--provider=')) {
      provider = arg.slice('--provider='.length).trim().toLowerCase();
    } else if (arg === '--task' && i + 1 < argv.length) {
      taskArg = normalizeTaskId(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--task=')) {
      taskArg = normalizeTaskId(arg.slice('--task='.length));
    } else if (arg === '--role' && i + 1 < argv.length) {
      roleArg = argv[i + 1].trim().toLowerCase();
      i += 1;
    } else if (arg.startsWith('--role=')) {
      roleArg = arg.slice('--role='.length).trim().toLowerCase();
    } else if (arg === '--effort' && i + 1 < argv.length) {
      effortArg = normalizeEffort(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--effort=')) {
      effortArg = normalizeEffort(arg.slice('--effort='.length));
    } else if (arg === '--new-thread') {
      newThread = true;
    } else if (arg === '--error' && i + 1 < argv.length) {
      errorSummary = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--error=')) {
      errorSummary = arg.slice('--error='.length).trim();
    } else if (arg === '--project-name' && i + 1 < argv.length) {
      projectName = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--project-name=')) {
      projectName = arg.slice('--project-name='.length).trim();
    } else if (arg === '--model' && i + 1 < argv.length) {
      model = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--model=')) {
      model = arg.slice('--model='.length).trim();
    } else if (arg === '--cdp' && i + 1 < argv.length) {
      cdpUrl = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--cdp=')) {
      cdpUrl = arg.slice('--cdp='.length).trim();
    }
  }

  if (!VALID_MODES.has(mode)) {
    throw new Error(
      `Chế độ --mode không hợp lệ: "${mode}". Chỉ hỗ trợ: plan, review-code, rescue.`
    );
  }

  if (!VALID_PROVIDERS.has(provider)) {
    throw new Error(
      `Nhà cung cấp --provider không hợp lệ: "${provider}". Chỉ hỗ trợ: chatgpt, gemini, both.`
    );
  }

  if (effortArg && !VALID_EFFORTS.has(effortArg)) {
    throw new Error(
      `Mức suy luận --effort không hợp lệ: "${effortArg}". Chỉ hỗ trợ: high, standard.`
    );
  }

  return {
    mode,
    provider,
    taskArg,
    roleArg,
    effortArg,
    newThread,
    errorSummary,
    model,
    projectName,
    cdpUrl,
  };
}

/**
 * Đọc danh bạ 9 Chuyên gia từ `.agents/roles.json`.
 *
 * @returns {Record<string, { name: string, description: string }>}
 */
function loadRolesCatalog() {
  const defaults = {
    strategy: {
      name: 'Product Strategy & Scope Lead',
      description: 'Phân tích phạm vi, chia nhỏ ROADMAP, chống scope creep',
    },
    architect: {
      name: 'Software System Architect',
      description: 'Thiết kế kiến trúc hệ thống, data flow, module contracts',
    },
    backend: {
      name: 'Backend & Distributed Systems Engineer',
      description: 'API, DB, bất đồng bộ, hiệu năng, fault-tolerance',
    },
    frontend: {
      name: 'Frontend Product Engineer',
      description: 'UI components, state management, responsive, accessibility',
    },
    workflow: {
      name: 'AI Workflow & Prompt Engineer',
      description: 'Tối ưu điều phối multi-agent, prompt, context engineering',
    },
    qa: {
      name: 'Independent QA & Gate Reviewer',
      description: 'Kiểm định chéo git diff, test coverage, nghiệm thu Gate',
    },
    devops: {
      name: 'DevOps, Reliability & Cost Engineer',
      description: 'CI/CD, bảo mật, cấu hình môi trường, tối ưu chi phí',
    },
    creative: {
      name: 'Creative Director & Experience Designer',
      description: 'Định hướng thẩm mỹ, UX flow, micro-interactions',
    },
    motion: {
      name: 'Creative Motion & WebGL Engineer',
      description: 'Animation, 3D/WebGL, shaders, tối ưu FPS/GPU',
    },
  };
  try {
    if (fs.existsSync(ROLES_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...defaults, ...parsed };
      }
    }
  } catch (_err) {}
  return defaults;
}

/**
 * Giải quyết danh sách Chuyên gia (1 hoặc tối đa 2 vai trò) từ `--role` hoặc mặc định thông minh theo `--mode`:
 * - `--mode plan`        -> mặc định `architect`
 * - `--mode review-code` -> mặc định `qa` (Independent QA & Gate Reviewer)
 * - `--mode rescue`      -> mặc định `architect,workflow`
 *
 * @param {string} roleArg
 * @param {'plan' | 'review-code' | 'rescue'} mode
 * @returns {Array<{ key: string, name: string, description: string }>}
 */
function resolveSpecialistRoles(roleArg, mode) {
  const catalog = loadRolesCatalog();
  let defaultKeys = ['architect'];
  if (mode === 'review-code') {
    defaultKeys = ['qa'];
  } else if (mode === 'rescue') {
    defaultKeys = ['architect', 'workflow'];
  }

  const rawKeys = roleArg
    ? roleArg
        .split(',')
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean)
    : defaultKeys;

  const selected = [];
  for (const key of rawKeys) {
    if (catalog[key] && !selected.some((r) => r.key === key)) {
      selected.push({
        key,
        name: catalog[key].name,
        description: catalog[key].description,
      });
    }
    if (selected.length >= 2) {
      break;
    }
  }

  if (selected.length === 0) {
    for (const fallbackKey of defaultKeys) {
      if (catalog[fallbackKey]) {
        selected.push({
          key,
          name: catalog[fallbackKey].name,
          description: catalog[fallbackKey].description,
        });
      }
    }
  }
  return selected;
}

/**
 * Tạo khối Role Header ngắn gọn gắn ở đầu Prompt để kích hoạt đúng chuyên môn của vai trò đã chọn.
 *
 * @param {Array<{ key: string, name: string, description: string }>} roles
 * @returns {string}
 */
function buildRoleHeader(roles) {
  if (!Array.isArray(roles) || roles.length === 0) {
    return '';
  }
  const roleLines = roles.map(
    (r) => `- [${r.key}] **${r.name}**: ${r.description}`
  );
  return [
    '--- ĐỊNH TUYẾN CHUYÊN GIA (SPECIALIST ROLE ROUTING) ---',
    'Vai trò chuyên gia kích hoạt cho phiên đánh giá này:',
    ...roleLines,
    'Hãy phân tích, phản biện và ra quyết định dưới góc nhìn chuyên sâu của (các) Chuyên gia trên.',
    '--- KẾT THÚC ĐỊNH TUYẾN CHUYÊN GIA ---',
  ].join('\n');
}

/**
 * Tạm dừng thực thi trong `ms` mili-giây.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Đọc file trạng thái an toàn (trả về chuỗi rỗng nếu chưa tồn tại).
 *
 * @param {string} filePath
 * @returns {string}
 */
function readFileSafe(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8').trim();
    }
  } catch (_err) {
    // Bỏ qua lỗi đọc file phụ trợ
  }
  return '';
}

/**
 * Xác định khóa lưu phiên trong `SESSION_MAP.json` theo cả Task và giai đoạn (RPIR Mode).
 * Giúp mỗi giai đoạn (plan, review-code, rescue) có luồng chat độc lập, tránh dồn ứ ngữ cảnh.
 *
 * @param {string} taskId
 * @param {'plan' | 'review-code' | 'rescue'} mode
 * @returns {string}
 */
function getThreadKey(taskId, mode) {
  const normTaskId = normalizeTaskId(taskId) || 'task-1';
  if (mode === 'review-code') {
    return `${normTaskId}-review`;
  }
  if (mode === 'rescue') {
    return `${normTaskId}-rescue`;
  }
  return `${normTaskId}-plan`;
}

/**
 * Đọc cấu hình `.agents/state/SESSION_MAP.json`.
 * Nếu chưa tồn tại hoặc lỗi cú pháp, trả về cấu trúc mặc định.
 *
 * @returns {{ projectName: string, projectUrl: string, currentTask: string, threads: Record<string, { url: string, updatedAt: string }> }}
 */
function loadSessionMap() {
  const fallback = {
    projectName: DEFAULT_PROJECT_NAME,
    projectUrl: DEFAULT_PROJECT_URL,
    geminiThreadUrl: '',
    currentTask: '',
    threads: {},
  };

  try {
    if (!fs.existsSync(SESSION_MAP_FILE)) {
      return fallback;
    }
    const raw = fs.readFileSync(SESSION_MAP_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fallback;
    }
    const projectName =
      typeof parsed.projectName === 'string' && parsed.projectName.trim()
        ? parsed.projectName.trim()
        : DEFAULT_PROJECT_NAME;
    const projectUrl =
      typeof parsed.projectUrl === 'string' && parsed.projectUrl.trim()
        ? parsed.projectUrl.trim()
        : DEFAULT_PROJECT_URL;
    const geminiThreadUrl =
      typeof parsed.geminiThreadUrl === 'string'
        ? parsed.geminiThreadUrl.trim()
        : '';
    const currentTask =
      typeof parsed.currentTask === 'string'
        ? normalizeTaskId(parsed.currentTask)
        : '';
    const threads = {};
    if (
      parsed.threads &&
      typeof parsed.threads === 'object' &&
      !Array.isArray(parsed.threads)
    ) {
      for (const [key, val] of Object.entries(parsed.threads)) {
        const normKey = normalizeTaskId(key);
        if (normKey && val && typeof val === 'object' && typeof val.url === 'string') {
          threads[normKey] = {
            url: val.url.trim(),
            rounds: typeof val.rounds === 'number' ? val.rounds : 0,
            updatedAt:
              typeof val.updatedAt === 'string'
                ? val.updatedAt
                : new Date().toISOString(),
          };
        }
      }
    }
    return { projectName, projectUrl, geminiThreadUrl, currentTask, threads };
  } catch (_err) {
    return fallback;
  }
}

/**
 * Ghi cấu trúc `SESSION_MAP.json` xuống đĩa.
 *
 * @param {{ projectName?: string, projectUrl: string, currentTask: string, threads: Record<string, { url: string, updatedAt: string }> }} sessionMap
 */
function saveSessionMap(sessionMap) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    SESSION_MAP_FILE,
    `${JSON.stringify(sessionMap, null, 2)}\n`,
    'utf8'
  );
}

/**
 * Tự động xác định mã Task hiện tại nếu người dùng không truyền `--task <task_id>`:
 * 1. Trích xuất Task từ tiêu đề trong `.agents/state/CURRENT_PLAN.md` và mục chưa hoàn thành `[ ]` đầu tiên trong `.agents/state/ROADMAP.md`.
 * 2. Nếu Task trong tiêu đề `CURRENT_PLAN.md` chưa bị đánh dấu hoàn thành `[x]` (hoặc `ROADMAP.md` không còn mục `[ ]` nào), ưu tiên dùng Task từ `CURRENT_PLAN.md`.
 * 3. Nếu Task trong `CURRENT_PLAN.md` đã `[x]` nhưng `ROADMAP.md` có mục `[ ]` mới, chọn mục `[ ]` đầu tiên trong `ROADMAP.md`.
 *
 * @param {string} explicitTaskArg
 * @param {string} planContent
 * @param {string} roadmapContent
 * @param {{ currentTask: string }} sessionMap
 * @returns {string}
 */
function resolveCurrentTaskId(
  explicitTaskArg,
  planContent,
  roadmapContent,
  sessionMap
) {
  if (explicitTaskArg) {
    return normalizeTaskId(explicitTaskArg);
  }

  let planTask = '';
  const headingMatch = planContent.match(
    /^#+\s*.*?\bTask\s*[-#:]?\s*(\d+[a-z0-9_-]*)/im
  );
  if (headingMatch) {
    planTask = normalizeTaskId(headingMatch[1]);
  }

  let firstUnfinishedRoadmapTask = '';
  const completedRoadmapTasks = new Set();

  if (roadmapContent) {
    const lines = roadmapContent.split(/\r?\n/);
    for (const line of lines) {
      const unfinishedMatch = line.match(
        /^\s*-\s*\[\s*\]\s*.*?\bTask\s*[-#:]?\s*(\d+[a-z0-9_-]*)/i
      );
      if (unfinishedMatch && !firstUnfinishedRoadmapTask) {
        firstUnfinishedRoadmapTask = normalizeTaskId(unfinishedMatch[1]);
      }

      const completedMatch = line.match(
        /^\s*-\s*\[[xX]\]\s*.*?\bTask\s*[-#:]?\s*(\d+[a-z0-9_-]*)/i
      );
      if (completedMatch) {
        completedRoadmapTasks.add(normalizeTaskId(completedMatch[1]));
      }
    }
  }

  if (
    planTask &&
    (!completedRoadmapTasks.has(planTask) || !firstUnfinishedRoadmapTask)
  ) {
    return planTask;
  }

  if (firstUnfinishedRoadmapTask) {
    return firstUnfinishedRoadmapTask;
  }

  if (planTask) {
    return planTask;
  }

  if (sessionMap && sessionMap.currentTask) {
    return normalizeTaskId(sessionMap.currentTask);
  }

  return 'task-1';
}

/**
 * Quét danh sách file trong `sourceDirs` (từ `.agents/config.json`),
 * lọc các dòng khai báo `function`, `class`, `export`, `interface`, `type`, `def`, `public function`
 * (chỉ lấy dòng chữ ký, tối đa 150 dòng cho toàn repo).
 *
 * @param {string[]} [sourceDirs=REVIEW_SCOPE]
 * @param {string} [repoRoot=REPO_ROOT]
 * @param {number} [maxLines=MAX_SKELETON_LINES]
 * @returns {string}
 */
export function buildRepoSkeleton(
  sourceDirs = REVIEW_SCOPE,
  repoRoot = REPO_ROOT,
  maxLines = MAX_SKELETON_LINES
) {
  const dirs =
    Array.isArray(sourceDirs) && sourceDirs.length > 0
      ? sourceDirs
      : REVIEW_SCOPE;
  const collectedFiles = [];
  const isTestFile = (name) => /\.(?:test|spec)\.[^.]+$/i.test(name);

  function walkDir(currentAbsPath) {
    let entries = [];
    try {
      entries = fs.readdirSync(currentAbsPath, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === '.agents' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      const fullPath = path.join(currentAbsPath, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.isFile() && !isTestFile(entry.name)) {
        collectedFiles.push(fullPath);
      }
    }
  }

  for (const relDir of dirs) {
    const absDir = path.resolve(repoRoot, relDir);
    if (fs.existsSync(absDir)) {
      try {
        const stat = fs.statSync(absDir);
        if (stat.isDirectory()) {
          walkDir(absDir);
        } else if (stat.isFile() && !isTestFile(path.basename(absDir))) {
          collectedFiles.push(absDir);
        }
      } catch (_err) {
        // Bỏ qua đường dẫn lỗi
      }
    }
  }

  const signatureRegex =
    /^(?:export\s+(?:default\s+)?)?(?:(?:public|protected|private|static|abstract|final|async)\s+)*(?:function\b|class\b|interface\b|type\b|def\b)|^export\s+(?:const|let|var|default|function|class|interface|type|\{)\b|^public\s+function\b|^module\.exports\b/;

  const outputLines = [];
  let truncated = false;

  for (const filePath of collectedFiles) {
    if (outputLines.length >= maxLines) {
      truncated = true;
      break;
    }
    const relPath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_err) {
      continue;
    }
    if (content.includes('\0')) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const fileSignatures = [];
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) {
          inBlockComment = false;
        }
        continue;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) {
          inBlockComment = true;
        }
        continue;
      }
      if (
        !trimmed ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('*/')
      ) {
        continue;
      }
      if (signatureRegex.test(trimmed)) {
        const cleanSig = trimmed.replace(/\s*\{+\s*$/, '').slice(0, 160);
        fileSignatures.push(`  L${i + 1}: ${cleanSig}`);
      }
    }

    if (fileSignatures.length === 0) {
      continue;
    }

    outputLines.push(`[FILE] ${relPath}`);
    if (outputLines.length >= maxLines) {
      truncated = true;
      break;
    }

    for (const sig of fileSignatures) {
      if (outputLines.length >= maxLines) {
        truncated = true;
        break;
      }
      outputLines.push(sig);
    }
  }

  if (outputLines.length === 0) {
    return '(Không tìm thấy file hoặc chữ ký khai báo nào trong sourceDirs)';
  }
  if (truncated) {
    outputLines.push(`... [ĐÃ GIỚI HẠN TỐI ĐA ${maxLines} DÒNG REPO SKELETON] ...`);
  }
  return outputLines.join('\n');
}

/**
 * Xây dựng khối `--- NGỮ CẢNH BÀN GIAO DỰ ÁN (BOOTSTRAP) ---` từ `ROADMAP.md`, `HANDOFF.md`
 * và `--- REPO SKELETON MAP ---` khi bắt đầu luồng chat mới (`effectiveNewThread`).
 *
 * @param {string} taskId
 * @param {string} roadmapContent
 * @param {string} handoffContent
 * @param {string[]} [sourceDirs=REVIEW_SCOPE]
 * @returns {string}
 */
export function buildBootstrapContext(
  taskId,
  roadmapContent,
  handoffContent,
  sourceDirs = REVIEW_SCOPE
) {
  const safeRoadmap = roadmapContent || '(Chưa có nội dung ROADMAP.md)';
  const safeHandoff = handoffContent || '(Chưa có nội dung HANDOFF.md)';
  const repoSkeleton = buildRepoSkeleton(sourceDirs);

  return [
    '--- NGỮ CẢNH BÀN GIAO DỰ ÁN (BOOTSTRAP) ---',
    `Task hiện tại: ${taskId}`,
    'Đây là phiên làm việc (thread) mới được khởi tạo riêng cho Task này theo cơ chế Per-Task Thread Rotation.',
    'Dưới đây là toàn bộ lộ trình dự án (ROADMAP.md), biên bản bàn giao từ các Task trước (HANDOFF.md) và bản đồ khung mã nguồn (REPO SKELETON MAP):',
    '',
    '=== BẮT ĐẦU .agents/state/ROADMAP.md ===',
    safeRoadmap,
    '=== KẾT THÚC .agents/state/ROADMAP.md ===',
    '',
    '=== BẮT ĐẦU .agents/state/HANDOFF.md ===',
    safeHandoff,
    '=== KẾT THÚC .agents/state/HANDOFF.md ===',
    '',
    '--- REPO SKELETON MAP ---',
    repoSkeleton,
    '--- KẾT THÚC REPO SKELETON MAP ---',
    '--- KẾT THÚC NGỮ CẢNH BÀN GIAO DỰ ÁN (BOOTSTRAP) ---',
  ].join('\n');
}

/**
 * Giới hạn độ dài chuỗi ở mức an toàn nhưng giữ nguyên 100% định dạng dòng và khoảng trắng.
 *
 * @param {string} text
 * @param {number} [maxChars=MAX_DIFF_CHARS]
 * @returns {string}
 */
function truncateSafely(text, maxChars = MAX_DIFF_CHARS) {
  if (typeof text !== 'string') {
    return '';
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... [ĐÃ CẮT BỚT DO VƯỢT QUÁ GIỚI HẠN AN TOÀN ${maxChars} KÝ TỰ] ...`;
}

/**
 * Thu thập kết quả chạy `npm test`, `git diff HEAD -- src/ tests/` và danh sách/nội dung file mới
 * trong `src/` và `tests/`. Tuyệt đối KHÔNG gửi kèm code của `.agents/` vào gói review.
 *
 * @param {string} [repoRoot=REPO_ROOT]
 * @returns {{
 *   gitStatus: string,
 *   gitDiff: string,
 *   newFilesList: string[],
 *   newFilesContent: string,
 *   fullBundleText: string,
 *   testEvidence: string,
 *   positiveTestExitCode: number
 * }}
 */
function collectReviewSnapshot(repoRoot = REPO_ROOT) {
  stageIntentToAdd(repoRoot, REVIEW_SCOPE);
  const scopeArgs = REVIEW_SCOPE.join(' ');
  let gitStatus = '';
  let gitDiff = '';
  let newFilesList = [];
  const newFilesBlocks = [];

  try {
    gitStatus = childProcess
      .execSync(`git status --short -- ${scopeArgs}`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .trim();
  } catch (err) {
    gitStatus = `[Không thể chạy git status: ${err.message}]`;
  }

  try {
    gitDiff = childProcess
      .execSync(`git diff HEAD -- ${scopeArgs}`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .trim();
  } catch (_err) {
    try {
      gitDiff = childProcess
        .execSync(`git diff -- ${scopeArgs}`, {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        .trim();
    } catch (innerErr) {
      gitDiff = `[Không thể chạy git diff: ${innerErr.message}]`;
    }
  }

  try {
    const untrackedRaw = childProcess
      .execSync(`git ls-files --others --exclude-standard -- ${scopeArgs}`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .trim();
    if (untrackedRaw) {
      newFilesList = untrackedRaw
        .split(/\r?\n/)
        .map((f) => f.trim())
        .filter((f) => f && !f.startsWith('.agents/'));
      for (const relPath of newFilesList) {
        const fullPath = path.join(repoRoot, relPath);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const content = fs.readFileSync(fullPath, 'utf8');
          newFilesBlocks.push(`=== FILE MỚI: ${relPath} ===\n${content}`);
        }
      }
    }
  } catch (_err) {
    // Bỏ qua nếu không lấy được untracked files
  }

  // Thực thi trực tiếp lệnh `npm test`
  const testOptions = {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 240_000,
    windowsHide: true,
  };
  const npmTestRes =
    process.platform === 'win32'
      ? childProcess.spawnSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', TEST_COMMAND],
          testOptions
        )
      : childProcess.spawnSync('sh', ['-c', TEST_COMMAND], testOptions);

  const positiveTestExitCode =
    !npmTestRes.error && npmTestRes.signal === null && npmTestRes.status === 0
      ? 0
      : 1;

  const testEvidence = [
    `Exit Code: ${npmTestRes.status} (signal: ${npmTestRes.signal}, error: ${npmTestRes.error || 'none'})`,
    'Stdout:',
    (npmTestRes.stdout || '').trim(),
    'Stderr:',
    (npmTestRes.stderr || '(trống)').trim(),
  ].join('\n');

  const newFilesContent = newFilesBlocks.join('\n\n');
  const fullBundleText = [
    '=== KẾT QUẢ CHẠY NPM TEST ===',
    testEvidence,
    '',
    '=== GIT STATUS (src/ tests/) ===',
    gitStatus || '(Không có thay đổi)',
    '',
    '=== DANH SÁCH FILE MỚI TRONG src/ tests/ ===',
    newFilesList.length > 0 ? newFilesList.join('\n') : '(Không có file mới)',
    '',
    '=== GIT DIFF HEAD -- src/ tests/ ===',
    gitDiff || '(Không có diff)',
    '',
    newFilesContent ? `=== NỘI DUNG FILE MỚI (src/ tests/) ===\n${newFilesContent}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    gitStatus: gitStatus || '(Không có thay đổi trong src/ và tests/)',
    gitDiff: gitDiff || '(Không có khác biệt git diff trong src/ và tests/)',
    newFilesList,
    newFilesContent,
    fullBundleText,
    testEvidence,
    positiveTestExitCode,
  };
}

/**
 * Xây dựng nội dung prompt gửi cho ChatGPT Mentor tùy theo chế độ `--mode <plan|review-code|rescue>`.
 * Ở chế độ `--mode review-code`, chỉ gửi kết quả chạy `npm test` + `git diff HEAD -- src/ tests/`
 * (kèm danh sách file mới trong `src/`, `tests/`). Tuyệt đối KHÔNG gửi kèm code của `.agents/`.
 *
 * @param {'plan' | 'review-code' | 'rescue'} mode
 * @param {string} planContent
 * @param {string} errorSummary
 * @param {string} [bootstrapBlock='']
 * @param {ReturnType<typeof collectReviewSnapshot> | null} [snapshot=null]
 * @returns {{ prompt: string, positiveTestExitCode: number }}
 */
function buildMentorPrompt(
  mode,
  planContent,
  errorSummary,
  bootstrapBlock = '',
  snapshot = null,
  selectedRoles = []
) {
  let corePrompt = '';
  const positiveTestExitCode = snapshot ? snapshot.positiveTestExitCode : 0;

  if (mode === 'plan') {
    corePrompt = [
      'Bạn là ChatGPT Mentor đánh giá thiết kế kỹ thuật theo quy trình RPIR.',
      'Hãy review chi tiết kế hoạch dưới đây và phản hồi với dòng đầu tiên bắt buộc là:',
      '`STATUS: APPROVED` (nếu kế hoạch đạt yêu cầu, cho phép triển khai code)',
      'hoặc `STATUS: REJECTED` (nếu cần sửa đổi, kèm các điểm cần khắc phục chi tiết).',
      '',
      '--- BẮT ĐẦU CURRENT_PLAN.md ---',
      planContent,
      '--- KẾT THÚC CURRENT_PLAN.md ---',
    ].join('\n');
  } else if (mode === 'review-code') {
    const { gitStatus, gitDiff, newFilesList, newFilesContent, testEvidence } = snapshot;
    const inlineDiff = truncateSafely(gitDiff, MAX_INLINE_CODE_CHARS);
    const inlineNewFiles = newFilesContent
      ? truncateSafely(newFilesContent, MAX_INLINE_CODE_CHARS)
      : '';

    corePrompt = [
      'Bạn là ChatGPT Mentor thực hiện bước Review Code trong quy trình RPIR.',
      'Hãy kiểm tra kết quả chạy `npm test` và thay đổi mã nguồn ứng dụng (`git diff HEAD -- src/ tests/` kèm các file mới trong `src/`, `tests/`).',
      'Yêu cầu bắt buộc ở dòng đầu tiên của phản hồi:',
      '- Ghi rõ `CODE_STATUS: APPROVED` nếu code và test đạt yêu cầu.',
      '- Ghi rõ `CODE_STATUS: REJECTED` nếu có lỗi cần khắc phục.',
      '',
      '--- KẾT QUẢ CHẠY NPM TEST ---',
      testEvidence,
      '--- KẾT THÚC NPM TEST ---',
      '',
      '--- GIT STATUS (src/ tests/) ---',
      gitStatus,
      '--- DANH SÁCH FILE MỚI (src/ tests/) ---',
      newFilesList.length > 0 ? newFilesList.join('\n') : '(Không có file mới)',
      '',
      '--- GIT DIFF HEAD -- src/ tests/ ---',
      inlineDiff,
      '--- KẾT THÚC GIT DIFF ---',
      inlineNewFiles
        ? `\n--- NỘI DUNG FILE MỚI (src/ tests/) ---\n${inlineNewFiles}\n--- KẾT THÚC FILE MỚI ---`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  } else {
    const { gitStatus, gitDiff, testEvidence } = snapshot;
    const safeError =
      errorSummary ||
      'Thử nghiệm / chạy kiểm thử thất bại quá 3 lần liên tiếp (Circuit Breaker kích hoạt).';

    corePrompt = [
      'Bạn là ChatGPT Mentor hỗ trợ gỡ bế tắc kỹ thuật (RESCUE MODE - Circuit Breaker) trong quy trình RPIR.',
      'Yêu cầu mở đầu phản hồi bằng dòng: `STATUS: REJECTED` kèm hướng dẫn khắc phục cụ thể.',
      '',
      '--- TÓM TẮT LỖI (ERROR SUMMARY) ---',
      safeError,
      '--- KẾT QUẢ NPM TEST ---',
      testEvidence,
      '--- GIT STATUS (src/ tests/) ---',
      gitStatus,
      '--- GIT DIFF HEAD -- src/ tests/ ---',
      truncateSafely(gitDiff, MAX_INLINE_CODE_CHARS),
    ].join('\n');
  }

  const roleHeader = buildRoleHeader(selectedRoles);
  const sections = [roleHeader, bootstrapBlock, corePrompt].filter(Boolean);
  const prompt = sections.join('\n\n');
  return { prompt, positiveTestExitCode };
}

/**
 * Tự động tìm kiếm dự án trên thanh sidebar của ChatGPT theo tên (`projectName`).
 * Nếu tìm thấy, điều hướng vào dự án đó và lưu URL dạng `https://chatgpt.com/g/g-p-...` vào `SESSION_MAP.json`.
 * Nếu chưa có, thử tìm nút tạo Dự án mới với tên đó.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} projectName
 * @param {{ projectName?: string, projectUrl: string, currentTask: string, threads: Record<string, { url: string, updatedAt: string }> }} sessionMap
 * @returns {Promise<string>}
 */
async function ensureProjectUrl(page, sessionMap, projectName = DEFAULT_PROJECT_NAME) {
  const currentProjectUrl = (sessionMap?.projectUrl || '').trim();
  if (/^https:\/\/chatgpt\.com\/g\/g-p-[a-z0-9]+/i.test(currentProjectUrl)) {
    return currentProjectUrl;
  }

  const targetName = (projectName || sessionMap?.projectName || DEFAULT_PROJECT_NAME).trim();
  console.log(`[PROJECT RESOLUTION]: Đang tìm kiếm dự án "${targetName}" trên giao diện ChatGPT...`);

  try {
    const foundHref = await page.evaluate((name) => {
      const candidates = Array.from(
        document.querySelectorAll(
          'nav a, [role="navigation"] a, a[href*="/g/g-p-"], [role="link"], [role="group"] a, [role="listitem"] a'
        )
      );
      for (const el of candidates) {
        const text = (el.innerText || '').trim();
        const ariaLabel = (el.getAttribute('aria-label') || '').trim();
        const combined = `${text} ${ariaLabel}`.toLowerCase();
        if (
          combined.includes(name.toLowerCase()) &&
          el.href &&
          el.href.startsWith('https://chatgpt.com/g/g-p-')
        ) {
          return el.href;
        }
      }
      return null;
    }, targetName);

    if (foundHref) {
      console.log(`[PROJECT RESOLUTION]: Đã tìm thấy dự án "${targetName}" tại: ${foundHref}`);
      if (!page.url().startsWith(foundHref)) {
        await page.goto(foundHref, { waitUntil: 'domcontentloaded' });
        await sleep(2000);
      }
      if (sessionMap) {
        sessionMap.projectUrl = foundHref;
        sessionMap.projectName = targetName;
        saveSessionMap(sessionMap);
      }
      return foundHref;
    }

    // Thử click vào phần tử trên sidebar có text hoặc aria-label chứa tên project
    const projectLocator = page
      .locator(
        `nav a:has-text("${targetName}"), [role="navigation"] a:has-text("${targetName}"), a[aria-label*="${targetName}" i]`
      )
      .first();
    if (await projectLocator.isVisible().catch(() => false)) {
      console.log(`[PROJECT RESOLUTION]: Click vào link dự án "${targetName}" trên sidebar...`);
      await projectLocator.click();
      await page.waitForURL(/\/g\/g-p-/i, { timeout: 10_000 }).catch(() => {});
      await sleep(1500);
      const newUrl = page.url();
      if (/\/g\/g-p-/i.test(newUrl)) {
        if (sessionMap) {
          sessionMap.projectUrl = newUrl;
          sessionMap.projectName = targetName;
          saveSessionMap(sessionMap);
        }
        return newUrl;
      }
    }
  } catch (err) {
    console.log(`[PROJECT RESOLUTION NOTE]: Không thể tìm dự án: ${err.message}`);
  }

  return sessionMap?.projectUrl || DEFAULT_PROJECT_URL;
}

const resolveProjectUrl = ensureProjectUrl;

/**
 * Điều hướng tab ChatGPT tới luồng chat của Task hiện tại (nếu đã có URL trong `SESSION_MAP.json`),
 * hoặc tự động coi `effectiveNewThread = true` (mở phiên mới + gắn Bootstrap) nếu `task_id` chưa có URL
 * trong `SESSION_MAP.json` hoặc khi người dùng truyền cờ `--new-thread`.
 *
 * QUY TẮC QUAN TRỌNG: Khi effectiveNewThread === true, TUYỆT ĐỐI KHÔNG bấm nút "Trò chuyện mới" (a[href="/"])
 * ở góc trái vì sẽ đẩy chat ra ngoài Project. Thay vào đó, gọi await page.goto(sessionMap.projectUrl)
 * và gõ thẳng vào ô composer ở giữa màn hình của Project AI-WORKSPACE.
 *
 * @param {import('playwright-core').Page} page
 * @param {{ existingThreadUrl: string, isNewThread: boolean, projectUrl: string, model: string, projectName?: string, sessionMap?: any }} options
 * @returns {Promise<{ previousConversationId: string, effectiveNewThread: boolean }>}
 */
async function prepareTaskThread(
  page,
  { existingThreadUrl, isNewThread, projectUrl, model, projectName, sessionMap }
) {
  // 1. Đảm bảo projectUrl trỏ đúng vào Project ChatGPT (/g/g-p-...)
  const targetProjectUrl = await ensureProjectUrl(
    page,
    sessionMap,
    projectName || sessionMap?.projectName || DEFAULT_PROJECT_NAME
  );

  const normalizedExistingUrl =
    typeof existingThreadUrl === 'string' ? existingThreadUrl.trim() : '';
  const effectiveNewThread = Boolean(isNewThread || !normalizedExistingUrl);

  const currentUrl = page.url();
  const prevMatch = currentUrl.match(CONVERSATION_URL_REGEX);
  const previousConversationId = prevMatch ? prevMatch[1] : '';

  // 2. Tiếp tục luồng chat hiện có nếu không phải tạo thread mới
  if (!effectiveNewThread && normalizedExistingUrl) {
    const expectedConvMatch = normalizedExistingUrl.match(CONVERSATION_URL_REGEX);
    const expectedConvId = expectedConvMatch ? expectedConvMatch[1] : '';
    if (!currentUrl.startsWith(normalizedExistingUrl)) {
      await page.goto(normalizedExistingUrl, { waitUntil: 'domcontentloaded' });
      await sleep(1500);
    }
    const landedUrl = page.url();
    if (!expectedConvId || landedUrl.includes(expectedConvId)) {
      return { previousConversationId, effectiveNewThread: false };
    }
    console.log(
      `[DEAD THREAD RECOVERY]: Luồng chat cũ (${expectedConvId}) đã bị xóa hoặc chuyển hướng (${landedUrl}). Tự động tạo luồng mới trong Project...`
    );
  }

  // 3. Khởi tạo luồng chat mới (effectiveNewThread === true):
  // TUYỆT ĐỐI KHÔNG bấm nút "Trò chuyện mới" (a[href="/"]) vì sẽ đẩy chat ra ngoài Project.
  // Thay vào đó: điều hướng thẳng vào Project URL (/g/g-p-.../project), ChatGPT sẽ hiển thị ô composer ở giữa
  // và tự động tạo luồng chat mới nằm gọn trong Project khi gửi prompt!
  console.log(`[TASK THREAD]: Khởi tạo luồng chat mới trong Project: ${targetProjectUrl}`);
  await page.goto(targetProjectUrl, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  return { previousConversationId, effectiveNewThread: true };
}

/**
 * Chờ URL trình duyệt chuyển sang dạng `/c/[a-z0-9-]+` (hoặc `/g/.../c/[a-z0-9-]+`)
 * sau khi gửi tin nhắn đầu tiên của Task mới và trả về URL hội thoại.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} previousConversationId
 * @param {boolean} isNewThread
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<string>}
 */
async function waitForConversationUrl(
  page,
  previousConversationId,
  isNewThread,
  timeoutMs = 30_000
) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const currentUrl = page.url();
    const match = currentUrl.match(CONVERSATION_URL_REGEX);
    if (match) {
      const currentConvId = match[1];
      if (
        !isNewThread ||
        !previousConversationId ||
        currentConvId !== previousConversationId
      ) {
        return currentUrl;
      }
    }
    await sleep(300);
  }
  return page.url();
}

/**
 * Điền văn bản lớn vào ô ProseMirror tức thì (< 1s) mà vẫn giữ nguyên 100% xuống dòng (\n) và khoảng trắng,
 * tránh việc tạo hàng nghìn node <p> riêng lẻ làm treo bộ bố cục của ProseMirror.
 *
 * @param {import('playwright-core').Locator} promptTextarea
 * @param {string} text
 * @returns {Promise<void>}
 */
/**
 * Cơ chế kích hoạt Custom GPT / Plugin trên ChatGPT (`tryInvokeGptMention`):
 * Nếu trong `.agents/config.json` có bật `"useGptMention": true`, thử gõ `@<Tên_Plugin>` vào ô chat,
 * đợi 1000ms nếu có menu popup `[role="option"]` chứa tên Plugin thì nhấn `Enter` để chọn;
 * nếu không có (do đang ở trong ChatGPT Project giới hạn `@mention`) thì tự động xóa chuỗi `@...` và đi tiếp, không báo lỗi.
 *
 * @param {import('playwright-core').Page} page
 * @param {import('playwright-core').Locator} promptTextarea
 * @param {Array<{ key: string, name: string, description: string }>} selectedRoles
 * @returns {Promise<boolean>}
 */
async function tryInvokeGptMention(page, promptTextarea, selectedRoles) {
  if (
    !WORKFLOW_CONFIG.useGptMention ||
    !Array.isArray(selectedRoles) ||
    selectedRoles.length === 0
  ) {
    return false;
  }

  const pluginName = selectedRoles[0].name;
  try {
    await promptTextarea.click();
    await page.keyboard.type(`@${pluginName}`, { delay: 15 });
    await sleep(1000);

    const popupOption = page
      .locator('[role="option"], [role="menuitem"]')
      .filter({ hasText: pluginName })
      .first();

    if (await popupOption.isVisible().catch(() => false)) {
      await page.keyboard.press('Enter');
      await sleep(300);
      console.log(`[ROLE MENTION]: Đã kích hoạt "@${pluginName}" qua menu @mention.`);
      return true;
    }

    // Nếu không có menu popup (ví dụ trong ChatGPT Project giới hạn @mention) -> xóa chuỗi @... và đi tiếp
    await promptTextarea.evaluate((el) => {
      el.focus();
      el.replaceChildren(document.createElement('p'));
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteContentBackward',
        })
      );
    });
    return false;
  } catch (_err) {
    await promptTextarea
      .evaluate((el) => {
        el.replaceChildren(document.createElement('p'));
      })
      .catch(() => {});
    return false;
  }
}

async function fillPromptFast(promptTextarea, text) {
  await promptTextarea.click();
  await promptTextarea.evaluate((el, rawText) => {
    el.focus();
    const pEl = document.createElement('p');
    const lines = rawText.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (i > 0) {
        pEl.appendChild(document.createElement('br'));
      }
      pEl.appendChild(document.createTextNode(lines[i]));
    }
    el.replaceChildren(pEl);
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
      })
    );
  }, text);
}

/**
 * Tự động điều chỉnh mức độ suy luận (Thinking / Reasoning Effort) trên thanh công cụ khung chat ChatGPT:
 * - Hỗ trợ tham số `--effort <high|standard>`.
 * - Nếu không truyền `explicitEffort`, mặc định `high` ("Cao") cho `--mode plan` và `--mode rescue`,
 *   mặc định `standard` ("Chuẩn" / "Trung bình" / "Standard") cho `--mode review-code`.
 * - Trước khi gửi tin nhắn, tìm nút chọn mức suy luận cạnh khung chat (đang hiển thị `Cao`, `Chuẩn`, `High`, `Standard`, `Medium`, `Vừa`, `Thấp`, `Low`),
 *   nếu khác mức mục tiêu thì click mở menu và chọn mức tương ứng.
 * - Bọc trong `try/catch` an toàn: nếu giao diện không có nút này thì bỏ qua không báo lỗi.
 *
 * @param {import('playwright-core').Page} page
 * @param {'plan' | 'review-code' | 'rescue'} [mode='plan']
 * @param {string} [explicitEffort='']
 * @returns {Promise<void>}
 */
export async function setThinkingEffort(page, mode = 'plan', explicitEffort = '') {
  const normExplicit = normalizeEffort(explicitEffort);
  const targetEffort =
    normExplicit || (mode === 'review-code' ? 'standard' : 'high');
  const targetLabelRegex =
    targetEffort === 'standard'
      ? /(?:^|\s|\n)(Chuẩn|Trung bình|Vừa|Standard|Medium)(?:$|\s|\n)/i
      : /(?:^|\s|\n)(Cao|High)(?:$|\s|\n)/i;
  const anyEffortButtonRegex =
    /(?:^|\s|\n)(Cao|Chuẩn|Trung bình|Vừa|Thấp|High|Standard|Medium|Low)(?:$|\s|\n)/i;

  let menuOpened = false;
  try {
    const reasoningButton = page
      .locator(
        'button[aria-label*="mô hình" i], button[aria-label*="model" i], button[aria-label*="suy luận" i], button[aria-label*="reasoning" i], button[aria-label*="thinking" i], button[aria-label*="effort" i], form button, [data-testid*="composer"] button'
      )
      .filter({
        hasText: anyEffortButtonRegex,
      })
      .first();

    const isVisible = await reasoningButton.isVisible().catch(() => false);
    if (!isVisible) {
      return;
    }

    const buttonText = (await reasoningButton.innerText().catch(() => '')).trim();
    if (targetLabelRegex.test(buttonText)) {
      return;
    }

    await reasoningButton.click({ timeout: 5_000 });
    menuOpened = true;

    const menuItems = page.locator(
      '[role="menuitem"], [role="menuitemradio"], [role="option"]'
    );
    await menuItems.first().waitFor({ state: 'visible', timeout: 5_000 });

    const targetOption = menuItems
      .filter({
        hasText: targetLabelRegex,
      })
      .first();

    if (await targetOption.isVisible().catch(() => false)) {
      await targetOption.click({ timeout: 5_000 });
      menuOpened = false;
      console.log(
        `[THINKING EFFORT]: Đã chuyển mức suy luận sang "${targetEffort}".`
      );
      await sleep(300);
    } else {
      await page.keyboard.press('Escape').catch(() => {});
      menuOpened = false;
    }
  } catch (_err) {
    await page.keyboard.press('Escape').catch(() => {});
    menuOpened = false;
  }
}

async function ensureHighReasoning(page) {
  return setThinkingEffort(page, 'plan', 'high');
}

/**
 * Đính kèm tệp snapshot toàn bộ mã nguồn (review_bundle.txt) vào khung soạn thảo ChatGPT.
 * Bắt buộc xác minh thành công trước khi gửi prompt theo nguyên tắc Fail-closed (BLOCKER 02 & 04).
 *
 * @param {import('playwright-core').Page} page
 * @param {string} bundlePath
 * @param {number} [timeoutMs=15000]
 * @returns {Promise<boolean>}
 */
export async function attachReviewBundle(page, bundlePath, timeoutMs = 15_000) {
  if (!fs.existsSync(bundlePath)) {
    console.error(`[ATTACHMENT ERROR]: File bundle không tồn tại: ${bundlePath}`);
    return false;
  }

  if (!page || typeof page.evaluate !== 'function' || typeof page.locator !== 'function') {
    console.error('[ATTACHMENT ERROR]: Đối tượng page không hợp lệ hoặc thiếu phương thức evaluate/locator!');
    return false;
  }

  // BLOCKER 03 (FIX-03): Xác định composer đang hoạt động trước (Fail-Closed, không fallback sang document.body)
  // Nếu không tìm thấy hoặc xác định được nhiều hơn 1 composer không phân biệt được -> từ chối (false)
  const composerCheck = await page
    .evaluate(() => {
      try {
        const editors = document.querySelectorAll(
          '#prompt-textarea, [data-testid="prompt-textarea"], textarea, div.ProseMirror, [contenteditable="true"][role="textbox"], [role="textbox"], [contenteditable="true"]'
        );
        const composers = new Set();
        for (let i = 0; i < editors.length; i++) {
          const c = editors[i].closest('form, [data-testid*="composer"]');
          if (c) composers.add(c);
        }
        if (composers.size === 0) {
          const sendBtns = document.querySelectorAll(
            'button[data-testid="send-button"], button[aria-label*="gửi" i], button[aria-label*="send" i]'
          );
          for (let i = 0; i < sendBtns.length; i++) {
            const c = sendBtns[i].closest('form, [data-testid*="composer"]');
            if (c) composers.add(c);
          }
        }
        return composers.size === 1;
      } catch (_e) {
        return false;
      }
    })
    .catch(() => false);

  if (composerCheck === false) {
    console.error('[ATTACHMENT ERROR]: Không tìm thấy composer hợp lệ hoặc có nhiều hơn 1 composer trên trang!');
    return false;
  }

  const composerSelector =
    'form:has(#prompt-textarea), [data-testid*="composer"]:has(#prompt-textarea), form:has([data-testid="prompt-textarea"]), form:has([role="textbox"]), form:has(.ProseMirror), form:has([contenteditable="true"]), form:has(button[data-testid="send-button"])';

  const activeComposer = page.locator(composerSelector).first();
  const rawInputSelector =
    'input[type="file"][aria-label*="tệp" i], input[type="file"][aria-label*="file" i], input[type="file"]:not([accept*="image"])';

  const fileInput =
    activeComposer && typeof activeComposer.locator === 'function'
      ? activeComposer.locator(rawInputSelector).first()
      : page.locator(rawInputSelector).first();

  const count = await fileInput.count().catch(() => 0);
  if (count === 0) {
    console.error('[ATTACHMENT ERROR]: Không tìm thấy phần tử input[type="file"] trên giao diện ChatGPT!');
    return false;
  }

  const baseName = path.basename(bundlePath);
  console.log(`[ATTACHMENT]: Đang đính kèm file bundle (${baseName})...`);

  try {
    await fileInput.setInputFiles(bundlePath);

    // BLOCKER 03 (FIX-03): Attachment pill bắt buộc giới hạn phạm vi tra cứu bên trong active composer
    const rawPillSelector = [
      `[aria-label*="${baseName}" i]`,
      `[title*="${baseName}" i]`,
      `[data-testid*="attachment"]:has-text("${baseName}")`,
      `[class*="attachment"]:has-text("${baseName}")`,
    ].join(', ');

    const attachmentPill =
      activeComposer && typeof activeComposer.locator === 'function'
        ? activeComposer.locator(rawPillSelector).first()
        : page.locator(rawPillSelector).first();

    const waitStart = Date.now();
    let isAttached = false;

    while (Date.now() - waitStart < timeoutMs) {
      // 1. Kiểm tra alert báo lỗi tải file nếu có
      const uiError = await page
        .evaluate(() => {
          const errEl = document.querySelector(
            '[role="alert"], [class*="text-token-text-error"], [class*="text-red-"]'
          );
          return errEl ? (errEl.innerText || '').trim() : null;
        })
        .catch(() => null);

      if (uiError && /(lỗi|error|failed|không thể tải|quá lớn|dung lượng)/i.test(uiError)) {
        console.error(`[ATTACHMENT ERROR]: Giao diện ChatGPT báo lỗi tải tệp: "${uiError}"`);
        return false;
      }

      // 2. Kiểm tra attachment pill đã hiển thị và hoàn tất upload trong composer (Standard DOM query, Fail-closed)
      const isVisible = await attachmentPill.isVisible().catch(() => false);
      if (isVisible) {
        const uploadState = await page
          .evaluate((name) => {
            try {
              const lowerName = name.toLowerCase();

              // BLOCKER 03 (FIX-03): Xác định composer đang hoạt động duy nhất
              // FAIL-CLOSED: Tuyệt đối KHÔNG fallback sang document.body!
              const editors = document.querySelectorAll(
                '#prompt-textarea, [data-testid="prompt-textarea"], textarea, div.ProseMirror, [contenteditable="true"][role="textbox"], [role="textbox"], [contenteditable="true"]'
              );
              const composers = new Set();
              for (let i = 0; i < editors.length; i++) {
                const c = editors[i].closest('form, [data-testid*="composer"]');
                if (c) {
                  composers.add(c);
                }
              }
              if (composers.size === 0) {
                const sendBtns = document.querySelectorAll(
                  'button[data-testid="send-button"], button[aria-label*="gửi" i], button[aria-label*="send" i]'
                );
                for (let i = 0; i < sendBtns.length; i++) {
                  const c = sendBtns[i].closest('form, [data-testid*="composer"]');
                  if (c) {
                    composers.add(c);
                  }
                }
              }

              // Nếu không tìm thấy hoặc có nhiều hơn 1 composer mà không phân biệt được -> Fail-closed!
              if (composers.size !== 1) {
                return { found: false, uploading: false, noValidComposer: true };
              }

              const composer = Array.from(composers)[0];

              // CHỈ tra cứu attachment pill bên trong composer này
              const matches = [];
              const allElements = composer.querySelectorAll('*');
              for (let i = 0; i < allElements.length; i++) {
                const el = allElements[i];
                const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                const title = (el.getAttribute('title') || '').toLowerCase();
                let text = '';
                if (el.childNodes && el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) {
                  text = el.childNodes[0].nodeValue || '';
                }
                if (
                  ariaLabel.includes(lowerName) ||
                  title.includes(lowerName) ||
                  text.includes(name)
                ) {
                  matches.push(el);
                }
              }

              if (matches.length === 0) {
                return { found: false, uploading: true };
              }

              for (const el of matches) {
                const container =
                  el.closest('[data-testid*="attachment"], [class*="attachment"]') ||
                  el.parentElement ||
                  el;
                const spinner = container.querySelector(
                  '[role="progressbar"], svg.animate-spin, [class*="progress"], [class*="loading"], [class*="spinner"]'
                );
                if (spinner) {
                  return { found: true, uploading: true };
                }
              }

              return { found: true, uploading: false };
            } catch (_evalErr) {
              return { found: false, uploading: true };
            }
          }, baseName)
          .catch(() => ({ found: false, uploading: true }));

        // BLOCKER 05 & FIX-03: Fail-closed tuyệt đối — CHỈ chấp nhận khi found === true VÀ uploading === false
        // Tuyệt đối không chấp nhận null, undefined hoặc cấu trúc không xác định!
        const isUploadDone = Boolean(
          uploadState &&
          typeof uploadState === 'object' &&
          uploadState.found === true &&
          uploadState.uploading === false
        );

        if (isUploadDone) {
          isAttached = true;
          break;
        }
      }

      await sleep(500);
    }

    if (!isAttached) {
      console.error(
        `[ATTACHMENT TIMEOUT]: Đã gọi setInputFiles("${baseName}") nhưng giao diện không xác nhận attachment sau ${timeoutMs}ms!`
      );
      return false;
    }

    console.log(`[ATTACHMENT CONFIRMED]: Tệp "${baseName}" đã được tải lên và xác nhận thành công trên giao diện.`);
    return true;
  } catch (err) {
    console.error(`[ATTACHMENT ERROR]: Lỗi ngoại lệ khi đính kèm file: ${err.message}`);
    return false;
  }
}

/**
 * Đếm số lượng khối tin nhắn của Assistant và trích xuất nội dung tin nhắn cuối cùng.
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{ userCount: number, count: number, lastText: string }>}
 */
async function getAssistantState(page) {
  return page.evaluate(() => {
    const userRoots = Array.from(
      document.querySelectorAll(
        '[data-message-author-role="user"], [class*="bg-user-message"], [data-markdown-text-tone="user-message"], [class*="rich-text-user-turn"]'
      )
    );

    const assistantTurns = Array.from(
      document.querySelectorAll(
        '[data-message-author-role="assistant"], [data-dil-response], [class*="DilResponseRoot"], article[data-turn="assistant"]'
      )
    );

    let chosen = null;
    let lastText = '';

    if (assistantTurns.length > 0) {
      chosen = assistantTurns[assistantTurns.length - 1];
      lastText = (chosen.innerText || '').trim();
    } else {
      const fallbackNodes = Array.from(
        document.querySelectorAll('[class*="MarkdownRoot"]')
      ).filter((el) => {
        const text = (el.innerText || '').trim();
        return (
          !el.className.includes('rich-text-user-turn') &&
          !el.closest('[class*="bg-user-message"]') &&
          /(?:CODE_STATUS|STATUS)\s*:\s*(?:APPROVED|REJECTED)/i.test(text)
        );
      });
      if (fallbackNodes.length > 0) {
        chosen = fallbackNodes[fallbackNodes.length - 1];
        lastText = (chosen.innerText || '').trim();
      }
    }

    return {
      userCount: userRoots.length,
      count: assistantTurns.length > 0 ? assistantTurns.length : (chosen ? 1 : 0),
      lastText,
    };
  });
}

/**
 * Đợi cho đến khi nút `[data-testid="stop-button"]` biến mất
 * và nội dung tin nhắn cuối cùng của `[data-message-author-role="assistant"]` ổn định.
 * Bắt buộc tin nhắn phản hồi phải thuộc lượt gửi mới (count > previousAssistantCount).
 *
 * @param {import('playwright-core').Page} page
 * @param {number} previousUserCount
 * @param {number} previousAssistantCount
 * @param {number} [timeoutMs=600000]
 * @param {string} [mode='plan']
 * @returns {Promise<string>}
 */
async function waitForStableAssistantResponse(
  page,
  previousUserCount,
  previousAssistantCount,
  timeoutMs = 600_000,
  mode = 'plan'
) {
  const startTime = Date.now();
  const stopButtonLocator = page.locator(STOP_BUTTON_SELECTOR);

  // 1. Chờ tin nhắn phản hồi mới bắt đầu sinh hoặc nút stop-button xuất hiện
  while (Date.now() - startTime < timeoutMs) {
    const { userCount, count } = await getAssistantState(page).catch(() => ({
      userCount: 0,
      count: 0,
      lastText: '',
    }));
    const isGenerating = (await stopButtonLocator.count().catch(() => 0)) > 0;
    if (
      isGenerating ||
      (userCount > previousUserCount && count > previousAssistantCount) ||
      count > previousAssistantCount
    ) {
      break;
    }
    await sleep(500);
  }

  // 2. Chờ nút stop-button biến mất và nội dung ổn định liên tiếp
  let lastText = '';
  let stableTicks = 0;
  const requiredStableTicks = 3;

  while (Date.now() - startTime < timeoutMs) {
    const stopVisible = (await stopButtonLocator.count().catch(() => 0)) > 0;
    const { count, lastText: currentText } = await getAssistantState(page).catch(
      () => ({ userCount: 0, count: 0, lastText: '' })
    );

    // BLOCKER 03: Ở mode review-code, chỉ chấp nhận CODE_STATUS ở dòng đầu. Ở plan/rescue chấp nhận STATUS.
    const firstLine = (currentText.trim().split(/\r?\n/)[0] || '').trim();
    const hasStatus =
      mode === 'review-code'
        ? /^CODE_STATUS\s*:\s*(?:APPROVED|REJECTED)\b/i.test(firstLine)
        : /^(?:STATUS|CODE_STATUS)\s*:\s*(?:APPROVED|REJECTED)\b/i.test(firstLine);

    // BẮT BUỘC count > previousAssistantCount: Thuộc lượt Assistant mới sinh, không dùng lại phản hồi cũ
    if (!stopVisible && count > previousAssistantCount && hasStatus) {
      if (currentText.length > 0 && currentText === lastText) {
        stableTicks += 1;
        if (stableTicks >= requiredStableTicks) {
          return currentText;
        }
      } else {
        lastText = currentText;
        stableTicks = 0;
      }
    } else {
      stableTicks = 0;
    }

    await sleep(1000);
  }

  throw new Error(
    `Hết thời gian chờ (${timeoutMs}ms) nhưng phản hồi của ChatGPT Mentor chưa hoàn tất.`
  );
}

/**
 * Xác định trạng thái phê duyệt (`APPROVED` hoặc `REJECTED`) từ phản hồi của Mentor.
 * BLOCKER 03: Ở review-code, chỉ chấp nhận đúng dòng đầu `CODE_STATUS: APPROVED`.
 *
 * @param {string} feedbackText
 * @param {string} [mode='plan']
 * @returns {'APPROVED' | 'REJECTED'}
 */
function detectApprovalStatus(feedbackText, mode = 'plan') {
  if (typeof feedbackText !== 'string') {
    return 'REJECTED';
  }
  const lines = feedbackText.trim().split(/\r?\n/);
  const firstLine = (lines[0] || '').trim();
  if (mode === 'review-code') {
    if (/^CODE_STATUS:\s*APPROVED\b/i.test(firstLine)) {
      return 'APPROVED';
    }
    return 'REJECTED';
  }
  if (/^STATUS:\s*APPROVED\b/i.test(firstLine)) {
    return 'APPROVED';
  }
  return 'REJECTED';
}

/**
 * Kết nối CDP tới URL chỉ định, tự động fallback sang WebSocket từ `DevToolsActivePort`
 * nếu Chrome 136+ trả về 404 tại `/json/version/`.
 *
 * @param {string} cdpUrl
 * @returns {Promise<import('playwright-core').Browser>}
 */
async function connectCdpEndpoint(cdpUrl) {
  try {
    return await chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    const portMatch = String(cdpUrl).match(/:(\d+)/);
    const targetPort = portMatch ? portMatch[1] : '9222';
    const homeDir = os.homedir();
    const localAppData =
      process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const candidateFiles = [
      path.join(localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'),
      path.join(homeDir, '.chrome-mentor-profile', 'DevToolsActivePort'),
      path.join(homeDir, '.chrome-gemini-profile', 'DevToolsActivePort'),
    ];

    for (const filePath of candidateFiles) {
      try {
        if (!fs.existsSync(filePath)) continue;
        const lines = fs
          .readFileSync(filePath, 'utf8')
          .trim()
          .split(/\r?\n/);
        if (lines.length >= 2 && lines[0].trim() === targetPort) {
          const wsUrl = `ws://127.0.0.1:${targetPort}${lines[1].trim()}`;
          return await chromium.connectOverCDP(wsUrl);
        }
      } catch (_wsErr) {
        // Tiếp tục thử file tiếp theo
      }
    }
    throw err;
  }
}

/**
 * Kết nối trình duyệt qua CDP theo provider (`chatgpt` hoặc `gemini`):
 * - Nếu `provider === 'gemini'`, kết nối tới `config.geminiCdpUrl` (`9223`), nếu lỗi tự động fallback về `config.cdpUrl` (`9222`).
 * - Quét toàn bộ `browser.contexts()` và `context.pages()` để tìm tab chứa URL `gemini.google.com` (hoặc `chatgpt.com`).
 * - Nếu không tìm thấy, mở tab mới và điều hướng tới `sessionMap.geminiThreadUrl` hoặc trang chủ tương ứng.
 *
 * @param {'chatgpt' | 'gemini'} provider
 * @param {object} config
 * @param {object} sessionMap
 * @returns {Promise<{ browser: import('playwright-core').Browser, context: import('playwright-core').BrowserContext, page: import('playwright-core').Page }>}
 */
export async function connectProviderPage(
  provider,
  config = WORKFLOW_CONFIG,
  sessionMap = {},
  existingBrowser = null
) {
  const isGemini = provider === 'gemini';
  const primaryCdpUrl = isGemini
    ? config.geminiCdpUrl || DEFAULT_GEMINI_CDP_URL
    : config.cdpUrl || DEFAULT_CDP_URL;
  const fallbackCdpUrl = config.cdpUrl || DEFAULT_CDP_URL;

  let browser;
  try {
    browser = await connectCdpEndpoint(primaryCdpUrl);
  } catch (err) {
    if (isGemini && primaryCdpUrl !== fallbackCdpUrl) {
      if (existingBrowser) {
        console.warn(
          `[GEMINI CDP]: Không kết nối được ${primaryCdpUrl}, tái sử dụng phiên trình duyệt ${fallbackCdpUrl} hiện có...`
        );
        browser = existingBrowser;
      } else {
        console.warn(
          `[GEMINI CDP]: Không kết nối được ${primaryCdpUrl} (${err.message}), tự động fallback về ${fallbackCdpUrl}...`
        );
        browser = await connectCdpEndpoint(fallbackCdpUrl);
      }
    } else {
      throw err;
    }
  }

  const targetHost = isGemini ? 'gemini.google.com' : 'chatgpt.com';
  const preferredUrlPrefix = isGemini
    ? (sessionMap.geminiThreadUrl || '').trim()
    : (sessionMap.projectUrl || '').trim();
  const contexts = browser.contexts();
  let matchedContext = null;
  let matchedPage = null;

  for (const ctx of contexts) {
    const pages = ctx.pages();
    for (const p of pages) {
      const url = p.url();
      if (url.includes(targetHost)) {
        if (!matchedPage) {
          matchedContext = ctx;
          matchedPage = p;
        }
        if (preferredUrlPrefix && url.startsWith(preferredUrlPrefix)) {
          matchedContext = ctx;
          matchedPage = p;
          break;
        }
      }
    }
  }

  if (matchedPage) {
    await matchedPage.bringToFront().catch(() => {});
    return { browser, context: matchedContext, page: matchedPage };
  }

  const context =
    contexts.length > 0 ? contexts[0] : await browser.newContext();
  const page = await context.newPage();
  const targetUrl = isGemini
    ? sessionMap.geminiThreadUrl || DEFAULT_GEMINI_URL
    : sessionMap.projectUrl || DEFAULT_PROJECT_URL;

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  return { browser, context, page };
}

/**
 * Gửi prompt tới giao diện Gemini Web và lưu phản hồi vào `.agents/state/GEMINI_FEEDBACK.md`
 * kèm lưu `geminiThreadUrl` vào `SESSION_MAP.json`.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} promptText
 * @param {object} sessionMap
 * @returns {Promise<string>}
 */
export async function askGemini(page, promptText, sessionMap = {}) {
  const editorSelector = [
    'rich-textarea [role="textbox"][contenteditable="true"]',
    '[role="textbox"][contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    '[contenteditable="true"]',
  ].join(', ');

  const editor = page.locator(editorSelector).first();
  await editor.waitFor({ state: 'visible', timeout: 60_000 });
  await editor.click();

  await editor.evaluate((el, text) => {
    el.focus();
    el.textContent = '';
    const inserted =
      typeof document.execCommand === 'function'
        ? document.execCommand('insertText', false, String(text))
        : false;
    if (!inserted || !el.textContent) {
      el.textContent = String(text);
    }
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: String(text),
      })
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, promptText);

  await page.keyboard.press('Space');
  await sleep(300);

  const responseSelector = 'message-content, model-response';
  const previousCount = await page
    .locator(responseSelector)
    .count()
    .catch(() => 0);

  const sendButtonSelector = [
    'button[aria-label*="Gửi" i]',
    'button[aria-label*="Send" i]',
    'button.send-button',
  ].join(', ');
  const sendButton = page.locator(sendButtonSelector).first();
  const canClickSend = await sendButton
    .isVisible()
    .then(async (vis) => vis && (await sendButton.isEnabled().catch(() => true)))
    .catch(() => false);

  if (canClickSend) {
    await sendButton.click();
  } else {
    await editor.press('Enter');
  }

  const stopSelector = 'button[aria-label*="Dừng"], button[aria-label*="Stop"]';
  const stopLocator = page.locator(stopSelector);

  // Chờ Gemini bắt đầu sinh phản hồi (nút Stop xuất hiện hoặc số khối message-content tăng)
  const startWait = Date.now();
  while (Date.now() - startWait < 15_000) {
    const isStopping = (await stopLocator.count().catch(() => 0)) > 0;
    const currentCount = await page
      .locator(responseSelector)
      .count()
      .catch(() => 0);
    if (isStopping || currentCount > previousCount) {
      break;
    }
    await sleep(500);
  }

  // Đợi nút Dừng / Stop biến mất và nội dung từ message-content / model-response ổn định trong 3000ms
  const timeoutMs = 600_000;
  const pollStart = Date.now();
  let lastText = '';
  let stableSince = 0;

  while (Date.now() - pollStart < timeoutMs) {
    const stopVisible = await stopLocator
      .first()
      .isVisible()
      .catch(() => false);
    if (stopVisible) {
      stableSince = 0;
      await sleep(1000);
      continue;
    }

    const latestResponse = await page
      .evaluate(
        ({ sel, prevCount }) => {
          const nodes = Array.from(document.querySelectorAll(sel));
          if (nodes.length <= prevCount) return '';
          const lastNode = nodes[nodes.length - 1];
          return (lastNode.innerText || lastNode.textContent || '').trim();
        },
        { sel: responseSelector, prevCount: previousCount }
      )
      .catch(() => '');

    if (latestResponse) {
      if (latestResponse === lastText) {
        if (!stableSince) {
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 3000) {
          break;
        }
      } else {
        lastText = latestResponse;
        stableSince = Date.now();
      }
    }

    await sleep(1000);
  }

  if (!lastText) {
    throw new Error('Không lấy được nội dung phản hồi từ Gemini sau thời gian chờ.');
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(GEMINI_FEEDBACK_FILE, `${lastText}\n`, 'utf8');

  const currentUrl = page.url();
  if (currentUrl && currentUrl.includes('gemini.google.com')) {
    sessionMap.geminiThreadUrl = currentUrl;
    saveSessionMap(sessionMap);
  }

  console.log(
    `[GEMINI]: Đã lưu phản hồi vào .agents/state/GEMINI_FEEDBACK.md (${lastText.length} ký tự).`
  );
  return lastText;
}

async function main() {
  const {
    mode,
    provider,
    taskArg,
    roleArg,
    effortArg,
    newThread,
    errorSummary,
    model,
    projectName,
    cdpUrl,
  } = parseArgs(process.argv.slice(2));
  const selectedRoles = resolveSpecialistRoles(roleArg, mode);

  // 1. Đọc nội dung file .agents/state/CURRENT_PLAN.md, ROADMAP.md, HANDOFF.md và SESSION_MAP.json
  if (!fs.existsSync(PLAN_FILE)) {
    throw new Error(`Không tìm thấy file kế hoạch tại: ${PLAN_FILE}`);
  }
  const planContent = fs.readFileSync(PLAN_FILE, 'utf8').trim();
  if (!planContent) {
    throw new Error(`File kế hoạch (.agents/state/CURRENT_PLAN.md) đang trống.`);
  }

  const roadmapContent = readFileSafe(ROADMAP_FILE);
  const handoffContent = readFileSafe(HANDOFF_FILE);
  const sessionMap = loadSessionMap();

  const taskId = resolveCurrentTaskId(
    taskArg,
    planContent,
    roadmapContent,
    sessionMap
  );
  const threadKey = getThreadKey(taskId, mode);
  const existingThreadEntry =
    sessionMap.threads[threadKey] ||
    (mode === 'plan' ? sessionMap.threads[taskId] : null);
  const existingThreadUrl =
    existingThreadEntry && typeof existingThreadEntry.url === 'string'
      ? existingThreadEntry.url.trim()
      : '';
  // Nếu task_id và mode chưa có URL trong SESSION_MAP.json, tự động coi isNewThread = true ngay cả khi không truyền --new-thread
  const isNewThread = Boolean(newThread || !existingThreadUrl);

  const currentRounds =
    !isNewThread &&
    existingThreadEntry &&
    typeof existingThreadEntry.rounds === 'number'
      ? existingThreadEntry.rounds
      : 0;
  if (
    (provider === 'chatgpt' || provider === 'both') &&
    currentRounds >= MAX_ROUNDS_PER_STAGE
  ) {
    throw new Error(
      `[GIỚI HẠN VÒNG REVIEW]: Đã đạt giới hạn cứng tối đa ${MAX_ROUNDS_PER_STAGE} vòng review cho giai đoạn "${threadKey}". Không tự động gửi thêm.`
    );
  }
  const nextRound = currentRounds + 1;

  let reviewSnapshot = null;
  const uniqueBundleName = `review_bundle_${Date.now()}_${process.pid}.txt`;
  const tempBundlePath = path.join(os.tmpdir(), uniqueBundleName);
  if (mode !== 'plan') {
    reviewSnapshot = collectReviewSnapshot(REPO_ROOT);
    fs.writeFileSync(tempBundlePath, reviewSnapshot.fullBundleText, 'utf8');
  }

  const bootstrapBlock = isNewThread
    ? buildBootstrapContext(taskId, roadmapContent, handoffContent, REVIEW_SCOPE)
    : '';
  let { prompt: reviewPrompt, positiveTestExitCode } = buildMentorPrompt(
    mode,
    planContent,
    errorSummary,
    bootstrapBlock,
    reviewSnapshot,
    selectedRoles
  );

  const roleSummary = selectedRoles.map((r) => `${r.key} (${r.name})`).join(', ');
  console.log(
    `[PAYLOAD INFO]: Provider="${provider}" | Giai đoạn "${threadKey}" (Vòng ${nextRound}/${MAX_ROUNDS_PER_STAGE}) | Chuyên gia: [${roleSummary}] | Kích thước prompt: ${reviewPrompt.length} ký tự.`
  );

  // Pre-Send Reset: Vô hiệu hóa trạng thái APPROVED cũ trước khi kết nối Chrome
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const currentLock = loadStateLock(REPO_ROOT);
  if (provider === 'gemini' || provider === 'both') {
    fs.writeFileSync(
      GEMINI_FEEDBACK_FILE,
      `STATUS: PENDING (Task: ${taskId})\n`,
      'utf8'
    );
  }
  if (provider === 'chatgpt' || provider === 'both') {
    if (mode === 'review-code') {
      fs.writeFileSync(
        CODE_REVIEW_FILE,
        `CODE_STATUS: PENDING (Task: ${taskId})\n`,
        'utf8'
      );
      saveStateLock(
        {
          taskId,
          planHash: currentLock.planHash || '',
          codeDiffHash: '',
          updatedAt: new Date().toISOString(),
        },
        REPO_ROOT
      );
    } else {
      fs.writeFileSync(
        FEEDBACK_FILE,
        `STATUS: PENDING (Task: ${taskId})\n`,
        'utf8'
      );
      saveStateLock(
        {
          taskId,
          planHash: '',
          codeDiffHash: '',
          updatedAt: new Date().toISOString(),
        },
        REPO_ROOT
      );
    }
  }

  const runtimeConfig = {
    ...WORKFLOW_CONFIG,
    cdpUrl,
  };

  let chatgptBrowser = null;
  let geminiBrowser = null;

  try {
    if (provider === 'chatgpt' || provider === 'both') {
      // 2. Kết nối vào trình duyệt Chrome đang mở qua connectProviderPage('chatgpt')
      const conn = await connectProviderPage(
        'chatgpt',
        runtimeConfig,
        sessionMap
      );
      chatgptBrowser = conn.browser;
      const page = conn.page;

      // 4. Điều hướng luồng chat theo Task và giai đoạn (Per-Task & Per-Stage Thread Rotation)
      const { previousConversationId, effectiveNewThread } =
        await prepareTaskThread(page, {
          existingThreadUrl,
          isNewThread,
          projectUrl: sessionMap.projectUrl,
          model,
          projectName,
          sessionMap,
        });

      if (effectiveNewThread && !isNewThread) {
        const effectiveBootstrap = buildBootstrapContext(
          taskId,
          roadmapContent,
          handoffContent,
          REVIEW_SCOPE
        );
        reviewPrompt = buildMentorPrompt(
          mode,
          planContent,
          errorSummary,
          effectiveBootstrap,
          reviewSnapshot,
          selectedRoles
        ).prompt;
      }

      // 5. Đợi ô nhập prompt hiển thị và tự động điều chỉnh mức suy luận (Cao/High hoặc Chuẩn/Standard)
      const promptTextarea = page.locator(PROMPT_SELECTOR).first();
      await promptTextarea.waitFor({ state: 'visible', timeout: 60_000 });

      await setThinkingEffort(page, mode, effortArg);

      // Chờ nếu đang có phản hồi chưa dừng từ trước
      const stopLocator = page.locator(STOP_BUTTON_SELECTOR);
      const waitStopStart = Date.now();
      while (Date.now() - waitStopStart < 20_000) {
        if ((await stopLocator.count().catch(() => 0)) === 0) {
          break;
        }
        await sleep(1000);
      }

      let { userCount: previousUserCount, count: previousAssistantCount } =
        await getAssistantState(page);

      if (mode === 'review-code' && reviewSnapshot) {
        const needsAttachment =
          reviewSnapshot.gitDiff.length > MAX_INLINE_CODE_CHARS ||
          reviewSnapshot.newFilesContent.length > MAX_INLINE_CODE_CHARS;
        if (needsAttachment) {
          await attachReviewBundle(page, tempBundlePath);
          await sleep(1000);
          const stateAfterAttach = await getAssistantState(page);
          previousUserCount = stateAfterAttach.userCount;
          previousAssistantCount = stateAfterAttach.count;
        }
      }

      await tryInvokeGptMention(page, promptTextarea, selectedRoles);
      await fillPromptFast(promptTextarea, reviewPrompt);

      // Nhấn nút gửi ([data-testid="send-button"] hoặc button[aria-label="Gửi"])
      const sendButton = page.locator(SEND_BUTTON_SELECTOR).first();
      const isSendVisible = await sendButton
        .waitFor({ state: 'visible', timeout: 8_000 })
        .then(() => true)
        .catch(() => false);

      if (isSendVisible) {
        await sendButton.click();
      } else {
        await promptTextarea.press('Enter');
      }

      // Chờ tin nhắn người dùng mới xuất hiện trên giao diện để bảo đảm đã submit thành công
      const submitStart = Date.now();
      while (Date.now() - submitStart < 15_000) {
        const state = await getAssistantState(page).catch(() => ({
          userCount: 0,
        }));
        if (state.userCount > previousUserCount) {
          break;
        }
        if (await sendButton.isVisible().catch(() => false)) {
          await sendButton.click().catch(() => {});
        }
        await sleep(500);
      }

      // 6. Sau khi gửi tin nhắn và URL trình duyệt chuyển sang dạng /c/[a-z0-9-]+ (hoặc /g/.../c/...),
      // tự động lấy page.url() lưu vào SESSION_MAP.json cho task_id và mode đó
      const activeThreadUrl = await waitForConversationUrl(
        page,
        previousConversationId,
        effectiveNewThread
      );
      sessionMap.currentTask = taskId;
      if (CONVERSATION_URL_REGEX.test(activeThreadUrl)) {
        sessionMap.threads[threadKey] = {
          url: activeThreadUrl,
          rounds: nextRound,
          updatedAt: new Date().toISOString(),
        };
        sessionMap.threads[taskId] = {
          url: activeThreadUrl,
          rounds: nextRound,
          updatedAt: new Date().toISOString(),
        };
        saveSessionMap(sessionMap);
        console.log(
          `[SESSION_MAP]: Đã lưu đè URL luồng chat mới vào "${taskId}" và "${threadKey}" (rounds=${nextRound}): ${activeThreadUrl}`
        );
      }

      // 7. Đợi ChatGPT phản hồi xong (chờ nút stop-button biến mất và nội dung ổn định)
      const responseText = await waitForStableAssistantResponse(
        page,
        previousUserCount,
        previousAssistantCount,
        600_000,
        mode
      );

      // Cập nhật lại URL & timestamp cuối cùng vào SESSION_MAP.json sau khi hoàn tất phản hồi
      const finalUrl = page.url();
      sessionMap.currentTask = taskId;
      if (CONVERSATION_URL_REGEX.test(finalUrl)) {
        sessionMap.threads[threadKey] = {
          url: finalUrl,
          rounds: nextRound,
          updatedAt: new Date().toISOString(),
        };
        sessionMap.threads[taskId] = {
          url: finalUrl,
          rounds: nextRound,
          updatedAt: new Date().toISOString(),
        };
        saveSessionMap(sessionMap);
      }

      // 8. Ghi kết quả theo chế độ chạy (`plan`, `review-code`, `rescue`)
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const status = detectApprovalStatus(responseText, mode);

      if (mode === 'review-code') {
        const cleanedBody = responseText
          .replace(/^\s*CODE_STATUS\s*:\s*(APPROVED|REJECTED)\s*\r?\n?/i, '')
          .trim();
        const effectiveStatus =
          status === 'APPROVED' && positiveTestExitCode === 0
            ? 'APPROVED'
            : 'REJECTED';
        const normalizedCodeReview = `CODE_STATUS: ${effectiveStatus}\n\n${cleanedBody}\n`;
        fs.writeFileSync(CODE_REVIEW_FILE, normalizedCodeReview, 'utf8');
        if (effectiveStatus === 'APPROVED') {
          const latestLock = loadStateLock(REPO_ROOT);
          saveStateLock(
            {
              taskId,
              planHash: latestLock.planHash || computePlanHash(REPO_ROOT),
              codeDiffHash: computeCodeDiffHash(REPO_ROOT, REVIEW_SCOPE),
              updatedAt: new Date().toISOString(),
            },
            REPO_ROOT
          );
        }
        console.log(`CODE_STATUS: ${effectiveStatus}`);
      } else if (mode === 'rescue') {
        const normalizedRescue = [
          'STATUS: REJECTED',
          `<!-- RESCUE_MODE_GUIDANCE (${new Date().toISOString()}) -->`,
          '',
          responseText,
          '',
        ].join('\n');
        fs.writeFileSync(FEEDBACK_FILE, normalizedRescue, 'utf8');
        console.log('RESCUE_GUIDANCE_SAVED');
      } else {
        const cleanedBody = responseText
          .replace(/^\s*STATUS\s*:\s*(APPROVED|REJECTED)\s*\r?\n?/i, '')
          .trim();
        const normalizedFeedback = `STATUS: ${status}\n\n${cleanedBody}\n`;
        fs.writeFileSync(FEEDBACK_FILE, normalizedFeedback, 'utf8');
        if (status === 'APPROVED') {
          saveStateLock(
            {
              taskId,
              planHash: computePlanHash(REPO_ROOT),
              codeDiffHash: '',
              updatedAt: new Date().toISOString(),
            },
            REPO_ROOT
          );
        }
        console.log(`STATUS: ${status}`);
      }
    }

    if (provider === 'gemini' || provider === 'both') {
      const geminiConn = await connectProviderPage(
        'gemini',
        runtimeConfig,
        sessionMap,
        chatgptBrowser
      );
      geminiBrowser = geminiConn.browser;
      await askGemini(geminiConn.page, reviewPrompt, sessionMap);
    }
  } finally {
    if (fs.existsSync(tempBundlePath)) {
      try {
        fs.unlinkSync(tempBundlePath);
      } catch (_e) {}
    }
    if (geminiBrowser && geminiBrowser !== chatgptBrowser) {
      await geminiBrowser.close().catch(() => {});
    }
    if (chatgptBrowser) {
      await chatgptBrowser.close().catch(() => {});
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  main().catch((err) => {
    console.error(`Lỗi khi gọi ChatGPT Mentor: ${err.message}`);
    process.exitCode = 1;
  });
}
