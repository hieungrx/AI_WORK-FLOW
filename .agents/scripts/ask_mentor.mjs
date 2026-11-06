#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  computePlanSha256,
  computeCodeSha256,
  saveStateLock,
} from './verify_guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const DEFAULT_CDP_URL = 'http://localhost:9222';
const DEFAULT_PROJECT_URL = 'https://chatgpt.com/';
const DEFAULT_MODE = 'plan';
const VALID_MODES = new Set(['plan', 'review-code', 'rescue']);
const MAX_DIFF_CHARS = 120_000;

const STATE_DIR = path.join(REPO_ROOT, '.agents', 'state');
const PLAN_FILE = path.join(STATE_DIR, 'CURRENT_PLAN.md');
const ROADMAP_FILE = path.join(STATE_DIR, 'ROADMAP.md');
const HANDOFF_FILE = path.join(STATE_DIR, 'HANDOFF.md');
const FEEDBACK_FILE = path.join(STATE_DIR, 'MENTOR_FEEDBACK.md');
const CODE_REVIEW_FILE = path.join(STATE_DIR, 'CODE_REVIEW_FEEDBACK.md');
const SESSION_MAP_FILE = path.join(STATE_DIR, 'SESSION_MAP.json');
const SOURCE_DIR_NAME = 'src';

const PROMPT_SELECTOR =
  '#prompt-textarea, div.ProseMirror[data-composer-markdown], div.ProseMirror[contenteditable="true"][aria-label*="ChatGPT"], [contenteditable="true"][aria-label*="ChatGPT"]';
const SEND_BUTTON_SELECTOR =
  '[data-testid="send-button"], button[aria-label="Gửi"], button[aria-label*="Gửi"], button[aria-label="Send prompt"], button[aria-label*="Send"]';
const STOP_BUTTON_SELECTOR =
  '[data-testid="stop-button"], button[aria-label*="Dừng"], button[aria-label*="Stop"]';
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
 * Chuẩn hóa tham số CLI:
 * - Bỏ hẳn tham số mặc định `--model gpt-4o`.
 * - Hỗ trợ `--mode <plan|review-code|rescue>` (mặc định: `plan`).
 * - Hỗ trợ `--task <task_id>` và `--new-thread` cho tính năng xoay vòng luồng chat theo Task.
 * - Hỗ trợ `--error "<tóm tắt lỗi>"` cho chế độ `rescue`.
 *
 * @param {string[]} argv
 * @returns {{ mode: 'plan' | 'review-code' | 'rescue', taskArg: string, newThread: boolean, errorSummary: string, model: string, cdpUrl: string }}
 */
function parseArgs(argv) {
  let mode = DEFAULT_MODE;
  let taskArg = '';
  let newThread = false;
  let errorSummary = '';
  let model = '';
  let cdpUrl = process.env.CDP_URL || DEFAULT_CDP_URL;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode' && i + 1 < argv.length) {
      mode = argv[i + 1].trim().toLowerCase();
      i += 1;
    } else if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length).trim().toLowerCase();
    } else if (arg === '--task' && i + 1 < argv.length) {
      taskArg = normalizeTaskId(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--task=')) {
      taskArg = normalizeTaskId(arg.slice('--task='.length));
    } else if (arg === '--new-thread') {
      newThread = true;
    } else if (arg === '--error' && i + 1 < argv.length) {
      errorSummary = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--error=')) {
      errorSummary = arg.slice('--error='.length).trim();
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

  return {
    mode,
    taskArg,
    newThread,
    errorSummary,
    model,
    cdpUrl,
  };
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
 * Đọc cấu hình `.agents/state/SESSION_MAP.json`.
 * Nếu chưa tồn tại hoặc lỗi cú pháp, trả về cấu trúc mặc định.
 *
 * @returns {{ projectUrl: string, currentTask: string, threads: Record<string, { url: string, updatedAt: string }> }}
 */
function loadSessionMap() {
  const fallback = {
    projectUrl: DEFAULT_PROJECT_URL,
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
    const projectUrl =
      typeof parsed.projectUrl === 'string' && parsed.projectUrl.trim()
        ? parsed.projectUrl.trim()
        : DEFAULT_PROJECT_URL;
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
            updatedAt:
              typeof val.updatedAt === 'string'
                ? val.updatedAt
                : new Date().toISOString(),
          };
        }
      }
    }
    return { projectUrl, currentTask, threads };
  } catch (_err) {
    return fallback;
  }
}

/**
 * Ghi cấu trúc `SESSION_MAP.json` xuống đĩa.
 *
 * @param {{ projectUrl: string, currentTask: string, threads: Record<string, { url: string, updatedAt: string }> }} sessionMap
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
 * Xây dựng khối `--- NGỮ CẢNH BÀN GIAO DỰ ÁN (BOOTSTRAP) ---` từ `ROADMAP.md` và `HANDOFF.md`
 * khi bắt đầu luồng chat mới cho một Task mới.
 *
 * @param {string} taskId
 * @param {string} roadmapContent
 * @param {string} handoffContent
 * @returns {string}
 */
function buildBootstrapContext(taskId, roadmapContent, handoffContent) {
  const safeRoadmap = roadmapContent || '(Chưa có nội dung ROADMAP.md)';
  const safeHandoff = handoffContent || '(Chưa có nội dung HANDOFF.md)';

  return [
    '--- NGỮ CẢNH BÀN GIAO DỰ ÁN (BOOTSTRAP) ---',
    `Task hiện tại: ${taskId}`,
    'Đây là phiên làm việc (thread) mới được khởi tạo riêng cho Task này theo cơ chế Per-Task Thread Rotation.',
    'Dưới đây là toàn bộ lộ trình dự án (ROADMAP.md) và biên bản bàn giao từ các Task trước (HANDOFF.md, bao gồm tiến độ và danh sách Technical Debt):',
    '',
    '=== BẮT ĐẦU .agents/state/ROADMAP.md ===',
    safeRoadmap,
    '=== KẾT THÚC .agents/state/ROADMAP.md ===',
    '',
    '=== BẮT ĐẦU .agents/state/HANDOFF.md ===',
    safeHandoff,
    '=== KẾT THÚC .agents/state/HANDOFF.md ===',
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
 * Thu thập trạng thái thay đổi mã nguồn qua `git status --short`, `git diff`,
 * toàn bộ mã nguồn trong thư mục nguồn và bằng chứng chạy kiểm thử thực tế.
 *
 * @returns {{ gitStatus: string, gitDiff: string, sourceSnapshot: string, testEvidence: string, positiveTestExitCode: number }}
 */
function collectGitAndCodeContext() {
  let gitStatus = '';
  let gitDiff = '';

  try {
    gitStatus = childProcess
      .execSync('git status --short', {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .trim();
  } catch (err) {
    gitStatus = `[Không thể chạy git status --short: ${err.message}]`;
  }

  try {
    gitDiff = childProcess
      .execSync('git diff HEAD', {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .trim();
  } catch (_err) {
    try {
      gitDiff = childProcess
        .execSync('git diff', {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        .trim();
    } catch (innerErr) {
      gitDiff = `[Không thể chạy git diff: ${innerErr.message}]`;
    }
  }

  const sourceDirPath = path.join(REPO_ROOT, SOURCE_DIR_NAME);
  const snapshots = [];
  if (fs.existsSync(sourceDirPath)) {
    const entries = fs
      .readdirSync(sourceDirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    for (const name of entries) {
      const fullPath = path.join(sourceDirPath, name);
      const relPath = path.relative(REPO_ROOT, fullPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      snapshots.push(`=== FULL FILE: ${relPath} ===\n${content}`);
    }
  }

  // Thực thi bộ kiểm thử tự động (nếu có) để đính kèm bằng chứng thực thi (Positive & Negative paths)
  let testEvidence = '';
  let positiveTestExitCode = 0;
  const testFilePath = path.join(sourceDirPath, 'todo.test.js');
  if (fs.existsSync(testFilePath)) {
    const posRes = childProcess.spawnSync(process.execPath, [testFilePath], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
    });
    positiveTestExitCode =
      typeof posRes.status === 'number' ? posRes.status : 1;

    const negRes = childProcess.spawnSync(
      process.execPath,
      [testFilePath, '--simulate-runner-failure'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    const rootFilesAfter = fs.readdirSync(REPO_ROOT).sort().join(', ');
    const srcFilesAfter = fs.existsSync(sourceDirPath)
      ? fs.readdirSync(sourceDirPath).sort().join(', ')
      : '';
    const relTestFile = `${SOURCE_DIR_NAME}/todo.test.js`;

    testEvidence = [
      `1) Positive Path (\`node ${relTestFile}\`):`,
      `   - Exit Code: ${posRes.status} (signal: ${posRes.signal}, error: ${posRes.error || 'none'})`,
      '   - Stdout:',
      (posRes.stdout || '').trim(),
      '   - Stderr:',
      (posRes.stderr || '(trống)').trim(),
      '',
      `2) Negative Path (\`node ${relTestFile} --simulate-runner-failure\`):`,
      `   - Exit Code: ${negRes.status} (signal: ${negRes.signal}, error: ${negRes.error || 'none'})`,
      '   - Stdout:',
      (negRes.stdout || '').trim(),
      '   - Stderr:',
      (negRes.stderr || '').trim(),
      '',
      '3) Trạng thái thư mục sau khi chạy kiểm thử (chứng minh không rò rỉ file tạm / tasks.json):',
      `   - Root files: [${rootFilesAfter}]`,
      `   - Source files: [${srcFilesAfter}]`,
    ].join('\n');
  }

  return {
    gitStatus: truncateSafely(gitStatus || '(Không có đầu ra git status)', 4_000),
    gitDiff: truncateSafely(
      gitDiff || '(Không có khác biệt git diff)',
      MAX_DIFF_CHARS
    ),
    sourceSnapshot: truncateSafely(snapshots.join('\n\n'), MAX_DIFF_CHARS),
    testEvidence: truncateSafely(
      testEvidence || '(Chưa có script kiểm thử)',
      20_000
    ),
    positiveTestExitCode,
  };
}

/**
 * Xây dựng nội dung prompt gửi cho ChatGPT Mentor tùy theo chế độ `--mode <plan|review-code|rescue>`.
 * Tuyệt đối không gắn chuỗi "(Model: ...)" vào đầu prompt để tránh làm nhiễu ngữ cảnh của Mentor.
 * Nếu `bootstrapBlock` được truyền vào (khi khởi tạo luồng chat mới cho Task mới), ghép vào đầu prompt.
 *
 * @param {'plan' | 'review-code' | 'rescue'} mode
 * @param {string} planContent
 * @param {string} errorSummary
 * @param {string} [bootstrapBlock='']
 * @returns {{ prompt: string, positiveTestExitCode: number }}
 */
function buildMentorPrompt(
  mode,
  planContent,
  errorSummary,
  bootstrapBlock = ''
) {
  let corePrompt = '';
  let positiveTestExitCode = 0;

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
  } else {
    const {
      gitStatus,
      gitDiff,
      sourceSnapshot,
      testEvidence,
      positiveTestExitCode: testExit,
    } = collectGitAndCodeContext();
    positiveTestExitCode = testExit;

    if (mode === 'review-code') {
      corePrompt = [
        'Bạn là ChatGPT Mentor thực hiện bước Review Code (Implementation Gate) trong quy trình RPIR.',
        'Hãy kiểm tra chéo toàn bộ mã nguồn thực tế (`git status --short`, `git diff`, toàn bộ nội dung file không cắt bớt và bằng chứng chạy kiểm thử thực tế) so với bản thiết kế `CURRENT_PLAN.md`.',
        'Yêu cầu bắt buộc ở dòng đầu tiên của phản hồi:',
        '- Ghi rõ `CODE_STATUS: APPROVED` nếu code tuân thủ đúng thiết kế, an toàn và cho phép đánh dấu hoàn thành Task.',
        '- Ghi rõ `CODE_STATUS: REJECTED` nếu phát hiện sai lệch hợp đồng, lỗ hổng logic hoặc thiếu sót, kèm danh sách điểm cần sửa.',
        '',
        '--- BẮT ĐẦU CURRENT_PLAN.md ---',
        planContent,
        '--- KẾT THÚC CURRENT_PLAN.md ---',
        '',
        '--- BẮT ĐẦU BẰNG CHỨNG THỰC THI KIỂM THỬ (VERIFICATION EVIDENCE) ---',
        testEvidence,
        '--- KẾT THÚC BẰNG CHỨNG THỰC THI KIỂM THỬ ---',
        '',
        '--- BẮT ĐẦU GIT STATUS (--short) ---',
        gitStatus,
        '--- KẾT THÚC GIT STATUS ---',
        '',
        '--- BẮT ĐẦU GIT DIFF (NGUYÊN BẢN, KHÔNG CẮT BỚT) ---',
        gitDiff,
        '--- KẾT THÚC GIT DIFF ---',
        '',
        '--- BẮT ĐẦU TOÀN BỘ MÃ NGUỒN ĐẦY ĐỦ (FULL SOURCE FILES) ---',
        sourceSnapshot,
        '--- KẾT THÚC TOÀN BỘ MÃ NGUỒN ĐẦY ĐỦ ---',
      ].join('\n');
    } else {
      const safeError =
        errorSummary ||
        'Thử nghiệm / chạy kiểm thử thất bại quá 3 lần liên tiếp (Circuit Breaker kích hoạt).';

      corePrompt = [
        'Bạn là ChatGPT Mentor hỗ trợ gỡ bế tắc kỹ thuật (RESCUE MODE - Circuit Breaker) trong quy trình RPIR.',
        'Worker Agent đã gặp lỗi liên tiếp ở bước Implement. Hãy phân tích nguyên nhân gốc rễ từ thông tin lỗi, đối chiếu với `CURRENT_PLAN.md` và `git diff` hiện tại, sau đó đưa ra giải pháp khắc phục từng bước cụ thể.',
        'Yêu cầu mở đầu phản hồi bằng dòng: `STATUS: REJECTED` (hoặc hướng dẫn chi tiết để Worker sửa code).',
        '',
        '--- TÓM TẮT LỖI (ERROR SUMMARY) ---',
        safeError,
        '--- KẾT THÚC TÓM TẮT LỖI ---',
        '',
        '--- BẮT ĐẦU CURRENT_PLAN.md ---',
        planContent,
        '--- KẾT THÚC CURRENT_PLAN.md ---',
        '',
        '--- BẮT ĐẦU GIT STATUS (--short) ---',
        gitStatus,
        '--- KẾT THÚC GIT STATUS ---',
        '',
        '--- BẮT ĐẦU GIT DIFF ---',
        gitDiff,
        '--- KẾT THÚC GIT DIFF ---',
      ].join('\n');
    }
  }

  const prompt = bootstrapBlock
    ? `${bootstrapBlock}\n\n${corePrompt}`
    : corePrompt;
  return { prompt, positiveTestExitCode };
}

/**
 * Điều hướng tab ChatGPT tới luồng chat của Task hiện tại (nếu đã có URL trong `SESSION_MAP.json`),
 * hoặc tự động coi `effectiveNewThread = true` (mở phiên mới + gắn Bootstrap) nếu `task_id` chưa có URL
 * trong `SESSION_MAP.json` hoặc khi người dùng truyền cờ `--new-thread`.
 *
 * @param {import('playwright-core').Page} page
 * @param {{ existingThreadUrl: string, isNewThread: boolean, projectUrl: string, model: string }} options
 * @returns {Promise<{ previousConversationId: string, effectiveNewThread: boolean }>}
 */
async function prepareTaskThread(
  page,
  { existingThreadUrl, isNewThread, projectUrl, model }
) {
  const normalizedExistingUrl =
    typeof existingThreadUrl === 'string' ? existingThreadUrl.trim() : '';
  const effectiveNewThread = Boolean(isNewThread || !normalizedExistingUrl);

  const currentUrl = page.url();
  const prevMatch = currentUrl.match(CONVERSATION_URL_REGEX);
  const previousConversationId = prevMatch ? prevMatch[1] : '';

  if (!effectiveNewThread && normalizedExistingUrl) {
    if (!currentUrl.startsWith(normalizedExistingUrl)) {
      await page.goto(normalizedExistingUrl, { waitUntil: 'domcontentloaded' });
    }
    return { previousConversationId, effectiveNewThread: false };
  }

  // Trường hợp task_id chưa có URL trong SESSION_MAP.json hoặc có cờ --new-thread: mở phiên chat sạch
  const targetBaseUrl = (projectUrl || DEFAULT_PROJECT_URL).trim();
  const isCustomProjectUrl =
    targetBaseUrl !== 'https://chatgpt.com/' &&
    targetBaseUrl !== 'https://chatgpt.com';

  if (isCustomProjectUrl) {
    const urlWithModel =
      model && !targetBaseUrl.includes('model=')
        ? `${targetBaseUrl}${targetBaseUrl.includes('?') ? '&' : '?'}model=${encodeURIComponent(model)}`
        : targetBaseUrl;
    await page.goto(urlWithModel, { waitUntil: 'domcontentloaded' });
    return { previousConversationId, effectiveNewThread: true };
  }

  // Thử bấm nút "Trò chuyện mới" (`[data-testid="create-new-chat-button"]`, `a[href="/"]`) nếu đang ở trong một cuộc hội thoại `/c/...`
  let openedFreshByClick = false;
  if (CONVERSATION_URL_REGEX.test(page.url())) {
    try {
      const newChatBtn = page.locator(NEW_CHAT_BUTTON_SELECTOR).first();
      if (await newChatBtn.isVisible().catch(() => false)) {
        await newChatBtn.click({ timeout: 5_000 });
        const startWait = Date.now();
        while (Date.now() - startWait < 4_000) {
          if (!CONVERSATION_URL_REGEX.test(page.url())) {
            openedFreshByClick = true;
            break;
          }
          await sleep(200);
        }
      }
    } catch (_err) {
      openedFreshByClick = false;
    }
  }

  if (!openedFreshByClick && CONVERSATION_URL_REGEX.test(page.url())) {
    const cleanUrl = model
      ? `https://chatgpt.com/?model=${encodeURIComponent(model)}`
      : targetBaseUrl || DEFAULT_PROJECT_URL;
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded' });
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
 * Đảm bảo mức độ suy luận (Reasoning Effort) trên thanh công cụ khung chat
 * được chuyển sang mức "Cao" / "High" nếu đang ở "Vừa", "Thấp", "Medium" hoặc "Low".
 * Bọc trong khối try/catch an toàn để không làm gãy luồng nếu giao diện đang ở sẵn mức Cao.
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<void>}
 */
async function ensureHighReasoning(page) {
  let menuOpened = false;
  try {
    const reasoningButton = page
      .locator(
        'button[aria-label*="mô hình" i], button[aria-label*="model" i], button[aria-label*="suy luận" i], button[aria-label*="reasoning" i]'
      )
      .filter({
        hasText: /(?:^|\s|\n)(Vừa|Thấp|Medium|Low)(?:$|\s|\n)/i,
      })
      .first();

    const isVisible = await reasoningButton.isVisible().catch(() => false);
    if (!isVisible) {
      return;
    }

    const buttonText = (await reasoningButton.innerText().catch(() => '')).trim();
    if (/(?:^|\s|\n)(Cao|High)(?:$|\s|\n)/i.test(buttonText)) {
      return;
    }

    await reasoningButton.click({ timeout: 5_000 });
    menuOpened = true;

    const menuItems = page.locator(
      '[role="menuitem"], [role="menuitemradio"], [role="option"]'
    );
    await menuItems.first().waitFor({ state: 'visible', timeout: 5_000 });

    const highOption = menuItems
      .filter({
        hasText: /(?:^|\s|\n)(Cao|High)(?:$|\s|\n)/i,
      })
      .first();

    if (await highOption.isVisible().catch(() => false)) {
      await highOption.click({ timeout: 5_000 });
      menuOpened = false;
      await sleep(300);
    } else {
      await page.keyboard.press('Escape').catch(() => {});
      menuOpened = false;
    }
  } catch (_err) {
    if (menuOpened) {
      await page.keyboard.press('Escape').catch(() => {});
    }
  }
}

/**
 * Đếm số lượng khối tin nhắn của Assistant và trích xuất nội dung tin nhắn cuối cùng.
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{ count: number, lastText: string }>}
 */
async function getAssistantState(page) {
  return page.evaluate((selector) => {
    const primary = Array.from(
      document.querySelectorAll('[data-message-author-role="assistant"]')
    );
    const proseBlocks = Array.from(
      document.querySelectorAll('[class*="--entity-prose-inset"]')
    );
    const elements =
      primary.length > 0
        ? primary
        : proseBlocks.length > 0
          ? proseBlocks
          : Array.from(document.querySelectorAll(selector));

    if (elements.length === 0) {
      return { count: 0, lastText: '' };
    }
    const lastEl = elements[elements.length - 1];
    return {
      count: elements.length,
      lastText: (lastEl.innerText || '').trim(),
    };
  }, ASSISTANT_MESSAGE_SELECTOR);
}

/**
 * Đợi cho đến khi nút `[data-testid="stop-button"]` biến mất
 * và nội dung tin nhắn cuối cùng của `[data-message-author-role="assistant"]` ổn định.
 *
 * @param {import('playwright-core').Page} page
 * @param {number} previousAssistantCount
 * @param {number} [timeoutMs=240000]
 * @returns {Promise<string>}
 */
async function waitForStableAssistantResponse(
  page,
  previousAssistantCount,
  timeoutMs = 240_000
) {
  const startTime = Date.now();
  const stopButtonLocator = page.locator(STOP_BUTTON_SELECTOR);

  // 1. Chờ tin nhắn phản hồi mới xuất hiện hoặc nút stop-button xuất hiện
  while (Date.now() - startTime < timeoutMs) {
    const { count } = await getAssistantState(page).catch(() => ({
      count: 0,
      lastText: '',
    }));
    const isGenerating = (await stopButtonLocator.count().catch(() => 0)) > 0;
    if (count > previousAssistantCount || isGenerating) {
      break;
    }
    await sleep(500);
  }

  // 2. Chờ nút stop-button biến mất và nội dung ổn định liên tiếp
  let lastText = '';
  let stableTicks = 0;
  const requiredStableTicks = 4;

  while (Date.now() - startTime < timeoutMs) {
    const stopVisible = await stopButtonLocator
      .first()
      .isVisible()
      .catch(() => false);
    const { count, lastText: currentText } = await getAssistantState(page).catch(
      () => ({ count: 0, lastText: '' })
    );

    if (!stopVisible && count > previousAssistantCount) {
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
 *
 * @param {string} feedbackText
 * @returns {'APPROVED' | 'REJECTED'}
 */
function detectApprovalStatus(feedbackText) {
  if (/(?:CODE_STATUS|STATUS)\s*:\s*REJECTED/i.test(feedbackText)) {
    return 'REJECTED';
  }
  if (/(?:CODE_STATUS|STATUS)\s*:\s*APPROVED/i.test(feedbackText)) {
    return 'APPROVED';
  }
  if (/\bREJECTED\b/i.test(feedbackText)) {
    return 'REJECTED';
  }
  if (/\bAPPROVED\b/i.test(feedbackText)) {
    return 'APPROVED';
  }
  return 'REJECTED';
}

async function main() {
  const { mode, taskArg, newThread, errorSummary, model, cdpUrl } = parseArgs(
    process.argv.slice(2)
  );

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
  const existingThreadEntry = sessionMap.threads[taskId];
  const existingThreadUrl =
    existingThreadEntry && typeof existingThreadEntry.url === 'string'
      ? existingThreadEntry.url.trim()
      : '';
  // Nếu task_id chưa có URL trong SESSION_MAP.json, tự động coi isNewThread = true ngay cả khi không truyền --new-thread
  const isNewThread = Boolean(newThread || !existingThreadUrl);

  const bootstrapBlock = isNewThread
    ? buildBootstrapContext(taskId, roadmapContent, handoffContent)
    : '';
  const { prompt: reviewPrompt, positiveTestExitCode } = buildMentorPrompt(
    mode,
    planContent,
    errorSummary,
    bootstrapBlock
  );

  // 2. Kết nối vào trình duyệt Chrome đang mở qua CDP port 9222
  const browser = await chromium.connectOverCDP(cdpUrl);

  try {
    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

    // 3. Tìm tab đang mở https://chatgpt.com (nếu chưa có thì mở tab mới)
    let page = context
      .pages()
      .find((p) => p.url().startsWith('https://chatgpt.com'));

    if (!page) {
      page = await context.newPage();
      const targetUrl =
        !isNewThread && existingThreadUrl
          ? existingThreadUrl
          : model
            ? `https://chatgpt.com/?model=${encodeURIComponent(model)}`
            : sessionMap.projectUrl || DEFAULT_PROJECT_URL;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    } else {
      await page.bringToFront();
    }

    // 4. Điều hướng luồng chat theo Task (Per-Task Thread Rotation)
    const { previousConversationId, effectiveNewThread } =
      await prepareTaskThread(page, {
        existingThreadUrl,
        isNewThread,
        projectUrl: sessionMap.projectUrl,
        model,
      });

    // 5. Đợi ô nhập prompt hiển thị và đảm bảo mức suy luận ở mức Cao / High
    const promptTextarea = page.locator(PROMPT_SELECTOR).first();
    await promptTextarea.waitFor({ state: 'visible', timeout: 60_000 });

    await ensureHighReasoning(page);

    const { count: previousAssistantCount } = await getAssistantState(page);

    await fillPromptFast(promptTextarea, reviewPrompt);

    // Nhấn nút gửi ([data-testid="send-button"] hoặc button[aria-label="Gửi"])
    const sendButton = page.locator(SEND_BUTTON_SELECTOR).first();
    const isSendVisible = await sendButton
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);

    if (isSendVisible) {
      await sendButton.click();
    } else {
      await promptTextarea.press('Enter');
    }

    // 6. Sau khi gửi tin nhắn và URL trình duyệt chuyển sang dạng /c/[a-z0-9-]+ (hoặc /g/.../c/...),
    // tự động lấy page.url() lưu vào SESSION_MAP.json cho task_id đó
    const activeThreadUrl = await waitForConversationUrl(
      page,
      previousConversationId,
      effectiveNewThread
    );
    sessionMap.currentTask = taskId;
    if (CONVERSATION_URL_REGEX.test(activeThreadUrl)) {
      sessionMap.threads[taskId] = {
        url: activeThreadUrl,
        updatedAt: new Date().toISOString(),
      };
    }
    saveSessionMap(sessionMap);

    // 7. Đợi ChatGPT phản hồi xong (chờ nút stop-button biến mất và nội dung ổn định)
    const responseText = await waitForStableAssistantResponse(
      page,
      previousAssistantCount
    );

    // Cập nhật lại URL & timestamp cuối cùng vào SESSION_MAP.json sau khi hoàn tất phản hồi
    const finalUrl = page.url();
    sessionMap.currentTask = taskId;
    if (CONVERSATION_URL_REGEX.test(finalUrl)) {
      sessionMap.threads[taskId] = {
        url: finalUrl,
        updatedAt: new Date().toISOString(),
      };
      saveSessionMap(sessionMap);
    }

    // 8. Ghi kết quả và khóa mã băm SHA-256 theo chế độ chạy (`plan`, `review-code`, `rescue`)
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const status = detectApprovalStatus(responseText);

    if (mode === 'review-code') {
      const cleanedBody = responseText
        .replace(/^\s*CODE_STATUS\s*:\s*(APPROVED|REJECTED)\s*\r?\n?/i, '')
        .trim();

      if (status === 'APPROVED' && positiveTestExitCode === 0) {
        const codeSha256 = computeCodeSha256(REPO_ROOT);
        saveStateLock({
          taskId,
          codeSha256,
          testExitCode: 0,
          codeApprovedAt: new Date().toISOString(),
        });
        const normalizedCodeReview = [
          'CODE_STATUS: APPROVED',
          '',
          cleanedBody,
          '',
          `<!-- CODE_SHA256: ${codeSha256} | TASK: ${taskId} | TEST_EXIT: 0 -->`,
          '',
        ].join('\n');
        fs.writeFileSync(CODE_REVIEW_FILE, normalizedCodeReview, 'utf8');
        console.log('CODE_STATUS: APPROVED');
      } else {
        saveStateLock({
          taskId,
          testExitCode: positiveTestExitCode,
        });
        const effectiveStatus =
          positiveTestExitCode === 0 ? status : 'REJECTED';
        const normalizedCodeReview = `CODE_STATUS: ${effectiveStatus}\n\n${cleanedBody}\n`;
        fs.writeFileSync(CODE_REVIEW_FILE, normalizedCodeReview, 'utf8');
        console.log(`CODE_STATUS: ${effectiveStatus}`);
      }
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

      if (status === 'APPROVED') {
        const planSha256 = computePlanSha256(PLAN_FILE);
        saveStateLock({
          taskId,
          planSha256,
          planApprovedAt: new Date().toISOString(),
        });
        const normalizedFeedback = [
          'STATUS: APPROVED',
          '',
          cleanedBody,
          '',
          `<!-- PLAN_SHA256: ${planSha256} | TASK: ${taskId} -->`,
          '',
        ].join('\n');
        fs.writeFileSync(FEEDBACK_FILE, normalizedFeedback, 'utf8');
        console.log('APPROVED');
      } else {
        const normalizedFeedback = `STATUS: ${status}\n\n${cleanedBody}\n`;
        fs.writeFileSync(FEEDBACK_FILE, normalizedFeedback, 'utf8');
        console.log(status);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`Lỗi khi gọi ChatGPT Mentor: ${err.message}`);
  process.exitCode = 1;
});
