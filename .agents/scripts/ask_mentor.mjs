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
import {
  ESCALATION_EXIT_CODE,
  EscalationError,
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
  WARNING_TEXT,
  appendTechDebt,
  loadLedger,
  saveLedger,
  appendLedgerRound,
  getOpenIssues,
  buildConvergenceBlock,
  detectConvergenceViolations,
  snapshotPath,
  readSnapshot,
  writeSnapshot,
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
} from './review_policy.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WORKFLOW_CONFIG = loadWorkflowConfig(REPO_ROOT);
const DEFAULT_PROJECT_NAME =
  (WORKFLOW_CONFIG.projectName && String(WORKFLOW_CONFIG.projectName).trim()) ||
  path.basename(REPO_ROOT) ||
  'AI-WORKSPACE';
const DEFAULT_CDP_URL = WORKFLOW_CONFIG.cdpUrl || 'http://127.0.0.1:9222';
const DEFAULT_GEMINI_CDP_URL = WORKFLOW_CONFIG.geminiCdpUrl || 'http://127.0.0.1:9223';
const DEFAULT_PROJECT_URL = 'https://chatgpt.com/';
const DEFAULT_GEMINI_URL = 'https://gemini.google.com/app';
// URL hội thoại Gemini: /app/<id> hoặc /gem/<gemId>/<id> (hỗ trợ tiền tố đa tài khoản /u/<n>/)
const GEMINI_CONVERSATION_URL_REGEX =
  /^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?(?:app|gem\/[^/?#]+)\/([a-z0-9_-]+)/i;
// URL trang Gem (chưa có hội thoại): https://gemini.google.com/gem/<gemId>
const GEMINI_GEM_URL_REGEX = /^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?gem\/[^/?#]+/i;
const DEFAULT_MODE = 'plan';
const DEFAULT_PROVIDER = 'chatgpt';
const VALID_MODES = new Set(['plan', 'review-code', 'rescue']);
const VALID_PROVIDERS = new Set(['chatgpt', 'gemini', 'both']);
const VALID_EFFORTS = new Set(['high', 'standard', 'instant']);
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
const REVIEW_LEDGER_FILE = path.join(STATE_DIR, 'REVIEW_LEDGER.json');
const TECH_DEBT_FILE = path.join(STATE_DIR, 'TECH_DEBT.md');
const REVIEW_RESPONSE_FILE = path.join(STATE_DIR, 'REVIEW_RESPONSE.md');
const SOURCE_DIR_NAME = 'src';

const PROMPT_SELECTOR =
  '#prompt-textarea, div.ProseMirror[data-composer-markdown], div.ProseMirror[contenteditable="true"], [contenteditable="true"][aria-label*="ChatGPT"]';
const SEND_BUTTON_SELECTOR =
  'form [data-testid="send-button"]:not([disabled]), form button[aria-label="Gửi"]:not([disabled]), form button[aria-label*="Gửi"]:not([disabled]), form button[aria-label="Send prompt"]:not([disabled]), form button[aria-label*="Send"]:not([disabled]), [data-testid="send-button"]:not([disabled]), button[aria-label="Gửi"]:not([disabled]), button[aria-label="Send prompt"]:not([disabled])';
const STOP_BUTTON_SELECTOR =
  '[data-testid="stop-button"], button[aria-label*="Ngừng"], button[aria-label*="Dừng"], button[aria-label*="Stop"]';
const ASSISTANT_MESSAGE_SELECTOR =
  '[data-message-author-role="assistant"], [data-conversation-role="assistant"], [class*="--entity-prose-inset"], article[data-turn="assistant"], [data-testid*="conversation-turn"] .markdown';
const NEW_CHAT_BUTTON_SELECTOR =
  '[data-testid="create-new-chat-button"], a[data-testid="create-new-chat-button"], nav a[href="/"], a[href="/"]';
// Bỏ qua URL nháp tạm "local-chatgpt%3A..." của ChatGPT mới, chỉ nhận UUID hội thoại thực từ server
const CONVERSATION_URL_REGEX = /\/(?:g\/[^/]+\/)?c\/(?!local-chatgpt)([a-z0-9-]{8,})/i;

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
    val === 'vừa' ||
    val === 'vua'
  ) {
    return 'standard';
  }
  if (
    val === 'instant' ||
    val === 'low' ||
    val === 'tức thì' ||
    val === 'tuc thi' ||
    val === 'nhẹ nhàng' ||
    val === 'nhe nhang' ||
    val === 'thấp' ||
    val === 'thap' ||
    val === 'nhanh'
  ) {
    return 'instant';
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
export function parseArgs(argv) {
  let mode = DEFAULT_MODE;
  let provider = DEFAULT_PROVIDER;
  let taskArg = '';
  let roleArg = '';
  let effortArg = '';
  let newThread = false;
  let dryRun = false;
  let resetRounds = false;
  let ensureProject = false;
  let errorSummary = '';
  let model = '';
  let projectName = '';
  let cdpUrl = process.env.CDP_URL || DEFAULT_CDP_URL;
  let composerArg = '';

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
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--reset-rounds') {
      resetRounds = true;
    } else if (arg === '--ensure-project') {
      ensureProject = true;
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
    } else if (arg === '--composer' && i + 1 < argv.length) {
      composerArg = normalizeComposerMode(argv[i + 1]);
      if (!composerArg) {
        throw new Error(
          `Chế độ khung chat --composer không hợp lệ: "${argv[i + 1]}". Chỉ hỗ trợ: chat, work.`
        );
      }
      i += 1;
    } else if (arg.startsWith('--composer=')) {
      const rawComposer = arg.slice('--composer='.length);
      composerArg = normalizeComposerMode(rawComposer);
      if (!composerArg) {
        throw new Error(
          `Chế độ khung chat --composer không hợp lệ: "${rawComposer}". Chỉ hỗ trợ: chat, work.`
        );
      }
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
      `Mức suy luận --effort không hợp lệ: "${effortArg}". Chỉ hỗ trợ: high, standard, instant.`
    );
  }

  return {
    mode,
    provider,
    taskArg,
    roleArg,
    effortArg,
    newThread,
    dryRun,
    resetRounds,
    ensureProject,
    errorSummary,
    model,
    projectName,
    cdpUrl,
    composerArg,
  };
}

/**
 * Chuẩn hóa chế độ khung soạn thảo trong ChatGPT Project ("Chế độ trình soạn thảo"):
 * - `chat` ("Trò chuyện"): KHÔNG có bộ chọn mô hình, chỉ có 3 mức suy luận `Tức thì` / `Vừa` / `Cao`,
 *   không có nút `Plugin` (không gắn được `@Plugin` chuyên gia).
 * - `work` ("Công việc"): hiện bộ chọn mô hình (VD `GPT-6.1 Sol`) ngay trong khung chat,
 *   thanh suy luận 5 nấc (`Nhẹ nhàng` -> `Max`) và có nút `Plugin` để gắn `@Plugin`.
 *
 * @param {unknown} raw
 * @returns {'' | 'chat' | 'work'}
 */
export function normalizeComposerMode(raw) {
  if (typeof raw !== 'string') {
    return '';
  }
  const val = raw.trim().toLowerCase();
  if (['chat', 'trò chuyện', 'tro chuyen', 'conversation'].includes(val)) {
    return 'chat';
  }
  if (['work', 'công việc', 'cong viec', 'task'].includes(val)) {
    return 'work';
  }
  return '';
}

/**
 * Xác định chế độ khung chat hiệu lực: `--composer` > `.agents/config.json -> chatgptComposerMode` > `work`.
 * Mặc định `work` vì đây là chế độ duy nhất hỗ trợ `@Plugin` chuyên gia và chọn mô hình.
 *
 * @param {string} [composerArg='']
 * @param {{ chatgptComposerMode?: string }} [config={}]
 * @returns {'chat' | 'work'}
 */
export function resolveComposerMode(composerArg = '', config = {}) {
  return (
    normalizeComposerMode(composerArg) ||
    normalizeComposerMode(config?.chatgptComposerMode) ||
    'work'
  );
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
 * Chuẩn hóa link Gem của Gemini (`.agents/config.json` -> `geminiGemUrl`).
 * Chỉ chấp nhận dạng `https://gemini.google.com/[u/<n>/]gem/<gemId>`; nếu người dùng dán nhầm link
 * một cuộc trò chuyện bên trong Gem (`/gem/<gemId>/<conversationId>`), tự động cắt về link gốc của Gem
 * để mỗi Task mới luôn mở một đoạn chat sạch.
 *
 * @param {unknown} rawUrl
 * @returns {string} Link Gem hợp lệ hoặc chuỗi rỗng nếu không hợp lệ / không cấu hình.
 */
export function normalizeGeminiGemUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return '';
  }
  const match = rawUrl.trim().match(GEMINI_GEM_URL_REGEX);
  return match ? match[0] : '';
}

/**
 * Trích xuất mã hội thoại Gemini từ URL (`/app/<id>` hoặc `/gem/<gemId>/<id>`).
 *
 * @param {string} url
 * @returns {string} Mã hội thoại (chữ thường) hoặc chuỗi rỗng nếu URL chưa phải là một hội thoại.
 */
export function extractGeminiConversationId(url) {
  if (typeof url !== 'string') {
    return '';
  }
  const match = url.trim().match(GEMINI_CONVERSATION_URL_REGEX);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Chuẩn hóa một bảng luồng chat (`threads` của ChatGPT hoặc `geminiThreads` của Gemini).
 *
 * @param {unknown} rawThreads
 * @returns {Record<string, { url: string, rounds: number, updatedAt: string }>}
 */
function normalizeThreadTable(rawThreads) {
  const table = {};
  if (!rawThreads || typeof rawThreads !== 'object' || Array.isArray(rawThreads)) {
    return table;
  }
  for (const [key, val] of Object.entries(rawThreads)) {
    const normKey = normalizeTaskId(key);
    if (normKey && val && typeof val === 'object' && typeof val.url === 'string') {
      table[normKey] = {
        url: val.url.trim(),
        rounds: typeof val.rounds === 'number' ? val.rounds : 0,
        updatedAt:
          typeof val.updatedAt === 'string'
            ? val.updatedAt
            : new Date().toISOString(),
      };
    }
  }
  return table;
}

/**
 * Chuẩn hóa đối tượng `SESSION_MAP.json` đã parse (hàm thuần, không đọc/ghi đĩa).
 *
 * - `threads`: luồng ChatGPT theo Task & giai đoạn (`task-4-plan`, `task-4-review`, ...).
 * - `geminiThreads`: "Thư mục Project" riêng cho Gemini — luồng Gemini xoay vòng theo Task & giai đoạn.
 * - `geminiThreadUrl` (legacy): chỉ còn là con trỏ "luồng Gemini dùng gần nhất", KHÔNG dùng để định tuyến.
 *   Nếu `geminiThreads` còn trống, URL legacy được di trú vào `<currentTask>-plan` để không mất mạch review.
 *
 * @param {unknown} parsed
 * @returns {{ projectName: string, projectUrl: string, geminiThreadUrl: string, currentTask: string, threads: Record<string, { url: string, rounds: number, updatedAt: string }>, geminiThreads: Record<string, { url: string, rounds: number, updatedAt: string }> }}
 */
export function normalizeSessionMap(parsed) {
  const fallback = {
    projectName: DEFAULT_PROJECT_NAME,
    projectUrl: DEFAULT_PROJECT_URL,
    geminiThreadUrl: '',
    currentTask: '',
    threads: {},
    geminiThreads: {},
    stageRounds: {},
  };
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
  const threads = normalizeThreadTable(parsed.threads);
  const geminiThreads = normalizeThreadTable(parsed.geminiThreads);

  // Di trú một lần: geminiThreadUrl đơn lẻ (kiểu cũ) -> geminiThreads["<currentTask>-plan"]
  if (
    Object.keys(geminiThreads).length === 0 &&
    currentTask &&
    extractGeminiConversationId(geminiThreadUrl)
  ) {
    geminiThreads[getThreadKey(currentTask, 'plan')] = {
      url: geminiThreadUrl,
      rounds: 1,
      updatedAt: new Date().toISOString(),
    };
  }

  const normalizedStageRounds = normalizeStageRounds(parsed.stageRounds);
  const stageRounds =
    Object.keys(normalizedStageRounds).length > 0
      ? normalizedStageRounds
      : seedStageRounds(threads, geminiThreads);

  return {
    projectName,
    projectUrl,
    geminiThreadUrl,
    currentTask,
    threads,
    geminiThreads,
    stageRounds,
  };
}

/**
 * Đọc cấu hình `.agents/state/SESSION_MAP.json`.
 * Nếu chưa tồn tại hoặc lỗi cú pháp, trả về cấu trúc mặc định.
 *
 * @returns {ReturnType<typeof normalizeSessionMap>}
 */
function loadSessionMap() {
  try {
    if (!fs.existsSync(SESSION_MAP_FILE)) {
      return normalizeSessionMap(null);
    }
    const raw = fs.readFileSync(SESSION_MAP_FILE, 'utf8');
    return normalizeSessionMap(JSON.parse(raw));
  } catch (_err) {
    return normalizeSessionMap(null);
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
 * Nếu truyền `planContent` (dùng cho luồng Gemini mới ở giai đoạn `review-code`/`rescue`, nơi prompt
 * chính không chứa kế hoạch), khối `CURRENT_PLAN.md` được đính kèm để Mentor đối chiếu code với thiết kế.
 *
 * @param {string} taskId
 * @param {string} roadmapContent
 * @param {string} handoffContent
 * @param {string[]} [sourceDirs=REVIEW_SCOPE]
 * @param {string} [planContent='']
 * @returns {string}
 */
export function buildBootstrapContext(
  taskId,
  roadmapContent,
  handoffContent,
  sourceDirs = REVIEW_SCOPE,
  planContent = ''
) {
  const safeRoadmap = roadmapContent || '(Chưa có nội dung ROADMAP.md)';
  const safeHandoff = handoffContent || '(Chưa có nội dung HANDOFF.md)';
  const repoSkeleton = buildRepoSkeleton(sourceDirs);
  const planSection = planContent
    ? [
        '',
        '=== BẮT ĐẦU .agents/state/CURRENT_PLAN.md (bản thiết kế đã duyệt của Task này) ===',
        planContent,
        '=== KẾT THÚC .agents/state/CURRENT_PLAN.md ===',
      ]
    : [];

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
    ...planSection,
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
export function buildMentorPrompt(
  mode,
  planContent,
  errorSummary,
  bootstrapBlock = '',
  snapshot = null,
  selectedRoles = [],
  policyOptions = {}
) {
  let corePrompt = '';
  const positiveTestExitCode = snapshot ? snapshot.positiveTestExitCode : 0;
  const {
    planBodyOverride = '',
    convergenceBlock = '',
    secondOpinionBlock = '',
    includeSeverityRules = mode !== 'rescue',
  } = policyOptions || {};
  const severityBlock = includeSeverityRules ? buildSeverityRules(mode) : '';

  if (mode === 'plan') {
    const planBody =
      planBodyOverride ||
      [
        '--- BẮT ĐẦU CURRENT_PLAN.md ---',
        planContent,
        '--- KẾT THÚC CURRENT_PLAN.md ---',
      ].join('\n');
    corePrompt = [
      'Bạn là Mentor đánh giá thiết kế kỹ thuật theo quy trình RPIR.',
      'Hãy review chi tiết kế hoạch dưới đây và phản hồi với dòng đầu tiên bắt buộc là:',
      '`STATUS: APPROVED` (nếu kế hoạch đạt yêu cầu, cho phép triển khai code)',
      'hoặc `STATUS: REJECTED` (chỉ khi có lỗi chặn P0, kèm các điểm cần khắc phục chi tiết).',
      '',
      planBody,
    ].join('\n');
  } else if (mode === 'review-code') {
    const { gitStatus, gitDiff, newFilesList, newFilesContent, testEvidence } = snapshot;
    const inlineDiff = truncateSafely(gitDiff, MAX_INLINE_CODE_CHARS);
    const inlineNewFiles = newFilesContent
      ? truncateSafely(newFilesContent, MAX_INLINE_CODE_CHARS)
      : '';

    corePrompt = [
      'Bạn là Mentor thực hiện bước Review Code trong quy trình RPIR.',
      'Hãy kiểm tra kết quả chạy `npm test` và thay đổi mã nguồn ứng dụng (`git diff HEAD -- src/ tests/` kèm các file mới trong `src/`, `tests/`).',
      'Yêu cầu bắt buộc ở dòng đầu tiên của phản hồi:',
      '- Ghi rõ `CODE_STATUS: APPROVED` nếu code và test đạt yêu cầu (hoặc chỉ còn góp ý P1/P2).',
      '- Ghi rõ `CODE_STATUS: REJECTED` chỉ khi có lỗi chặn P0 cần khắc phục.',
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
      'Bạn là Mentor hỗ trợ gỡ bế tắc kỹ thuật (RESCUE MODE - Circuit Breaker) trong quy trình RPIR.',
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
  const sections = [
    roleHeader,
    bootstrapBlock,
    convergenceBlock,
    secondOpinionBlock,
    corePrompt,
    severityBlock,
  ].filter(Boolean);
  const prompt = sections.join('\n\n');
  return { prompt, positiveTestExitCode };
}

/**
 * Chuẩn hóa URL của một ChatGPT Project về trang gốc composer của Project:
 * `https://chatgpt.com/g/g-p-<id>/project` (loại bỏ hậu tố `/c/...` nếu có).
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeChatGptProjectUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const m = rawUrl
    .trim()
    .match(/^(https:\/\/chatgpt\.com\/g\/g-p-[a-z0-9_-]+)(?:\/project|\/c\/.*|\/|[?#].*)?$/i);
  return m ? `${m[1]}/project` : '';
}

/**
 * Đảm bảo giao diện ChatGPT luôn ở chế độ "ChatGPT" (Chat) tiêu chuẩn chứ không bị kẹt ở chế độ "Codex" / "Work".
 *
 * @param {import('playwright-core').Page} page
 */
export async function ensureChatGptMode(page) {
  try {
    const modeBtn = page
      .locator('button[aria-label*="Chuyển chế độ" i], button[aria-label*="Switch mode" i]')
      .first();
    if (!(await modeBtn.isVisible().catch(() => false))) {
      return;
    }
    const aria = ((await modeBtn.getAttribute('aria-label').catch(() => '')) || '').trim();
    const txt = ((await modeBtn.innerText().catch(() => '')) || '').trim();
    const isAlreadyChat =
      /chế độ hiện tại:\s*chatgpt\b/i.test(aria) ||
      /current mode:\s*chat(?:gpt)?\b/i.test(aria) ||
      /^(chatgpt|chat)$/i.test(txt);
    if (isAlreadyChat) {
      return;
    }

    await modeBtn.click({ timeout: 4_000 });
    await sleep(400);
    const chatOption = page
      .locator('[role="menuitem"], [role="menuitemradio"], [role="option"]')
      .filter({ hasText: /^(ChatGPT|Chat)(\s|\n|$)/i })
      .first();
    if (await chatOption.isVisible().catch(() => false)) {
      await chatOption.click({ timeout: 4_000 });
      console.log('[MODE GUARD]: Đã tự động chuyển ChatGPT về chế độ "ChatGPT" (Chat).');
      await sleep(800);
    } else {
      await page.keyboard.press('Escape').catch(() => {});
    }
  } catch (_err) {
    await page.keyboard.press('Escape').catch(() => {});
  }
}

/**
 * Chuyển nút gạt "Chế độ trình soạn thảo" trên trang Project ChatGPT sang `Trò chuyện` (chat) hoặc `Công việc` (work).
 * Nút gạt chỉ xuất hiện trên trang Project (`/g/g-p-.../project`) trước khi mở luồng mới, và được ChatGPT ghi nhớ theo Project.
 * Bọc an toàn: nếu giao diện không có nút gạt thì bỏ qua.
 *
 * @param {import('playwright-core').Page} page
 * @param {'chat' | 'work'} composerMode
 * @returns {Promise<boolean>} true nếu đang ở đúng chế độ yêu cầu sau khi xử lý
 */
export async function ensureProjectComposerMode(page, composerMode) {
  const label =
    composerMode === 'chat' ? /^\s*(Trò chuyện|Chat)\s*$/i : /^\s*(Công việc|Work)\s*$/i;
  try {
    const group = page
      .locator(
        '[role="group"][aria-label*="trình soạn thảo" i], [role="group"][aria-label*="composer" i]'
      )
      .first();
    if (!(await group.isVisible().catch(() => false))) {
      return false;
    }
    const target = group.locator('button[aria-pressed]').filter({ hasText: label }).first();
    if (!(await target.isVisible().catch(() => false))) {
      return false;
    }
    if ((await target.getAttribute('aria-pressed').catch(() => '')) === 'true') {
      return true;
    }
    await target.click({ timeout: 4_000 });
    await sleep(900);
    const ok = (await target.getAttribute('aria-pressed').catch(() => '')) === 'true';
    console.log(
      ok
        ? `[COMPOSER MODE]: Đã chuyển khung chat Project sang "${composerMode === 'chat' ? 'Trò chuyện' : 'Công việc'}".`
        : `[COMPOSER MODE]: Không xác nhận được việc chuyển sang "${composerMode}" — giữ nguyên giao diện hiện tại.`
    );
    return ok;
  } catch (_err) {
    return false;
  }
}

/**
 * Chọn mô hình ChatGPT (VD `GPT-6.1 Sol`) trong bộ chọn ngay khung chat — chỉ có ở chế độ `Công việc`.
 * Ở chế độ `Trò chuyện` không có bộ chọn mô hình nên hàm tự bỏ qua.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} modelName
 * @returns {Promise<boolean>}
 */
export async function selectChatGptModel(page, modelName) {
  const wanted = typeof modelName === 'string' ? modelName.trim() : '';
  if (!wanted) {
    return false;
  }
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const modelBtn = page
      .locator('button[aria-label*="Chọn mô hình" i]:visible, button[aria-label*="Select model" i]:visible, button[aria-label*="model" i]:visible')
      .first();
    if (!(await modelBtn.isVisible().catch(() => false))) {
      return false;
    }
    const currentText = (await modelBtn.innerText().catch(() => '')).split(/\r?\n/)[0].trim();
    if (new RegExp(`^${escaped}$`, 'i').test(currentText)) {
      return true;
    }
    // Chế độ "Trò chuyện": nút chỉ hiển thị "Mức nỗ lực suy luận" -> không có bộ chọn mô hình
    if (!/GPT|o\d|model/i.test(currentText)) {
      console.log(
        `[MODEL]: Khung chat hiện tại không có bộ chọn mô hình (chế độ "Trò chuyện") — bỏ qua chọn "${wanted}".`
      );
      return false;
    }

    await modelBtn.click({ timeout: 4_000 });
    await sleep(400);
    // Menu 2 tầng: bấm mục "Chọn mô hình" để trượt sang danh sách mô hình
    const openMenu = page.locator('[role="menu"][data-state="open"]').first();
    const chooseItem = openMenu
      .locator('[role="menuitem"][aria-label*="Chọn mô hình" i], [role="menuitem"][aria-label*="model" i]')
      .first();
    if (await chooseItem.isVisible().catch(() => false)) {
      await chooseItem.click({ timeout: 4_000 });
      await sleep(400);
    }
    const option = page
      .locator('[role="menuitemradio"]')
      .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, 'i') })
      .first();
    if (!(await option.isVisible().catch(() => false))) {
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      console.warn(`[MODEL]: Không tìm thấy mô hình "${wanted}" trong danh sách — giữ nguyên "${currentText}".`);
      return false;
    }
    await option.click({ timeout: 4_000 });
    await sleep(600);
    await page.keyboard.press('Escape').catch(() => {});
    console.log(`[MODEL]: Đã chọn mô hình "${wanted}".`);
    return true;
  } catch (_err) {
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
}

/**
 * Đảm bảo thanh bên (sidebar) của ChatGPT đang mở và mục "Dự án" / "Projects" đang xổ ra.
 *
 * @param {import('playwright-core').Page} page
 */
async function ensureChatGptSidebarOpen(page) {
  const isSidebarWide = await page
    .evaluate(() => {
      const side = document.querySelector(
        'nav[aria-label="Lịch sử trò chuyện"], nav[aria-label*="Chat history" i], aside'
      );
      return Boolean(side && side.getBoundingClientRect().width > 120);
    })
    .catch(() => false);

  if (!isSidebarWide) {
    const openBtn = page
      .locator(
        'button[aria-label="Hiện thanh bên"], button[aria-label*="Open sidebar" i], [data-testid="open-sidebar-button"]'
      )
      .first();
    if (await openBtn.isVisible().catch(() => false)) {
      await openBtn.click({ force: true }).catch(() => {});
      await sleep(800);
    }
  }

  // Nếu mục "Dự án" / "Projects" đang bị thu gọn (aria-expanded="false"), bấm mở ra
  await page
    .evaluate(() => {
      const side =
        document.querySelector(
          'nav[aria-label="Lịch sử trò chuyện"], nav[aria-label*="Chat history" i], aside'
        ) || document.body;
      const projHeader = Array.from(side.querySelectorAll('button')).find((b) =>
        /^(Dự án|Projects)$/i.test((b.innerText || '').trim())
      );
      if (projHeader && projHeader.getAttribute('aria-expanded') === 'false') {
        projHeader.click();
        return true;
      }
      return false;
    })
    .then(async (clicked) => {
      if (clicked) await sleep(500);
    })
    .catch(() => {});
}

/**
 * Tìm một Project đã tồn tại trên thanh sidebar của ChatGPT (khớp chính xác tên không phân biệt hoa thường).
 * Hỗ trợ cả giao diện `GPT-6.1 Sol` (folder row + nút `Trò chuyện mới trong <Tên>`) và giao diện `<a>` cũ.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} targetName
 * @returns {Promise<string>} URL `/g/g-p-.../project` nếu tìm thấy, hoặc chuỗi rỗng `""`.
 */
async function findExistingProjectInSidebar(page, targetName) {
  const action = await page
    .evaluate((name) => {
      const lower = name.trim().toLowerCase();
      const side =
        document.querySelector(
          'nav[aria-label="Lịch sử trò chuyện"], nav[aria-label*="Chat history" i], aside'
        ) || document.body;

      // 1. Khớp trực tiếp thẻ <a href="/g/g-p-..."> có text trùng chính xác tên dự án
      for (const a of Array.from(side.querySelectorAll('a[href*="/g/g-p-"]'))) {
        const txt = (a.innerText || '').trim().toLowerCase();
        const aria = (a.getAttribute('aria-label') || '').trim().toLowerCase();
        if ((txt === lower || aria === lower) && a.href) {
          return { kind: 'href', href: a.href };
        }
      }

      // 2. Giao diện GPT-6.1 Sol: mỗi dòng dự án có nút `Trò chuyện mới trong <Tên>` / `New chat in <Tên>`
      const buttons = Array.from(side.querySelectorAll('button[aria-label]'));
      for (const btn of buttons) {
        const aria = (btn.getAttribute('aria-label') || '').trim().toLowerCase();
        if (
          aria === `trò chuyện mới trong ${lower}` ||
          aria === `new chat in ${lower}`
        ) {
          btn.click();
          return { kind: 'clicked-new-chat' };
        }
      }

      // 3. Fallback: tìm dòng thư mục trong khu vực "Dự án" / "Projects" có text trùng chính xác
      const allBtns = Array.from(side.querySelectorAll('button'));
      const projHeader = allBtns.find((b) => /^(Dự án|Projects)$/i.test((b.innerText || '').trim()));
      const recentHeader = allBtns.find((b) =>
        /^(Gần đây|Recents|Hôm nay|Today)$/i.test((b.innerText || '').trim())
      );
      const minTop = projHeader ? projHeader.getBoundingClientRect().bottom - 2 : 0;
      const maxTop = recentHeader ? recentHeader.getBoundingClientRect().top + 2 : 99999;

      const rowCandidates = Array.from(side.querySelectorAll('div, span, a, button')).filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.top < minTop || r.top > maxTop) return false;
        return (el.innerText || '').trim().toLowerCase() === lower;
      });
      if (rowCandidates.length > 0) {
        rowCandidates[0].click();
        return { kind: 'clicked-row' };
      }

      return null;
    }, targetName)
    .catch(() => null);

  if (!action) return '';
  if (action.kind === 'href') {
    return normalizeChatGptProjectUrl(action.href);
  }

  await page.waitForURL(/\/g\/g-p-[a-z0-9]+/i, { timeout: 10_000 }).catch(() => {});
  await sleep(1200);
  return normalizeChatGptProjectUrl(page.url());
}

/**
 * Nếu danh sách Dự án có nút "Hiển thị thêm" / "Show more", bấm mở rộng để không tạo trùng Project đã có.
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<boolean>}
 */
async function expandMoreProjectsIfAvailable(page) {
  return page
    .evaluate(() => {
      const side =
        document.querySelector(
          'nav[aria-label="Lịch sử trò chuyện"], nav[aria-label*="Chat history" i], aside'
        ) || document.body;
      const allBtns = Array.from(side.querySelectorAll('button'));
      const projHeader = allBtns.find((b) => /^(Dự án|Projects)$/i.test((b.innerText || '').trim()));
      const recentHeader = allBtns.find((b) =>
        /^(Gần đây|Recents|Hôm nay|Today)$/i.test((b.innerText || '').trim())
      );
      if (!projHeader) return false;
      const minTop = projHeader.getBoundingClientRect().bottom;
      const maxTop = recentHeader ? recentHeader.getBoundingClientRect().top : 99999;

      const showMoreBtn = allBtns.find((b) => {
        const txt = (b.innerText || '').trim();
        if (!/^(Hiển thị thêm|Xem thêm|Show more|See more)$/i.test(txt)) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.top > minTop && r.top < maxTop && r.left < 20;
      });
      if (showMoreBtn) {
        showMoreBtn.click();
        return true;
      }
      return false;
    })
    .catch(() => false);
}

/**
 * Tự động tạo mới một Project trên ChatGPT với tên `targetName` (khớp tên dự án trong Antigravity)
 * khi kiểm tra trên sidebar chưa tồn tại Project đó.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} targetName
 * @returns {Promise<string>} URL `/g/g-p-.../project` của Project vừa tạo, hoặc `""` nếu thất bại.
 */
async function createChatGptProject(page, targetName) {
  console.log(
    `[PROJECT AUTO-CREATE]: Chưa có dự án "${targetName}" trên ChatGPT — đang tự động tạo mới...`
  );
  await ensureChatGptSidebarOpen(page);

  const addBtnSelector = [
    'button[aria-label="Thêm dự án mới"]',
    'button[aria-label*="Thêm dự án" i]',
    'button[aria-label="New project" i]',
    'button[aria-label*="New project" i]',
    'button[aria-label*="Create project" i]',
    '[data-testid*="new-project" i]',
    '[data-testid*="create-project" i]',
  ].join(', ');

  const addBtn = page.locator(addBtnSelector).first();
  if ((await addBtn.count().catch(() => 0)) > 0) {
    await addBtn.scrollIntoViewIfNeeded().catch(() => {});
    await addBtn.click({ force: true, timeout: 5_000 });
  } else {
    // Dự phòng nếu nút tạo nằm trong menu "..." của thanh bên dự án
    const menuBtn = page
      .locator(
        'button[aria-label*="Tùy chọn thanh bên dự án" i], button[aria-label*="Project sidebar options" i]'
      )
      .first();
    if ((await menuBtn.count().catch(() => 0)) > 0) {
      await menuBtn.click({ force: true, timeout: 4_000 });
      await sleep(500);
      const menuItem = page
        .locator('[role="menuitem"]')
        .filter({ hasText: /dự án mới|thêm dự án|new project|create project/i })
        .first();
      await menuItem.click({ timeout: 4_000 });
    } else {
      throw new Error('Không tìm thấy nút "Thêm dự án mới" / "New project" trên thanh bên ChatGPT.');
    }
  }

  const inputSelector =
    'input#chatgpt-project-name, input[name="project-name"], div[role="dialog"] input[type="text"]';
  const nameInput = page.locator(inputSelector).first();
  await nameInput.waitFor({ state: 'visible', timeout: 8_000 });
  await nameInput.fill(targetName);
  await sleep(400);

  const dialog = page
    .locator(
      'div[role="dialog"]:has(input#chatgpt-project-name), div[role="dialog"]:has(input[name="project-name"]), div[role="dialog"]'
    )
    .last();
  const submitBtn = dialog
    .locator('button[type="submit"]:not([disabled])')
    .first();

  await submitBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await submitBtn.click({ timeout: 5_000 });

  await page.waitForURL(/\/g\/g-p-[a-z0-9]+/i, { timeout: 15_000 });
  await sleep(1500);

  const createdUrl = normalizeChatGptProjectUrl(page.url());
  if (!createdUrl) {
    throw new Error(`Đã bấm Tạo dự án "${targetName}" nhưng URL chưa chuyển sang /g/g-p-... (hiện tại: ${page.url()}).`);
  }

  console.log(`[PROJECT AUTO-CREATE]: Đã tạo thành công Project "${targetName}" tại: ${createdUrl}`);
  return createdUrl;
}

/**
 * Tự động tìm kiếm dự án trên thanh sidebar của ChatGPT theo tên (`projectName` — mặc định trùng tên thư mục dự án Antigravity).
 * - Nếu tìm thấy: điều hướng vào dự án đó và lưu URL `https://chatgpt.com/g/g-p-.../project` vào `SESSION_MAP.json`.
 * - Nếu chưa có trên ChatGPT: tự động bấm "Thêm dự án mới", điền đúng tên dự án và tạo Project mới ngay lập tức!
 *
 * @param {import('playwright-core').Page} page
 * @param {{ projectName?: string, projectUrl: string, currentTask: string, threads: Record<string, { url: string, updatedAt: string }> }} sessionMap
 * @param {string} [projectName=DEFAULT_PROJECT_NAME]
 * @returns {Promise<string>}
 */
export async function ensureProjectUrl(page, sessionMap, projectName = DEFAULT_PROJECT_NAME) {
  const targetName = (projectName || DEFAULT_PROJECT_NAME || sessionMap?.projectName || 'AI-WORKSPACE').trim();
  const cachedProjectUrl = normalizeChatGptProjectUrl(sessionMap?.projectUrl || '');
  const cachedProjectName = (sessionMap?.projectName || '').trim();

  if (
    cachedProjectUrl &&
    (!cachedProjectName || cachedProjectName.toLowerCase() === targetName.toLowerCase())
  ) {
    return cachedProjectUrl;
  }

  if (cachedProjectName && cachedProjectName.toLowerCase() !== targetName.toLowerCase()) {
    console.log(
      `[PROJECT RESOLUTION]: Tên dự án thay đổi ("${cachedProjectName}" -> "${targetName}"). Đang đồng bộ Project trên ChatGPT...`
    );
  } else {
    console.log(`[PROJECT RESOLUTION]: Đang kiểm tra dự án "${targetName}" trên giao diện ChatGPT...`);
  }

  try {
    if (!page.url().includes('chatgpt.com')) {
      await page.goto(DEFAULT_PROJECT_URL, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
    }

    await ensureChatGptSidebarOpen(page);

    // Bước 1: Tìm trong danh sách dự án đang hiển thị
    let resolvedUrl = await findExistingProjectInSidebar(page, targetName);

    // Bước 2: Nếu chưa thấy và có nút "Hiển thị thêm" trong mục Dự án, mở rộng rồi kiểm tra lại
    if (!resolvedUrl && (await expandMoreProjectsIfAvailable(page))) {
      await sleep(800);
      resolvedUrl = await findExistingProjectInSidebar(page, targetName);
    }

    if (resolvedUrl) {
      console.log(`[PROJECT RESOLUTION]: Đã tìm thấy dự án "${targetName}" tại: ${resolvedUrl}`);
    } else {
      // Bước 3: Chưa có dự án -> Tự động tạo mới trên ChatGPT trùng tên dự án Antigravity
      resolvedUrl = await createChatGptProject(page, targetName);
    }

    if (resolvedUrl) {
      if (!page.url().startsWith(resolvedUrl.replace(/\/project$/i, ''))) {
        await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded' });
        await sleep(2000);
      }
      if (sessionMap) {
        sessionMap.projectUrl = resolvedUrl;
        sessionMap.projectName = targetName;
        saveSessionMap(sessionMap);
      }
      return resolvedUrl;
    }
  } catch (err) {
    console.warn(`[PROJECT RESOLUTION WARNING]: Không thể tìm/tạo dự án "${targetName}": ${err.message}`);
  }

  return normalizeChatGptProjectUrl(sessionMap?.projectUrl || '') || DEFAULT_PROJECT_URL;
}

const resolveProjectUrl = ensureProjectUrl;

/**
 * Điều hướng tab ChatGPT tới luồng chat của Task hiện tại (nếu đã có URL trong `SESSION_MAP.json`),
 * hoặc tự động coi `effectiveNewThread = true` (mở phiên mới + gắn Bootstrap) nếu `task_id` chưa có URL
 * trong `SESSION_MAP.json` hoặc khi người dùng truyền cờ `--new-thread`.
 *
 * QUY TẮC QUAN TRỌNG: Khi effectiveNewThread === true, TUYỆT ĐỐI KHÔNG bấm nút "Trò chuyện mới" (a[href="/"])
 * ở góc trái vì sẽ đẩy chat ra ngoài Project. Thay vào đó, gọi await page.goto(sessionMap.projectUrl)
 * và gõ thẳng vào ô composer ở giữa màn hình của Project.
 *
 * @param {import('playwright-core').Page} page
 * @param {{ existingThreadUrl: string, isNewThread: boolean, projectUrl: string, model: string, projectName?: string, sessionMap?: any, composerMode?: 'chat' | 'work' }} options
 * @returns {Promise<{ previousConversationId: string, effectiveNewThread: boolean }>}
 */
async function prepareTaskThread(
  page,
  { existingThreadUrl, isNewThread, projectUrl, model, projectName, sessionMap, composerMode }
) {
  const desiredProjectName =
    projectName || DEFAULT_PROJECT_NAME || sessionMap?.projectName || 'AI-WORKSPACE';

  // 0. Đảm bảo đang ở chế độ Chat tiêu chuẩn (không kẹt ở Codex / Work)
  await ensureChatGptMode(page);

  // 1. Đảm bảo projectUrl trỏ đúng vào Project ChatGPT (/g/g-p-...) — tự tạo mới nếu chưa có
  let targetProjectUrl = await ensureProjectUrl(page, sessionMap, desiredProjectName);

  const projectIdMatch = targetProjectUrl.match(/\/g\/(g-p-[a-z0-9]+)/i);
  const requiredProjectId = projectIdMatch ? projectIdMatch[1].toLowerCase() : '';

  const normalizedExistingUrl =
    typeof existingThreadUrl === 'string' ? existingThreadUrl.trim() : '';
  const isOutsideProject = Boolean(
    requiredProjectId &&
      normalizedExistingUrl &&
      !normalizedExistingUrl.toLowerCase().includes(requiredProjectId)
  );
  if (isOutsideProject) {
    console.log(
      `[PROJECT ENFORCEMENT]: Luồng chat hiện tại (${normalizedExistingUrl}) nằm ngoài Project (${requiredProjectId}). Tự động chuyển vào Project!`
    );
  }
  const effectiveNewThread = Boolean(
    isNewThread || !normalizedExistingUrl || isOutsideProject
  );

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
  console.log(`[TASK THREAD]: Khởi tạo luồng chat mới trong Project: ${targetProjectUrl}`);
  await page.goto(targetProjectUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  // Tự phục hồi nếu Project cũ trên ChatGPT đã bị người dùng xóa tay (bị redirect ra khỏi /g/g-p-...)
  if (requiredProjectId && !page.url().toLowerCase().includes(requiredProjectId)) {
    console.warn(
      `[DEAD PROJECT RECOVERY]: Project cũ (${requiredProjectId}) không còn tồn tại trên ChatGPT. Tự động tạo lại Project "${desiredProjectName}"...`
    );
    if (sessionMap) {
      sessionMap.projectUrl = '';
      saveSessionMap(sessionMap);
    }
    targetProjectUrl = await ensureProjectUrl(page, sessionMap, desiredProjectName);
    if (!page.url().startsWith(targetProjectUrl.replace(/\/project$/i, ''))) {
      await page.goto(targetProjectUrl, { waitUntil: 'domcontentloaded' });
      await sleep(2500);
    }
  }

  // 4. Chọn chế độ khung chat của Project ("Trò chuyện" / "Công việc") trước khi gửi tin đầu tiên
  if (composerMode) {
    await ensureProjectComposerMode(page, composerMode);
  }

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
/**
 * Tự động xử lý banner chuyển đổi GPT -> Plugin một lần của ChatGPT ("... hiện là một plugin")
 * bằng cách ưu tiên nhấn "Sử dụng plugin" (nếu khả dụng) hoặc fallback sang "Tiếp tục dùng GPT".
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<boolean>}
 */
async function handlePluginMigrationBanner(page) {
  try {
    const usePluginBtn = page
      .locator('button:not([disabled])')
      .filter({ hasText: /^(Sử dụng plugin|Use plugin)$/i })
      .first();
    if (await usePluginBtn.isVisible().catch(() => false)) {
      await usePluginBtn.click({ timeout: 3_000 });
      console.log('[PLUGIN MIGRATION]: Đã tự động nhấn "Sử dụng plugin".');
      await sleep(800);
      return true;
    }

    const keepGptBtn = page
      .locator('button:not([disabled])')
      .filter({ hasText: /^(Tiếp tục dùng GPT|Continue using GPT)$/i })
      .first();
    if (await keepGptBtn.isVisible().catch(() => false)) {
      await keepGptBtn.click({ timeout: 3_000 });
      console.log('[PLUGIN MIGRATION]: Đã tự động nhấn "Tiếp tục dùng GPT".');
      await sleep(800);
      return true;
    }
  } catch (_err) {
    // Bỏ qua nếu không có banner hoặc vừa biến mất
  }
  return false;
}

async function tryInvokeGptMention(page, promptTextarea, selectedRoles) {
  if (
    !WORKFLOW_CONFIG.useGptMention ||
    !Array.isArray(selectedRoles) ||
    selectedRoles.length === 0
  ) {
    return false;
  }

  let attachedCount = 0;

  try {
    await promptTextarea.click();
    await promptTextarea.evaluate((el) => {
      el.focus();
      const sel = window.getSelection();
      if (sel) {
        sel.selectAllChildren(el);
      }
      if (typeof document.execCommand === 'function') {
        document.execCommand('delete', false);
      }
    });

    for (const role of selectedRoles) {
      const pluginName = (role && role.name ? String(role.name) : '').trim();
      if (!pluginName) continue;

      const prevPillCount = await promptTextarea
        .evaluate(
          (el) =>
            el.querySelectorAll(
              '[app-mention-display-name], [app-mention-path], [data-appearance="inline-mention"]'
            ).length
        )
        .catch(() => 0);

      await promptTextarea.evaluate((el) => {
        el.focus();
        const sel = window.getSelection();
        if (sel) {
          sel.selectAllChildren(el);
          sel.collapseToEnd();
        }
      });

      await page.keyboard.type(`@${pluginName}`, { delay: 20 });
      await sleep(1000);

      // Ưu tiên chọn đúng mục Plugin mới ([data-plugin-impression-id]) thay vì bản Custom GPT cũ trùng tên
      const preferredPluginOption = page
        .locator('button[data-list-navigation-item="true"][data-plugin-impression-id]')
        .filter({ hasText: pluginName })
        .first();
      const fallbackMenuOption = page
        .locator('button[data-list-navigation-item="true"], [role="option"], [role="menuitem"]')
        .filter({ hasText: pluginName })
        .first();

      let selectedFromMenu = false;
      if (await preferredPluginOption.isVisible().catch(() => false)) {
        await preferredPluginOption.click({ timeout: 3_000 });
        selectedFromMenu = true;
      } else if (await fallbackMenuOption.isVisible().catch(() => false)) {
        await fallbackMenuOption.click({ timeout: 3_000 });
        selectedFromMenu = true;
      }

      if (selectedFromMenu) {
        await sleep(500);
        await handlePluginMigrationBanner(page);

        const newPillCount = await promptTextarea
          .evaluate(
            (el) =>
              el.querySelectorAll(
                '[app-mention-display-name], [app-mention-path], [data-appearance="inline-mention"]'
              ).length
          )
          .catch(() => 0);

        if (newPillCount > prevPillCount) {
          attachedCount += 1;
          console.log(
            `[ROLE MENTION]: Đã kích hoạt Plugin "@${pluginName}" thành công.`
          );
          continue;
        }
      }

      // Nếu không tìm thấy hoặc không gắn được pill -> đóng popup và xóa đúng phần chuỗi "@<pluginName>" vừa gõ, giữ nguyên các pill đã gắn trước đó
      await page.keyboard.press('Escape').catch(() => {});
      await promptTextarea
        .evaluate((el, typedMention) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const toClean = [];
          while (walker.nextNode()) {
            const tNode = walker.currentNode;
            if (
              tNode.parentElement &&
              tNode.parentElement.closest(
                '[app-mention-display-name], [app-mention-path], [data-appearance="inline-mention"]'
              )
            ) {
              continue;
            }
            if ((tNode.nodeValue || '').includes(typedMention)) {
              toClean.push(tNode);
            }
          }
          for (const tNode of toClean) {
            tNode.nodeValue = (tNode.nodeValue || '').replace(typedMention, '');
          }
        }, `@${pluginName}`)
        .catch(() => {});
    }

    return attachedCount > 0;
  } catch (_err) {
    await page.keyboard.press('Escape').catch(() => {});
    return attachedCount > 0;
  }
}

async function fillPromptFast(promptTextarea, text) {
  await promptTextarea.evaluate((el, rawText) => {
    el.focus();
    const hasMentionPills =
      el.querySelectorAll(
        '[app-mention-display-name], [app-mention-path], [data-appearance="inline-mention"]'
      ).length > 0;

    const sel = window.getSelection();
    if (sel) {
      sel.selectAllChildren(el);
      if (hasMentionPills) {
        sel.collapseToEnd();
      }
    }

    const payload = hasMentionPills ? ` \n\n${rawText}` : String(rawText);

    // Dán qua ClipboardEvent('paste') để cập nhật trực tiếp EditorState nội bộ của ProseMirror,
    // giữ nguyên @Plugin pill, xuống dòng (\n) và bật ngay nút Gửi (disabled=false).
    let pasted = false;
    if (typeof DataTransfer !== 'undefined' && typeof ClipboardEvent !== 'undefined') {
      const dt = new DataTransfer();
      dt.setData('text/plain', payload);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      el.dispatchEvent(pasteEvent);
      pasted = (el.innerText || '').length >= Math.min(20, rawText.length);
    }

    if (!pasted && typeof document.execCommand === 'function') {
      pasted = document.execCommand('insertText', false, payload);
    }

    if (!pasted) {
      el.textContent = payload;
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: payload,
        })
      );
    }
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
    targetEffort === 'instant'
      ? /(?:^|\s|\n)(Tức thì|Nhẹ nhàng|Nhanh|Thấp|Instant|Low)(?:$|\s|\n)/i
      : targetEffort === 'standard'
        ? /(?:^|\s|\n)(Chuẩn|Trung bình|Vừa|Standard|Medium)(?:$|\s|\n)/i
        : /(?:^|\s|\n)(Cao|High)(?:$|\s|\n)/i;
  const anyEffortButtonRegex =
    /(Cao|Chuẩn|Trung bình|Vừa|Thấp|Tức thì|Nhẹ nhàng|Nhanh|Chuyên sâu|Không suy luận|Max|Ultra|High|Standard|Medium|Low|Instant|GPT-)/i;

  let menuOpened = false;
  try {
    const reasoningButton = page
      .locator(
        'button[aria-label*="Chọn mô hình" i]:visible, button[aria-label*="Select model" i]:visible, button[aria-label*="mô hình" i]:visible, button[aria-label*="model" i]:visible, button[aria-label*="suy luận" i]:visible, button[aria-label*="reasoning" i]:visible, button[aria-label*="thinking" i]:visible, button[aria-label*="effort" i]:visible, form button:visible, [data-testid*="composer"] button:visible'
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
    const activeEffortHeader = buttonText.split(/\r?\n/).slice(0, 2).join('\n');
    if (targetLabelRegex.test(activeEffortHeader)) {
      return;
    }

    await reasoningButton.click({ timeout: 5_000 });
    menuOpened = true;
    await sleep(350);

    // 1. Thanh trượt [role="slider"] — nhãn khác nhau theo chế độ khung chat Project:
    //    - "Công việc" (VD GPT-6.1 Sol): 0=Nhẹ nhàng, 1=Vừa, 2=Cao, 3=Chuyên sâu, 4=Max
    //    - "Trò chuyện" (không chọn mô hình): 0=Tức thì, 1=Vừa, 2=Cao
    //    => Dò theo nhãn thực tế thay vì cố định chỉ số nấc.
    const slider = page
      .locator(
        '[role="menu"][data-state="open"] [role="slider"], [role="menuitem"][aria-label*="Năng lượng" i] [role="slider"], [role="menuitem"][aria-label*="Effort" i] [role="slider"], [role="menuitem"][aria-label*="Thinking" i] [role="slider"]'
      )
      .first();
    if (await slider.isVisible().catch(() => false)) {
      const curVal = Number(await slider.getAttribute('aria-valuenow').catch(() => 'NaN'));
      const minVal = Number((await slider.getAttribute('aria-valuemin').catch(() => '0')) || '0');
      const maxVal = Number((await slider.getAttribute('aria-valuemax').catch(() => '4')) || '4');
      if (!Number.isNaN(curVal) && maxVal > minVal) {
        const headerItem = page
          .locator('[role="menu"][data-state="open"] [role="menuitem"]')
          .first();
        await slider.focus();
        await sleep(80);

        // Đưa về mốc nhỏ nhất rồi dò từng nấc theo nhãn thực tế ("Vừa"/"Standard" hoặc "Cao"/"High")
        for (let i = curVal; i > minVal; i -= 1) {
          await page.keyboard.press('ArrowLeft');
          await sleep(60);
        }

        let matchedByLabel = false;
        let chosenVal = minVal;
        for (let v = minVal; v <= maxVal; v += 1) {
          await sleep(100);
          const liveHeader = (await headerItem.innerText().catch(() => '')).trim();
          if (targetLabelRegex.test(liveHeader)) {
            matchedByLabel = true;
            chosenVal = v;
            break;
          }
          if (v < maxVal) {
            await page.keyboard.press('ArrowRight');
          }
        }

        // Fallback theo nấc chuẩn nếu ngôn ngữ giao diện khác Tiếng Việt / Tiếng Anh
        if (!matchedByLabel) {
          const fallbackVal =
            targetEffort === 'instant'
              ? minVal
              : targetEffort === 'standard'
                ? Math.min(minVal + 1, maxVal)
                : Math.min(minVal + 2, maxVal);
          const afterScanVal = Number(
            await slider.getAttribute('aria-valuenow').catch(() => String(maxVal))
          );
          const delta = fallbackVal - (Number.isNaN(afterScanVal) ? maxVal : afterScanVal);
          const key = delta > 0 ? 'ArrowRight' : 'ArrowLeft';
          for (let step = 0; step < Math.abs(delta); step += 1) {
            await page.keyboard.press(key);
            await sleep(70);
          }
          chosenVal = fallbackVal;
        }

        console.log(
          `[THINKING EFFORT]: Đã gạt thanh suy luận sang "${targetEffort}" (nấc ${chosenVal}/${maxVal}).`
        );
        await page.keyboard.press('Escape').catch(() => {});
        menuOpened = false;
        await sleep(250);
        return;
      }
    }

    // 2. Giao diện menu danh sách cổ điển ([role="menuitem"] / [role="menuitemradio"])
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
    const legacyUserRoots = Array.from(
      document.querySelectorAll(
        '[data-message-author-role="user"], [class*="bg-user-message"], [data-markdown-text-tone="user-message"], [class*="rich-text-user-turn"]'
      )
    );
    const convRoleUsers = Array.from(
      document.querySelectorAll('[data-conversation-role="user"]')
    );
    const userCount = Math.max(legacyUserRoots.length, convRoleUsers.length);

    const legacyAssistantTurns = Array.from(
      document.querySelectorAll(
        '[data-message-author-role="assistant"], [data-dil-response], [class*="DilResponseRoot"], article[data-turn="assistant"]'
      )
    );
    const convRoleAssistants = Array.from(
      document.querySelectorAll('[data-conversation-role="assistant"]')
    );

    let count = 0;
    let lastText = '';

    if (legacyAssistantTurns.length >= convRoleAssistants.length && legacyAssistantTurns.length > 0) {
      count = legacyAssistantTurns.length;
      const chosen = legacyAssistantTurns[legacyAssistantTurns.length - 1];
      lastText = (chosen.innerText || '').trim();
    } else if (convRoleAssistants.length > 0) {
      count = convRoleAssistants.length;
      const lastHeading = convRoleAssistants[convRoleAssistants.length - 1];
      const turnContainer =
        lastHeading.closest(
          '[data-local-conversation-final-assistant], [data-content-search-unit-key*=":assistant"]'
        ) ||
        lastHeading.parentElement?.parentElement ||
        lastHeading.parentElement;
      if (turnContainer) {
        // QUAN TRỌNG: Đọc trực tiếp turnContainer.innerText trên DOM đang gắn kết (KHÔNG dùng cloneNode,
        // vì cloneNode tách khỏi DOM làm Chromium gộp mất toàn bộ ký tự xuống dòng \n).
        lastText = (turnContainer.innerText || '')
          .replace(/^\s*(?:ChatGPT|Assistant)\s+(?:đã nói|said)\s*:\s*/i, '')
          .trim();
      }
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
        count = fallbackNodes.length;
        lastText = (fallbackNodes[fallbackNodes.length - 1].innerText || '').trim();
      }
    }

    return {
      userCount,
      count,
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
    await handlePluginMigrationBanner(page);
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
    await handlePluginMigrationBanner(page);
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

    // Thử kết nối qua IPv6 loopback [::1]:<port> (nơi Chrome --user-data-dir riêng lắng nghe mà không hiện popup)
    if (!String(cdpUrl).includes('[::1]')) {
      try {
        return await chromium.connectOverCDP(`http://[::1]:${targetPort}`);
      } catch (_ipv6Err) {
        // Tiếp tục fallback nếu [::1] không phản hồi
      }
    }

    if (String(err.message || '').includes('ECONNREFUSED')) {
      throw err;
    }

    const homeDir = os.homedir();
    const localAppData =
      process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
    const candidateFiles = [
      path.join(homeDir, '.chrome-mentor-profile', 'DevToolsActivePort'),
      path.join(homeDir, '.chrome-gemini-profile', 'DevToolsActivePort'),
      path.join(localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'),
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
  // Gemini: mở trang chủ nhẹ; prepareGeminiThread() sẽ điều hướng đúng luồng của Task/Gem sau đó
  // (tránh tải lại luồng cũ dài hàng trăm nghìn ký tự chỉ để rời đi ngay).
  const targetUrl = isGemini
    ? DEFAULT_GEMINI_URL
    : sessionMap.projectUrl || DEFAULT_PROJECT_URL;

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  return { browser, context, page };
}

/**
 * Ghi (upsert) luồng Gemini của một giai đoạn vào `sessionMap.geminiThreads` và lưu `SESSION_MAP.json`.
 * `geminiThreadUrl` (legacy) chỉ được cập nhật làm con trỏ "luồng dùng gần nhất".
 *
 * @param {object} sessionMap
 * @param {string} threadKey
 * @param {string} taskId
 * @param {string} url
 * @param {number} rounds
 * @returns {boolean} `true` nếu URL là một hội thoại Gemini hợp lệ và đã được lưu.
 */
export function recordGeminiThread(sessionMap, threadKey, taskId, url, rounds) {
  if (!sessionMap || !threadKey || !extractGeminiConversationId(url)) {
    return false;
  }
  if (!sessionMap.geminiThreads || typeof sessionMap.geminiThreads !== 'object') {
    sessionMap.geminiThreads = {};
  }
  sessionMap.geminiThreads[threadKey] = {
    url,
    rounds,
    updatedAt: new Date().toISOString(),
  };
  sessionMap.geminiThreadUrl = url;
  if (taskId) {
    sessionMap.currentTask = taskId;
  }
  saveSessionMap(sessionMap);
  return true;
}

/**
 * Điều hướng tab Gemini tới đúng luồng của Task & giai đoạn hiện tại (Per-Task Thread Rotation cho Gemini):
 * - Có URL trong `geminiThreads[threadKey]` và không có `--new-thread` -> mở lại đúng hội thoại cũ.
 *   Nếu hội thoại không còn tồn tại (Gemini chuyển hướng về trang chủ) -> tự động coi là luồng mới.
 * - Luồng mới -> mở `geminiGemUrl` (Gem "AI-WORKSPACE Mentor") nếu có cấu hình, ngược lại mở trang chủ Gemini.
 *
 * @param {import('playwright-core').Page} page
 * @param {{ existingThreadUrl?: string, isNewThread: boolean, gemUrl?: string }} options
 * @returns {Promise<{ effectiveNewThread: boolean, previousConversationId: string, landingUrl: string }>}
 */
export async function prepareGeminiThread(page, { existingThreadUrl = '', isNewThread, gemUrl = '' }) {
  const expectedId = extractGeminiConversationId(existingThreadUrl);

  if (!isNewThread && expectedId) {
    console.log(`[GEMINI THREAD]: Tiếp tục luồng hiện có của giai đoạn này: ${existingThreadUrl}`);
    await page.goto(existingThreadUrl, { waitUntil: 'domcontentloaded' });
    await sleep(2500);
    const landedId = extractGeminiConversationId(page.url());
    if (landedId === expectedId) {
      return { effectiveNewThread: false, previousConversationId: landedId, landingUrl: page.url() };
    }
    console.warn(
      `[GEMINI THREAD]: Không mở lại được luồng cũ (đang ở ${page.url()}), chuyển sang mở luồng mới kèm BOOTSTRAP.`
    );
  }

  const targetUrl = gemUrl || DEFAULT_GEMINI_URL;
  console.log(
    gemUrl
      ? `[GEMINI THREAD]: Mở đoạn chat mới bên trong Gem: ${gemUrl}`
      : `[GEMINI THREAD]: Mở đoạn chat Gemini mới tinh: ${DEFAULT_GEMINI_URL}`
  );
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  if (gemUrl && !GEMINI_GEM_URL_REGEX.test(page.url())) {
    console.warn(
      `[GEMINI GEM]: Không vào được Gem (đang ở ${page.url()}). Kiểm tra lại "geminiGemUrl" trong .agents/config.json — tạm dùng Gemini thường.`
    );
  }

  return {
    effectiveNewThread: true,
    previousConversationId: extractGeminiConversationId(page.url()),
    landingUrl: page.url(),
  };
}

/**
 * Chờ URL Gemini chuyển sang dạng hội thoại (`/app/<id>` hoặc `/gem/<gemId>/<id>`) sau khi gửi prompt.
 * Với luồng mới, bắt buộc mã hội thoại phải khác mã trước khi gửi.
 *
 * @param {import('playwright-core').Page} page
 * @param {string} previousConversationId
 * @param {boolean} effectiveNewThread
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<string>} URL hội thoại hoặc chuỗi rỗng nếu hết thời gian chờ.
 */
async function waitForGeminiConversationUrl(
  page,
  previousConversationId,
  effectiveNewThread,
  timeoutMs = 30_000
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    const id = extractGeminiConversationId(url);
    if (id && (!effectiveNewThread || id !== previousConversationId)) {
      return url;
    }
    await sleep(500);
  }
  return '';
}

/**
 * Gửi prompt tới giao diện Gemini Web và lưu phản hồi vào `.agents/state/GEMINI_FEEDBACK.md`
 * kèm lưu URL luồng vào `SESSION_MAP.json` -> `geminiThreads[threadKey]` (xoay vòng theo Task & giai đoạn).
 *
 * @param {import('playwright-core').Page} page
 * @param {string} promptText
 * @param {object} sessionMap
 * @param {{ threadKey?: string, taskId?: string, rounds?: number, previousConversationId?: string, effectiveNewThread?: boolean }} [threadOptions={}]
 * @returns {Promise<string>}
 */
export async function askGemini(page, promptText, sessionMap = {}, threadOptions = {}) {
  const {
    threadKey = '',
    taskId = '',
    rounds = 1,
    previousConversationId = extractGeminiConversationId(page.url()),
    effectiveNewThread = false,
    onPromptSubmitted = null,
  } = threadOptions;
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
    const raw = String(text);
    const sel = window.getSelection();
    if (sel) {
      sel.selectAllChildren(el);
    }

    // Ưu tiên dán nguyên khối qua ClipboardEvent('paste') để Quill (rich-textarea) không hiểu nhầm \n đầu tiên là phím Enter gửi tin nhắn
    let pasted = false;
    if (typeof DataTransfer !== 'undefined' && typeof ClipboardEvent !== 'undefined') {
      el.textContent = '';
      const dt = new DataTransfer();
      dt.setData('text/plain', raw);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      el.dispatchEvent(pasteEvent);
      pasted = (el.innerText || el.textContent || '').trim().length >= Math.min(20, raw.length);
    }

    if (!pasted) {
      el.textContent = '';
      const inserted =
        typeof document.execCommand === 'function'
          ? document.execCommand('insertText', false, raw)
          : false;
      if (!inserted || !el.textContent) {
        el.textContent = raw;
      }
    }

    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: raw,
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

  if (typeof onPromptSubmitted === 'function') {
    onPromptSubmitted();
  }

  // Lưu sớm URL hội thoại vào geminiThreads ngay khi Gemini cấp /app/<id> (phòng khi phản hồi bị gián đoạn)
  if (threadKey) {
    const earlyUrl = await waitForGeminiConversationUrl(
      page,
      previousConversationId,
      effectiveNewThread,
      20_000
    );
    if (recordGeminiThread(sessionMap, threadKey, taskId, earlyUrl, rounds)) {
      console.log(
        `[SESSION_MAP]: Đã lưu luồng Gemini cho "${threadKey}" (rounds=${rounds}): ${earlyUrl}`
      );
    } else {
      console.warn(
        `[SESSION_MAP]: Chưa nhận được URL hội thoại Gemini cho "${threadKey}", sẽ thử lại sau khi có phản hồi.`
      );
    }
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
  if (threadKey) {
    recordGeminiThread(sessionMap, threadKey, taskId, currentUrl, rounds);
  } else if (currentUrl && currentUrl.includes('gemini.google.com')) {
    // Tương thích ngược khi gọi askGemini() không kèm threadOptions
    sessionMap.geminiThreadUrl = currentUrl;
    saveSessionMap(sessionMap);
  }

  console.log(
    `[GEMINI]: Đã lưu phản hồi vào .agents/state/GEMINI_FEEDBACK.md (${lastText.length} ký tự).`
  );
  return lastText;
}

/**
 * Chuẩn bị kế hoạch prompt cho một provider (hàm thuần trên dữ liệu đã đọc, phục vụ cả --dry-run và chạy thật).
 */
function prepareProviderPromptPlan({
  provider,
  mode,
  taskId,
  threadKey,
  sessionMap,
  newThread,
  planContent,
  roadmapContent,
  handoffContent,
  errorSummary,
  reviewSnapshot,
  selectedRoles,
  reviewResponseContent = '',
  secondOpinionBlock = '',
  effectiveNewThreadOverride = null,
}) {
  let isProviderNewThread;
  if (typeof effectiveNewThreadOverride === 'boolean') {
    isProviderNewThread = effectiveNewThreadOverride;
  } else if (provider === 'gemini') {
    const url = sessionMap.geminiThreads?.[threadKey]?.url || '';
    isProviderNewThread = Boolean(newThread || !extractGeminiConversationId(url));
  } else {
    const entry =
      sessionMap.threads?.[threadKey] ||
      (mode === 'plan' ? sessionMap.threads?.[taskId] : null);
    const url = entry && typeof entry.url === 'string' ? entry.url.trim() : '';
    isProviderNewThread = Boolean(newThread || !url);
  }

  const usedRounds = getStageRounds(sessionMap, threadKey, provider);
  const maxRounds = resolveMaxRounds(WORKFLOW_CONFIG.maxReviewRounds, provider, mode);
  const nextRound = usedRounds + 1;
  const ledger = loadLedger(REVIEW_LEDGER_FILE);
  const openIssues = getOpenIssues(ledger, threadKey, provider);
  const convergenceBlock =
    mode !== 'rescue' ? buildConvergenceBlock(openIssues, nextRound) : '';

  let decision = { kind: 'full', reason: mode };
  let diffText = null;
  if (mode === 'plan') {
    const prevSnap = readSnapshot(snapshotPath(STATE_DIR, threadKey, provider));
    diffText = prevSnap != null ? computeUnifiedDiff(prevSnap, planContent) : null;
    decision = decidePlanPayload({
      effectiveNewThread: isProviderNewThread,
      usedRounds,
      previousSnapshot: prevSnap,
      planContent,
      diffText,
    });
  }

  const planBodyOverride =
    mode === 'plan' && decision.kind === 'delta'
      ? buildPlanDeltaBody(diffText, reviewResponseContent)
      : '';
  const bootstrapBlock = isProviderNewThread
    ? buildBootstrapContext(
        taskId,
        roadmapContent,
        handoffContent,
        REVIEW_SCOPE,
        provider === 'gemini' && mode !== 'plan' ? planContent : ''
      )
    : '';
  const { prompt, positiveTestExitCode } = buildMentorPrompt(
    mode,
    planContent,
    errorSummary,
    bootstrapBlock,
    reviewSnapshot,
    selectedRoles,
    {
      planBodyOverride,
      convergenceBlock,
      secondOpinionBlock,
      includeSeverityRules: mode !== 'rescue',
    }
  );

  return {
    provider,
    isProviderNewThread,
    usedRounds,
    maxRounds,
    nextRound,
    openIssues,
    decision,
    prompt,
    positiveTestExitCode,
  };
}

/**
 * Đánh giá phản hồi của một Mentor theo Severity Gate + Convergence Rule,
 * ghi vào REVIEW_LEDGER.json + TECH_DEBT.md và trả về văn bản đã chuẩn hóa dòng STATUS.
 */
function evaluateAndRecordMentorResponse({
  provider,
  mode,
  threadKey,
  round,
  responseText,
  positiveTestExitCode = 0,
  url = '',
}) {
  const rawStatus = detectApprovalStatus(responseText, mode);
  if (mode === 'rescue') {
    const normalizedText = [
      'STATUS: REJECTED',
      `<!-- RESCUE_MODE_GUIDANCE (${new Date().toISOString()}) -->`,
      '',
      responseText,
      '',
    ].join('\n');
    return {
      provider,
      rawStatus: 'REJECTED',
      status: 'REJECTED',
      report: { structured: false, p0: [], p1: [], p2: [], statuses: {} },
      warnings: [],
      normalizedText,
      url,
    };
  }

  const report = parseSeverityReport(responseText);
  const ledger = loadLedger(REVIEW_LEDGER_FILE);
  const prevOpen = getOpenIssues(ledger, threadKey, provider);
  const gate = applySeverityGate(rawStatus, report);
  const warnings = [...gate.warnings];
  const convViolations = detectConvergenceViolations(report, prevOpen, round);
  if (convViolations.length > 0) {
    warnings.push('CONVERGENCE_VIOLATION');
  }
  for (const w of warnings) {
    console.warn(
      `[POLICY WARNING - ${provider.toUpperCase()}]: ${w} — ${WARNING_TEXT[w] || w}`
    );
  }

  let finalStatus = gate.status;
  if (mode === 'review-code' && positiveTestExitCode !== 0) {
    finalStatus = 'REJECTED';
  }

  const nonBlocking = [...report.p1, ...report.p2].map((item) => ({
    ...item,
    late: round >= 2,
  }));
  const addedDebt = appendTechDebt(TECH_DEBT_FILE, nonBlocking, {
    threadKey,
    provider,
    round,
  });
  if (addedDebt > 0) {
    console.log(
      `[TECH_DEBT]: Đã ghi thêm ${addedDebt} mục P1/P2 không chặn từ ${provider} vào .agents/state/TECH_DEBT.md.`
    );
  }

  appendLedgerRound(ledger, threadKey, provider, {
    round,
    status: finalStatus,
    rawStatus,
    p0: report.p0,
    p1: report.p1,
    p2: report.p2,
    warnings,
    at: new Date().toISOString(),
  });
  saveLedger(REVIEW_LEDGER_FILE, ledger);

  const normalizedText = normalizeMentorFeedback(responseText, finalStatus, mode);
  return {
    provider,
    rawStatus,
    status: finalStatus,
    report,
    warnings,
    normalizedText,
    url,
  };
}

function clearEscalationIfPresent(threadKey) {
  if (!fs.existsSync(HANDOFF_FILE)) return;
  const current = fs.readFileSync(HANDOFF_FILE, 'utf8');
  if (hasEscalation(current, threadKey)) {
    fs.writeFileSync(HANDOFF_FILE, removeEscalation(current, threadKey), 'utf8');
    console.log(`[ESCALATION]: Đã xóa khối ESCALATION của "${threadKey}" khỏi HANDOFF.md.`);
  }
}

function recordEscalationAndThrow({
  taskId,
  threadKey,
  mode,
  reason,
  targetProviders,
  sessionMap,
}) {
  const budget = checkRoundBudget(
    sessionMap,
    threadKey,
    targetProviders,
    WORKFLOW_CONFIG.maxReviewRounds,
    mode
  ).details;
  const ledger = loadLedger(REVIEW_LEDGER_FILE);
  const openIssues = {};
  const lastStatus = {};
  for (const p of ['chatgpt', 'gemini']) {
    openIssues[p] = getOpenIssues(ledger, threadKey, p);
    const rounds = ledger?.[threadKey]?.[p];
    if (Array.isArray(rounds) && rounds.length > 0) {
      lastStatus[p] = rounds[rounds.length - 1].status;
    }
  }
  const block = renderEscalationBlock({
    taskId,
    threadKey,
    reason,
    budget,
    openIssues,
    lastStatus,
  });
  const currentHandoff = readFileSafe(HANDOFF_FILE);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    HANDOFF_FILE,
    upsertEscalation(currentHandoff, threadKey, block),
    'utf8'
  );
  throw new EscalationError(
    `[ESCALATION - EXIT ${ESCALATION_EXIT_CODE}]: ${reason} — Đã ghi khối ESCALATION vào .agents/state/HANDOFF.md. Agent phải DỪNG lại chờ người quyết định.`
  );
}

async function main() {
  const {
    mode,
    provider,
    taskArg,
    roleArg,
    effortArg,
    newThread,
    dryRun,
    resetRounds,
    ensureProject,
    errorSummary,
    model,
    projectName,
    cdpUrl,
    composerArg,
  } = parseArgs(process.argv.slice(2));
  const composerMode = resolveComposerMode(composerArg, WORKFLOW_CONFIG);
  const chatgptModel = (model || WORKFLOW_CONFIG.chatgptModel || '').trim();
  const selectedRoles = resolveSpecialistRoles(roleArg, mode);
  const dualPolicy = resolveDualMentorPolicy(WORKFLOW_CONFIG.dualMentorPolicy);
  // Khi --provider both: chạy Gemini trước để đưa P0 của Gemini vào prompt ChatGPT (Second Opinion)
  const targetProviders =
    provider === 'both' ? ['gemini', 'chatgpt'] : [provider];

  // Chế độ --ensure-project: kết nối Chrome (9222), tự tìm hoặc tạo mới Project trùng tên dự án Antigravity
  if (ensureProject) {
    const sessionMap = loadSessionMap();
    const targetProjectName = (projectName || DEFAULT_PROJECT_NAME).trim();
    const runtimeConfig = { ...WORKFLOW_CONFIG, cdpUrl };
    let conn = null;
    try {
      conn = await connectProviderPage('chatgpt', runtimeConfig, sessionMap);
      const resolvedUrl = await ensureProjectUrl(conn.page, sessionMap, targetProjectName);
      if (!/^https:\/\/chatgpt\.com\/g\/g-p-[a-z0-9]+/i.test(resolvedUrl)) {
        throw new Error(`Chưa xác nhận được URL Project hợp lệ cho "${targetProjectName}" (nhận được: ${resolvedUrl}).`);
      }
      console.log(`[PROJECT READY]: "${targetProjectName}" -> ${resolvedUrl}`);
      if (!conn.page.url().includes('/project')) {
        await conn.page.goto(resolvedUrl, { waitUntil: 'domcontentloaded' });
        await sleep(2500);
      }
      await ensureProjectComposerMode(conn.page, composerMode);
      return;
    } finally {
      if (conn?.browser) {
        await conn.browser.close().catch(() => {});
      }
    }
  }

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
  const reviewResponseContent = readFileSafe(REVIEW_RESPONSE_FILE).trim();
  const sessionMap = loadSessionMap();

  const taskId = resolveCurrentTaskId(
    taskArg,
    planContent,
    roadmapContent,
    sessionMap
  );
  const threadKey = getThreadKey(taskId, mode);

  // Xử lý --reset-rounds (chỉ dành cho người; có ghi vết vào stageRounds[threadKey].resets)
  if (resetRounds) {
    const resetList = provider === 'both' ? ['chatgpt', 'gemini'] : [provider];
    resetStageRounds(sessionMap, threadKey, resetList);
    saveSessionMap(sessionMap);
    clearEscalationIfPresent(threadKey);
    console.log(
      `[RESET ROUNDS]: Đã đặt lại bộ đếm vòng của "${threadKey}" cho [${resetList.join(', ')}] và xóa khối ESCALATION (nếu có).`
    );
    return;
  }

  let reviewSnapshot = null;
  if (mode !== 'plan') {
    reviewSnapshot = collectReviewSnapshot(REPO_ROOT);
  }

  // Bước 0: Chế độ --dry-run (kiểm chứng toàn bộ quyết định mà KHÔNG chạm Chrome và KHÔNG ghi .agents/state/*)
  const budgetCheck = checkRoundBudget(
    sessionMap,
    threadKey,
    targetProviders,
    WORKFLOW_CONFIG.maxReviewRounds,
    mode
  );
  const initialPlans = {};
  for (const p of targetProviders) {
    initialPlans[p] = prepareProviderPromptPlan({
      provider: p,
      mode,
      taskId,
      threadKey,
      sessionMap,
      newThread,
      planContent,
      roadmapContent,
      handoffContent,
      errorSummary,
      reviewSnapshot,
      selectedRoles,
      reviewResponseContent,
    });
  }

  if (dryRun) {
    for (const p of targetProviders) {
      const plan = initialPlans[p];
      const outFile = path.join(
        os.tmpdir(),
        `dry_run_prompt_${threadKey}_${p}_${Date.now()}_${process.pid}.txt`
      );
      fs.writeFileSync(outFile, plan.prompt, 'utf8');
      console.log(
        `[DRY-RUN]: provider=${p} | stage=${threadKey} | round=${plan.nextRound}/${plan.maxRounds} (used=${plan.usedRounds}) | thread=${plan.isProviderNewThread ? 'NEW' : 'CONTINUE'} | payload=${plan.decision.kind.toUpperCase()} (${plan.decision.reason}) | chars=${plan.prompt.length} | promptFile=${outFile}`
      );
    }
    if (!budgetCheck.ok) {
      console.error(
        `[DRY-RUN][ESCALATION]: Đã hết ngân sách vòng cho [${budgetCheck.exhausted.join(', ')}] ở giai đoạn "${threadKey}". (Exit code ${ESCALATION_EXIT_CODE})`
      );
      process.exitCode = ESCALATION_EXIT_CODE;
      return;
    }
    const unchangedProviders = targetProviders.filter(
      (p) => mode === 'plan' && initialPlans[p].decision.kind === 'unchanged'
    );
    if (unchangedProviders.length > 0) {
      console.error(
        `[DRY-RUN][UNCHANGED]: CURRENT_PLAN.md không đổi so với snapshot đã gửi cho [${unchangedProviders.join(', ')}]. (Exit code 1)`
      );
      process.exitCode = 1;
      return;
    }
    return;
  }

  // Bước 1 & 5: Kiểm tra ngân sách vòng TRƯỚC Pre-Send Reset (không làm mất STATUS: APPROVED đang có)
  if (!budgetCheck.ok) {
    const exhaustedDesc = budgetCheck.details
      .filter((d) => d.used >= d.max)
      .map((d) => `${d.provider} (${d.used}/${d.max})`)
      .join(', ');
    recordEscalationAndThrow({
      taskId,
      threadKey,
      mode,
      reason: `Đã đạt giới hạn vòng review cho giai đoạn "${threadKey}": ${exhaustedDesc}`,
      targetProviders,
      sessionMap,
    });
  }

  // Bước 4: Chặn gửi lại CURRENT_PLAN.md không thay đổi (TRƯỚC Pre-Send Reset, không đốt vòng)
  if (mode === 'plan') {
    const unchanged = targetProviders.filter(
      (p) => initialPlans[p].decision.kind === 'unchanged'
    );
    if (unchanged.length > 0) {
      throw new Error(
        `[DELTA REVIEW]: CURRENT_PLAN.md không thay đổi so với lần gửi gần nhất cho [${unchanged.join(', ')}] ở "${threadKey}". Hãy cập nhật kế hoạch trước khi gửi lại (không tốn vòng review).`
      );
    }
  }

  const uniqueBundleName = `review_bundle_${Date.now()}_${process.pid}.txt`;
  const tempBundlePath = path.join(os.tmpdir(), uniqueBundleName);
  if (mode !== 'plan' && reviewSnapshot) {
    fs.writeFileSync(tempBundlePath, reviewSnapshot.fullBundleText, 'utf8');
  }

  const roleSummary = selectedRoles.map((r) => `${r.key} (${r.name})`).join(', ');
  for (const p of targetProviders) {
    const plan = initialPlans[p];
    console.log(
      `[PAYLOAD INFO]: Provider="${p}" | Giai đoạn "${threadKey}" (Vòng ${plan.nextRound}/${plan.maxRounds}) | Chế độ gửi: ${plan.decision.kind.toUpperCase()} | Chuyên gia: [${roleSummary}] | Kích thước prompt: ${plan.prompt.length} ký tự.`
    );
  }

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
  let geminiResult = null;

  try {
    // 2A. Nếu chạy Gemini (độc lập hoặc chạy trước trong --provider both để lấy Second Opinion)
    if (provider === 'gemini' || provider === 'both') {
      try {
        const geminiConn = await connectProviderPage(
          'gemini',
          runtimeConfig,
          sessionMap,
          chatgptBrowser
        );
        geminiBrowser = geminiConn.browser;

        const geminiExistingEntry = sessionMap.geminiThreads?.[threadKey] || null;
        const geminiExistingUrl =
          geminiExistingEntry && typeof geminiExistingEntry.url === 'string'
            ? geminiExistingEntry.url.trim()
            : '';
        const geminiIsNewThread = Boolean(
          newThread || !extractGeminiConversationId(geminiExistingUrl)
        );
        const gemUrl = normalizeGeminiGemUrl(runtimeConfig.geminiGemUrl);
        if (runtimeConfig.geminiGemUrl && !gemUrl) {
          console.warn(
            `[GEMINI GEM]: "geminiGemUrl" trong .agents/config.json không hợp lệ (cần dạng https://gemini.google.com/gem/<id>), bỏ qua.`
          );
        }

        const geminiThread = await prepareGeminiThread(geminiConn.page, {
          existingThreadUrl: geminiExistingUrl,
          isNewThread: geminiIsNewThread,
          gemUrl,
        });
        const geminiPlan = prepareProviderPromptPlan({
          provider: 'gemini',
          mode,
          taskId,
          threadKey,
          sessionMap,
          newThread,
          planContent,
          roadmapContent,
          handoffContent,
          errorSummary,
          reviewSnapshot,
          selectedRoles,
          reviewResponseContent,
          effectiveNewThreadOverride: geminiThread.effectiveNewThread,
        });
        let geminiStageRound = geminiPlan.nextRound;
        console.log(
          `[GEMINI PAYLOAD]: Giai đoạn "${threadKey}" | ${geminiThread.effectiveNewThread ? 'Luồng MỚI (kèm BOOTSTRAP)' : `Tiếp tục luồng cũ`} | Vòng ${geminiPlan.nextRound}/${geminiPlan.maxRounds} | Payload=${geminiPlan.decision.kind.toUpperCase()}${gemUrl ? ' | Gem: ' + gemUrl : ''} | Kích thước prompt: ${geminiPlan.prompt.length} ký tự.`
        );

        const geminiResponseText = await askGemini(
          geminiConn.page,
          geminiPlan.prompt,
          sessionMap,
          {
            threadKey,
            taskId,
            rounds: geminiPlan.nextRound,
            previousConversationId: geminiThread.previousConversationId,
            effectiveNewThread: geminiThread.effectiveNewThread,
            onPromptSubmitted: () => {
              geminiStageRound = incrementStageRound(
                sessionMap,
                threadKey,
                'gemini'
              );
              saveSessionMap(sessionMap);
              if (mode === 'plan') {
                writeSnapshot(
                  snapshotPath(STATE_DIR, threadKey, 'gemini'),
                  planContent
                );
              }
            },
          }
        );

        geminiResult = evaluateAndRecordMentorResponse({
          provider: 'gemini',
          mode,
          threadKey,
          round: geminiStageRound,
          responseText: geminiResponseText,
          positiveTestExitCode: geminiPlan.positiveTestExitCode,
          url: geminiConn.page.url(),
        });
        fs.writeFileSync(
          GEMINI_FEEDBACK_FILE,
          geminiResult.normalizedText,
          'utf8'
        );
        console.log(`GEMINI_STATUS: ${geminiResult.status}`);

        if (provider === 'gemini') {
          if (geminiResult.status === 'APPROVED') {
            clearEscalationIfPresent(threadKey);
          } else if (geminiStageRound >= geminiPlan.maxRounds) {
            recordEscalationAndThrow({
              taskId,
              threadKey,
              mode,
              reason: `Gemini trả về REJECTED ở vòng cuối cùng (${geminiStageRound}/${geminiPlan.maxRounds}) của "${threadKey}"`,
              targetProviders: ['gemini'],
              sessionMap,
            });
          }
        }
      } catch (geminiErr) {
        if (
          provider === 'both' &&
          dualPolicy === 'chatgpt-gate' &&
          !(geminiErr instanceof EscalationError)
        ) {
          console.warn(
            `[GEMINI ADVISORY WARNING]: Gemini gặp lỗi (${geminiErr.message}) — tiếp tục gửi ChatGPT vì dualMentorPolicy="chatgpt-gate".`
          );
          geminiResult = { unavailable: true, error: geminiErr.message };
          fs.writeFileSync(
            GEMINI_FEEDBACK_FILE,
            `STATUS: UNAVAILABLE\n\nGemini không phản hồi được ở vòng này: ${geminiErr.message}\n`,
            'utf8'
          );
        } else {
          throw geminiErr;
        }
      }
    }

    // 2B. Chạy ChatGPT (cổng quyết định chính)
    if (provider === 'chatgpt' || provider === 'both') {
      const existingThreadEntry =
        sessionMap.threads[threadKey] ||
        (mode === 'plan' ? sessionMap.threads[taskId] : null);
      const existingThreadUrl =
        existingThreadEntry && typeof existingThreadEntry.url === 'string'
          ? existingThreadEntry.url.trim()
          : '';
      const isNewThread = Boolean(newThread || !existingThreadUrl);

      const conn = await connectProviderPage(
        'chatgpt',
        runtimeConfig,
        sessionMap,
        geminiBrowser
      );
      chatgptBrowser = conn.browser;
      const page = conn.page;

      const { previousConversationId, effectiveNewThread } =
        await prepareTaskThread(page, {
          existingThreadUrl,
          isNewThread,
          projectUrl: sessionMap.projectUrl,
          model,
          projectName,
          sessionMap,
          composerMode,
        });

      const secondOpinionBlock =
        provider === 'both' && mode !== 'rescue'
          ? buildSecondOpinionBlock(geminiResult)
          : '';
      const chatgptPlan = prepareProviderPromptPlan({
        provider: 'chatgpt',
        mode,
        taskId,
        threadKey,
        sessionMap,
        newThread,
        planContent,
        roadmapContent,
        handoffContent,
        errorSummary,
        reviewSnapshot,
        selectedRoles,
        reviewResponseContent,
        secondOpinionBlock,
        effectiveNewThreadOverride: effectiveNewThread,
      });
      const reviewPrompt = chatgptPlan.prompt;
      const positiveTestExitCode = chatgptPlan.positiveTestExitCode;

      const promptTextarea = page.locator(PROMPT_SELECTOR).first();
      await promptTextarea.waitFor({ state: 'visible', timeout: 60_000 });

      if (composerMode === 'work' && chatgptModel) {
        await selectChatGptModel(page, chatgptModel);
      }
      await setThinkingEffort(page, mode, effortArg);

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

      if (composerMode === 'chat') {
        console.log(
          '[ROLE MENTION]: Chế độ "Trò chuyện" không hỗ trợ @Plugin — dùng khối Role Header trong prompt thay thế.'
        );
      } else {
        await tryInvokeGptMention(page, promptTextarea, selectedRoles);
      }
      await fillPromptFast(promptTextarea, reviewPrompt);
      await page.keyboard.press('Space').catch(() => {});

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

      let submittedConfirmed = false;
      const submitStart = Date.now();
      while (Date.now() - submitStart < 15_000) {
        const state = await getAssistantState(page).catch(() => ({
          userCount: 0,
        }));
        const isGeneratingNow =
          (await stopLocator.count().catch(() => 0)) > 0;
        const remainingEditorLen = await promptTextarea
          .evaluate((el) => (el.innerText || '').trim().length)
          .catch(() => 999);
        if (
          state.userCount > previousUserCount ||
          isGeneratingNow ||
          remainingEditorLen === 0
        ) {
          submittedConfirmed = true;
          break;
        }
        if (await sendButton.isVisible().catch(() => false)) {
          await sendButton.click().catch(() => {});
        } else {
          await promptTextarea.press('Enter').catch(() => {});
        }
        await sleep(500);
      }

      if (!submittedConfirmed) {
        throw new Error(
          'Không gửi được prompt trên giao diện ChatGPT sau 15s (nút Gửi chưa kích hoạt hoặc giao diện bị chặn).'
        );
      }

      // Tăng bộ đếm stageRounds của ChatGPT ngay khi đã gửi thành công (không phụ thuộc --new-thread)
      const chatgptStageRound = incrementStageRound(
        sessionMap,
        threadKey,
        'chatgpt'
      );
      if (mode === 'plan') {
        writeSnapshot(
          snapshotPath(STATE_DIR, threadKey, 'chatgpt'),
          planContent
        );
      }

      const activeThreadUrl = await waitForConversationUrl(
        page,
        previousConversationId,
        effectiveNewThread
      );
      sessionMap.currentTask = taskId;
      if (CONVERSATION_URL_REGEX.test(activeThreadUrl)) {
        sessionMap.threads[threadKey] = {
          url: activeThreadUrl,
          rounds: chatgptStageRound,
          updatedAt: new Date().toISOString(),
        };
        sessionMap.threads[taskId] = {
          url: activeThreadUrl,
          rounds: chatgptStageRound,
          updatedAt: new Date().toISOString(),
        };
      }
      saveSessionMap(sessionMap);
      if (CONVERSATION_URL_REGEX.test(activeThreadUrl)) {
        console.log(
          `[SESSION_MAP]: Đã lưu URL luồng ChatGPT vào "${taskId}" và "${threadKey}" (stageRound=${chatgptStageRound}/${chatgptPlan.maxRounds}): ${activeThreadUrl}`
        );
      }

      const responseText = await waitForStableAssistantResponse(
        page,
        previousUserCount,
        previousAssistantCount,
        600_000,
        mode
      );

      const finalUrl = page.url();
      sessionMap.currentTask = taskId;
      if (CONVERSATION_URL_REGEX.test(finalUrl)) {
        sessionMap.threads[threadKey] = {
          url: finalUrl,
          rounds: chatgptStageRound,
          updatedAt: new Date().toISOString(),
        };
        sessionMap.threads[taskId] = {
          url: finalUrl,
          rounds: chatgptStageRound,
          updatedAt: new Date().toISOString(),
        };
        saveSessionMap(sessionMap);
      }

      fs.mkdirSync(STATE_DIR, { recursive: true });
      const chatgptEval = evaluateAndRecordMentorResponse({
        provider: 'chatgpt',
        mode,
        threadKey,
        round: chatgptStageRound,
        responseText,
        positiveTestExitCode,
        url: finalUrl,
      });

      let finalStatus = chatgptEval.status;
      let advisorySuffix = '';
      if (provider === 'both' && mode !== 'rescue') {
        const dual = combineDualStatus(
          chatgptEval.status,
          geminiResult,
          dualPolicy
        );
        finalStatus = dual.finalStatus;
        advisorySuffix = renderAdvisorySection(geminiResult, dualPolicy);
        console.log(
          `[DUAL MENTOR]: ChatGPT=${chatgptEval.status} | Gemini=${dual.geminiStatus} -> ${dual.consensus} (policy=${dualPolicy}, final=${finalStatus})`
        );
      }

      if (mode === 'review-code') {
        const outputText =
          normalizeMentorFeedback(responseText, finalStatus, 'review-code') +
          advisorySuffix;
        fs.writeFileSync(CODE_REVIEW_FILE, outputText, 'utf8');
        if (finalStatus === 'APPROVED') {
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
          clearEscalationIfPresent(threadKey);
        }
        console.log(`CODE_STATUS: ${finalStatus}`);
      } else if (mode === 'rescue') {
        fs.writeFileSync(FEEDBACK_FILE, chatgptEval.normalizedText, 'utf8');
        console.log('RESCUE_GUIDANCE_SAVED');
      } else {
        const outputText =
          normalizeMentorFeedback(responseText, finalStatus, 'plan') +
          advisorySuffix;
        fs.writeFileSync(FEEDBACK_FILE, outputText, 'utf8');
        if (finalStatus === 'APPROVED') {
          saveStateLock(
            {
              taskId,
              planHash: computePlanHash(REPO_ROOT),
              codeDiffHash: '',
              updatedAt: new Date().toISOString(),
            },
            REPO_ROOT
          );
          clearEscalationIfPresent(threadKey);
        }
        console.log(`STATUS: ${finalStatus}`);
      }

      if (
        finalStatus === 'REJECTED' &&
        chatgptStageRound >= chatgptPlan.maxRounds
      ) {
        recordEscalationAndThrow({
          taskId,
          threadKey,
          mode,
          reason:
            mode === 'rescue'
              ? `Đã dùng hết ${chatgptStageRound}/${chatgptPlan.maxRounds} lượt RESCUE (Circuit Breaker) cho "${threadKey}"`
              : `ChatGPT trả về REJECTED ở vòng cuối cùng (${chatgptStageRound}/${chatgptPlan.maxRounds}) của "${threadKey}"`,
          targetProviders,
          sessionMap,
        });
      }
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
    process.exitCode =
      err && typeof err.exitCode === 'number' ? err.exitCode : 1;
  });
}
