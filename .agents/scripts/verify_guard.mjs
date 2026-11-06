#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const STATE_DIR = path.join(REPO_ROOT, '.agents', 'state');
export const PLAN_FILE = path.join(STATE_DIR, 'CURRENT_PLAN.md');
export const FEEDBACK_FILE = path.join(STATE_DIR, 'MENTOR_FEEDBACK.md');
export const CODE_REVIEW_FILE = path.join(STATE_DIR, 'CODE_REVIEW_FEEDBACK.md');
export const ROADMAP_FILE = path.join(STATE_DIR, 'ROADMAP.md');
export const STATE_LOCK_FILE = path.join(STATE_DIR, 'STATE_LOCK.json');

const TRACKED_CODE_DIRS = ['src', 'tests'];

/**
 * Chuẩn hóa chuỗi văn bản trên Windows/Linux:
 * đổi toàn bộ CRLF (`\r\n`) thành LF (`\n`) và `.trim()` trước khi băm SHA-256.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeLf(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * Tính mã băm SHA-256 (hex) sau khi đã chuẩn hóa xuống dòng `.replace(/\r\n/g, '\n').trim()`.
 *
 * @param {string} text
 * @returns {string}
 */
export function sha256Hex(text) {
  return crypto
    .createHash('sha256')
    .update(normalizeLf(text), 'utf8')
    .digest('hex');
}

/**
 * Tính mã băm `planSha256` của `.agents/state/CURRENT_PLAN.md`.
 *
 * @param {string} [planFilePath=PLAN_FILE]
 * @returns {string}
 */
export function computePlanSha256(planFilePath = PLAN_FILE) {
  if (!fs.existsSync(planFilePath)) {
    return '';
  }
  const content = fs.readFileSync(planFilePath, 'utf8');
  return sha256Hex(content);
}

/**
 * Tính mã băm `codeSha256` dựa trên trạng thái code hiện tại
 * (`git diff HEAD` của thư mục `src/` và `tests/` + danh sách/nội dung file untracked nếu có).
 * Tự động đánh dấu intent-to-add (`git add -N`) cho file mới trong `src/` hoặc `tests/`
 * để mã băm bất biến trước và sau khi chạy `git add` ở bước pre-commit.
 *
 * @param {string} [repoRoot=REPO_ROOT]
 * @returns {string}
 */
export function computeCodeSha256(repoRoot = REPO_ROOT) {
  const existingDirs = TRACKED_CODE_DIRS.filter((dirName) =>
    fs.existsSync(path.join(repoRoot, dirName))
  );

  if (existingDirs.length === 0) {
    return sha256Hex('');
  }

  const dirArgs = existingDirs.join(' ');

  // Chuyển các file untracked trong src/ và tests/ sang intent-to-add (git add -N)
  // để `git diff HEAD` luôn bao gồm nội dung file mới một cách nhất quán.
  try {
    const untrackedRaw = childProcess
      .execSync(`git ls-files --others --exclude-standard -- ${dirArgs}`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .replace(/\r\n/g, '\n')
      .trim();

    if (untrackedRaw) {
      const untrackedFiles = untrackedRaw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      for (const relPath of untrackedFiles) {
        try {
          childProcess.execSync(`git add -N -- "${relPath}"`, {
            cwd: repoRoot,
            stdio: ['ignore', 'ignore', 'ignore'],
          });
        } catch (_err) {
          // Bỏ qua nếu git index đang bị khóa bởi tiến trình git khác
        }
      }
    }
  } catch (_err) {
    // Bỏ qua nếu không liệt kê được untracked files
  }

  let diffOutput = '';
  try {
    diffOutput = childProcess.execSync(
      `git -c core.autocrlf=false -c core.safecrlf=false diff HEAD -- ${dirArgs}`,
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (_err) {
    try {
      diffOutput = childProcess.execSync(
        `git -c core.autocrlf=false -c core.safecrlf=false diff -- ${dirArgs}`,
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
    } catch (_innerErr) {
      diffOutput = '';
    }
  }

  // Phòng trường hợp git index đang khóa (ví dụ khi đang chạy giữa git commit) và còn file untracked chưa được add -N
  const extraUntrackedParts = [];
  try {
    const remainingUntracked = childProcess
      .execSync(`git ls-files --others --exclude-standard -- ${dirArgs}`, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .replace(/\r\n/g, '\n')
      .trim();

    if (remainingUntracked) {
      const files = remainingUntracked
        .split('\n')
        .map((f) => f.trim())
        .filter(Boolean)
        .sort();
      for (const relFile of files) {
        const absFile = path.join(repoRoot, relFile);
        if (fs.existsSync(absFile) && fs.statSync(absFile).isFile()) {
          const fileContent = normalizeLf(fs.readFileSync(absFile, 'utf8'));
          extraUntrackedParts.push(
            `UNTRACKED:${relFile.replace(/\\/g, '/')}\n${fileContent}`
          );
        }
      }
    }
  } catch (_err) {
    // Bỏ qua
  }

  const normalizedDiff = normalizeLf(diffOutput);
  const combinedPayload =
    extraUntrackedParts.length > 0
      ? `${normalizedDiff}\n${extraUntrackedParts.join('\n')}`.trim()
      : normalizedDiff;

  return sha256Hex(combinedPayload);
}

/**
 * Đọc nội dung `.agents/state/STATE_LOCK.json`.
 *
 * @param {string} [lockFilePath=STATE_LOCK_FILE]
 * @returns {{
 *   taskId: string,
 *   planSha256: string,
 *   planApprovedAt: string,
 *   codeSha256: string,
 *   testExitCode: number | null,
 *   codeApprovedAt: string
 * }}
 */
export function loadStateLock(lockFilePath = STATE_LOCK_FILE) {
  const fallback = {
    taskId: '',
    planSha256: '',
    planApprovedAt: '',
    codeSha256: '',
    testExitCode: null,
    codeApprovedAt: '',
  };

  try {
    if (!fs.existsSync(lockFilePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(lockFilePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return fallback;
    }
    return {
      taskId: typeof parsed.taskId === 'string' ? parsed.taskId : '',
      planSha256:
        typeof parsed.planSha256 === 'string' ? parsed.planSha256 : '',
      planApprovedAt:
        typeof parsed.planApprovedAt === 'string' ? parsed.planApprovedAt : '',
      codeSha256:
        typeof parsed.codeSha256 === 'string' ? parsed.codeSha256 : '',
      testExitCode:
        typeof parsed.testExitCode === 'number' ? parsed.testExitCode : null,
      codeApprovedAt:
        typeof parsed.codeApprovedAt === 'string' ? parsed.codeApprovedAt : '',
    };
  } catch (_err) {
    return fallback;
  }
}

/**
 * Lưu `.agents/state/STATE_LOCK.json`.
 *
 * @param {Partial<{
 *   taskId: string,
 *   planSha256: string,
 *   planApprovedAt: string,
 *   codeSha256: string,
 *   testExitCode: number | null,
 *   codeApprovedAt: string
 * }>} partialUpdate
 * @param {string} [lockFilePath=STATE_LOCK_FILE]
 */
export function saveStateLock(partialUpdate, lockFilePath = STATE_LOCK_FILE) {
  const current = loadStateLock(lockFilePath);
  const next = {
    ...current,
    ...partialUpdate,
  };
  fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
  fs.writeFileSync(lockFilePath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/**
 * Chế độ 1 (`--check-plan`):
 * Kiểm tra trước khi viết/sửa code trong `src/` xem:
 * 1) `MENTOR_FEEDBACK.md` có `STATUS: APPROVED` hay không.
 * 2) Mã băm hiện tại của `CURRENT_PLAN.md` có khớp với `planSha256` trong `STATE_LOCK.json` hay không.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyPlanGuard() {
  if (!fs.existsSync(FEEDBACK_FILE)) {
    return {
      ok: false,
      reason:
        'Không tìm thấy .agents/state/MENTOR_FEEDBACK.md. Tuyệt đối không được sửa code khi kế hoạch chưa được duyệt!',
    };
  }

  const feedbackContent = normalizeLf(fs.readFileSync(FEEDBACK_FILE, 'utf8'));
  if (!/^STATUS:\s*APPROVED\b/im.test(feedbackContent)) {
    return {
      ok: false,
      reason:
        '.agents/state/MENTOR_FEEDBACK.md chưa có "STATUS: APPROVED". Tuyệt đối không được tạo hoặc sửa file trong src/!',
    };
  }

  if (!fs.existsSync(PLAN_FILE)) {
    return {
      ok: false,
      reason: 'Không tìm thấy .agents/state/CURRENT_PLAN.md để đối chiếu mã băm.',
    };
  }

  const currentPlanSha = computePlanSha256(PLAN_FILE);
  const stateLock = loadStateLock(STATE_LOCK_FILE);

  if (!stateLock.planSha256) {
    return {
      ok: false,
      reason:
        '.agents/state/STATE_LOCK.json chưa có planSha256 hợp lệ. Hãy chạy `node .agents/scripts/ask_mentor.mjs --mode plan` để khóa mã băm kế hoạch.',
    };
  }

  if (currentPlanSha !== stateLock.planSha256) {
    return {
      ok: false,
      reason: [
        'PHÁT HIỆN SỬA ĐỔI KẾ HOẠCH SAU KHI DUYỆT (PLAN_SHA256 MISMATCH)!',
        `- planSha256 đã khóa (STATE_LOCK.json): ${stateLock.planSha256}`,
        `- planSha256 hiện tại (CURRENT_PLAN.md): ${currentPlanSha}`,
        'Vui lòng khôi phục CURRENT_PLAN.md hoặc gửi duyệt lại qua `node .agents/scripts/ask_mentor.mjs --mode plan`.',
      ].join('\n'),
    };
  }

  const commentMatch = feedbackContent.match(
    /<!--\s*PLAN_SHA256:\s*([a-f0-9]{64})\s*\|\s*TASK:\s*([^\s>]+)\s*-->/i
  );
  if (commentMatch && commentMatch[1].toLowerCase() !== currentPlanSha) {
    return {
      ok: false,
      reason: [
        'Mã băm PLAN_SHA256 trong MENTOR_FEEDBACK.md không khớp với CURRENT_PLAN.md hiện tại!',
        `- PLAN_SHA256 trong MENTOR_FEEDBACK.md: ${commentMatch[1]}`,
        `- planSha256 hiện tại (CURRENT_PLAN.md): ${currentPlanSha}`,
      ].join('\n'),
    };
  }

  return {
    ok: true,
    reason: `[VERIFY_GUARD] Kế hoạch hợp lệ (TASK: ${stateLock.taskId || 'unknown'}, PLAN_SHA256: ${currentPlanSha.slice(0, 12)}...).`,
  };
}

/**
 * Chế độ 2 (`--pre-commit`):
 * Khi thực hiện `git commit`:
 * - Nếu commit có chứa các file thay đổi trong `src/` (hoặc `tests/`) HOẶC đánh dấu hoàn thành `[x]` trong `.agents/state/ROADMAP.md`,
 *   bắt buộc kiểm tra:
 *   1) `CODE_REVIEW_FEEDBACK.md` có `CODE_STATUS: APPROVED`.
 *   2) `testExitCode === 0` trong `STATE_LOCK.json`.
 *   3) Mã băm diff hiện tại của `src/` và `tests/` khớp với `codeSha256` đã được Mentor duyệt trong `STATE_LOCK.json`.
 * - Cho phép commit các file cấu hình/hạ tầng trong `.agents/` khi không chạm tới `src/` và không đánh dấu `[x]` mới trong `ROADMAP.md`.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
export function verifyPreCommitGuard() {
  let stagedFilesRaw = '';
  try {
    stagedFilesRaw = childProcess
      .execSync('git diff --cached --name-only', {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .replace(/\r\n/g, '\n')
      .trim();
  } catch (err) {
    return {
      ok: false,
      reason: `Không thể kiểm tra danh sách file staged: ${err.message}`,
    };
  }

  const stagedFiles = stagedFilesRaw
    ? stagedFilesRaw
        .split('\n')
        .map((f) => f.trim().replace(/\\/g, '/'))
        .filter(Boolean)
    : [];

  if (stagedFiles.length === 0) {
    return {
      ok: true,
      reason: '[VERIFY_GUARD] Không có file staged nào.',
    };
  }

  const touchesCodeDirs = stagedFiles.some(
    (filePath) =>
      filePath.startsWith('src/') ||
      filePath.startsWith('tests/') ||
      filePath === 'src' ||
      filePath === 'tests'
  );

  let marksRoadmapTaskCompleted = false;
  if (stagedFiles.includes('.agents/state/ROADMAP.md')) {
    try {
      const roadmapDiff = childProcess
        .execSync(
          'git -c core.autocrlf=false -c core.safecrlf=false diff --cached -- .agents/state/ROADMAP.md',
          {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        )
        .replace(/\r\n/g, '\n');

      marksRoadmapTaskCompleted = /^\+\s*-\s*\[[xX]\]/m.test(roadmapDiff);
    } catch (_err) {
      marksRoadmapTaskCompleted = true;
    }
  }

  // Cho phép commit các file cấu hình/hạ tầng ngoài src/ và tests/ nếu không đánh dấu hoàn thành [x] mới trong ROADMAP.md
  if (!touchesCodeDirs && !marksRoadmapTaskCompleted) {
    return {
      ok: true,
      reason:
        '[VERIFY_GUARD] Commit chỉ chạm tới file cấu hình/hạ tầng ngoài src/ — Cho phép commit bảo trì.',
    };
  }

  // Kiểm tra 1: CODE_REVIEW_FEEDBACK.md phải có CODE_STATUS: APPROVED
  if (!fs.existsSync(CODE_REVIEW_FILE)) {
    return {
      ok: false,
      reason:
        'CHẶN COMMIT: Không tìm thấy .agents/state/CODE_REVIEW_FEEDBACK.md. Bắt buộc phải chạy `node .agents/scripts/ask_mentor.mjs --mode review-code` trước khi commit code trong src/ hoặc đóng Task!',
    };
  }

  const codeReviewContent = normalizeLf(
    fs.readFileSync(CODE_REVIEW_FILE, 'utf8')
  );
  if (!/^CODE_STATUS:\s*APPROVED\b/im.test(codeReviewContent)) {
    return {
      ok: false,
      reason:
        'CHẶN COMMIT: .agents/state/CODE_REVIEW_FEEDBACK.md chưa có "CODE_STATUS: APPROVED". Không được phép commit code trong src/ hoặc đánh dấu hoàn thành [x] trong ROADMAP.md!',
    };
  }

  // Kiểm tra 2: STATE_LOCK.json phải tồn tại và có testExitCode === 0
  const stateLock = loadStateLock(STATE_LOCK_FILE);
  if (stateLock.testExitCode !== 0) {
    return {
      ok: false,
      reason: `CHẶN COMMIT: testExitCode trong .agents/state/STATE_LOCK.json là "${stateLock.testExitCode}" (bắt buộc phải bằng 0).`,
    };
  }

  if (!stateLock.codeSha256) {
    return {
      ok: false,
      reason:
        'CHẶN COMMIT: .agents/state/STATE_LOCK.json chưa có mã băm codeSha256 được phê duyệt bởi Mentor.',
    };
  }

  // Kiểm tra 3: Mã băm diff hiện tại của src/ và tests/ phải khớp với codeSha256 trong STATE_LOCK.json
  const currentCodeSha = computeCodeSha256(REPO_ROOT);
  if (currentCodeSha !== stateLock.codeSha256) {
    return {
      ok: false,
      reason: [
        'CHẶN COMMIT: PHÁT HIỆN THAY ĐỔI CODE SAU KHI REVIEW (CODE_SHA256 MISMATCH)!',
        `- codeSha256 đã duyệt (STATE_LOCK.json): ${stateLock.codeSha256}`,
        `- codeSha256 hiện tại (src/ & tests/):   ${currentCodeSha}`,
        'Bạn đã chỉnh sửa code sau khi Mentor review. Hãy chạy lại `node .agents/scripts/ask_mentor.mjs --mode review-code` để cập nhật phê duyệt.',
      ].join('\n'),
    };
  }

  const metaMatch = codeReviewContent.match(
    /<!--\s*CODE_SHA256:\s*([a-f0-9]{64})\s*\|\s*TASK:\s*([^\s|]+)\s*\|\s*TEST_EXIT:\s*(\d+)\s*-->/i
  );
  if (metaMatch) {
    const commentSha = metaMatch[1].toLowerCase();
    const commentExit = Number.parseInt(metaMatch[3], 10);
    if (commentSha !== currentCodeSha || commentExit !== 0) {
      return {
        ok: false,
        reason: [
          'CHẶN COMMIT: Metadata CODE_SHA256 / TEST_EXIT trong CODE_REVIEW_FEEDBACK.md không khớp với trạng thái hiện tại!',
          `- CODE_SHA256 trong CODE_REVIEW_FEEDBACK.md: ${commentSha} (TEST_EXIT: ${commentExit})`,
          `- codeSha256 hiện tại: ${currentCodeSha}`,
        ].join('\n'),
      };
    }
  }

  return {
    ok: true,
    reason: `[VERIFY_GUARD] Pre-commit hợp lệ (TASK: ${stateLock.taskId || 'unknown'}, CODE_SHA256: ${currentCodeSha.slice(0, 12)}..., TEST_EXIT: 0).`,
  };
}

function runCli() {
  const args = process.argv.slice(2);
  const checkPlan = args.includes('--check-plan');
  const preCommit = args.includes('--pre-commit');

  if (!checkPlan && !preCommit) {
    console.error(
      'Cách dùng: node .agents/scripts/verify_guard.mjs <--check-plan | --pre-commit>'
    );
    process.exit(1);
  }

  if (checkPlan) {
    const res = verifyPlanGuard();
    if (!res.ok) {
      console.error(`CẢNH BÁO CHẶN THAO TÁC: ${res.reason}`);
      process.exit(2);
    }
    console.log(res.reason);
  }

  if (preCommit) {
    const res = verifyPreCommitGuard();
    if (!res.ok) {
      console.error(res.reason);
      process.exit(1);
    }
    console.log(res.reason);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename);
if (isMain) {
  runCli();
}
