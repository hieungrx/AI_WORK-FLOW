#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig, stageIntentToAdd } from './verify_guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(REPO_ROOT, '.agents', 'state');
const HANDOFF_FILE = path.join(STATE_DIR, 'HANDOFF.md');
const PATCH_FILE = path.join(STATE_DIR, 'checkpoint.patch');
const SESSION_MAP_FILE = path.join(STATE_DIR, 'SESSION_MAP.json');
const STATE_LOCK_FILE = path.join(STATE_DIR, 'STATE_LOCK.json');
const ROADMAP_FILE = path.join(STATE_DIR, 'ROADMAP.md');
const PLAN_FILE = path.join(STATE_DIR, 'CURRENT_PLAN.md');

const CHECKPOINT_START_TAG = '<!-- AUTO_CHECKPOINT_START -->';
const CHECKPOINT_END_TAG = '<!-- AUTO_CHECKPOINT_END -->';

/**
 * Phân tích tham số CLI (`--note "<ghi chú>"` hoặc `--note=<ghi chú>`).
 *
 * @param {string[]} argv
 * @returns {{ note: string }}
 */
function parseArgs(argv) {
  let note = '';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--note' && i + 1 < argv.length) {
      note = argv[i + 1].trim();
      i += 1;
    } else if (arg.startsWith('--note=')) {
      note = arg.slice('--note='.length).trim();
    } else if (!arg.startsWith('-') && !note) {
      note = argv.slice(i).join(' ').trim();
      break;
    }
  }
  return { note };
}

/**
 * Xác định `taskId` đang mở từ `ROADMAP.md` (mục `[ ]` đầu tiên), `SESSION_MAP.json`,
 * `STATE_LOCK.json` hoặc tiêu đề `CURRENT_PLAN.md`.
 *
 * @returns {string}
 */
function resolveOpenTaskId() {
  try {
    if (fs.existsSync(ROADMAP_FILE)) {
      const roadmap = fs.readFileSync(ROADMAP_FILE, 'utf8');
      const unfinished = roadmap.match(
        /^\s*-\s*\[\s*\]\s*.*?\bTask\s*[-#:]?\s*(\d+[a-z0-9_-]*)/im
      );
      if (unfinished) {
        return `task-${unfinished[1].toLowerCase()}`;
      }
    }
  } catch (_err) {}

  try {
    if (fs.existsSync(SESSION_MAP_FILE)) {
      const sessionMap = JSON.parse(fs.readFileSync(SESSION_MAP_FILE, 'utf8'));
      if (
        sessionMap &&
        typeof sessionMap.currentTask === 'string' &&
        sessionMap.currentTask.trim()
      ) {
        return sessionMap.currentTask.trim();
      }
    }
  } catch (_err) {}

  try {
    if (fs.existsSync(STATE_LOCK_FILE)) {
      const stateLock = JSON.parse(fs.readFileSync(STATE_LOCK_FILE, 'utf8'));
      if (
        stateLock &&
        typeof stateLock.taskId === 'string' &&
        stateLock.taskId.trim()
      ) {
        return stateLock.taskId.trim();
      }
    }
  } catch (_err) {}

  try {
    if (fs.existsSync(PLAN_FILE)) {
      const plan = fs.readFileSync(PLAN_FILE, 'utf8');
      const heading = plan.match(/^#+\s*.*?\bTask\s*[-#:]?\s*(\d+[a-z0-9_-]*)/im);
      if (heading) {
        return `task-${heading[1].toLowerCase()}`;
      }
    }
  } catch (_err) {}

  return 'task-1';
}

/**
 * Chạy nhanh lệnh git và trả về stdout.
 *
 * @param {string[]} args
 * @returns {string}
 */
function runGitCommand(args) {
  try {
    return childProcess
      .execFileSync('git', args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
      })
      .trim();
  } catch (err) {
    return `[Lỗi chạy git ${args.join(' ')}: ${err.message}]`;
  }
}

/**
 * Thực thi nhanh lệnh test từ `.agents/config.json` và trích xuất dòng kết quả tóm tắt (`PASS/FAIL`, `exitCode`).
 *
 * @param {string} testCommand
 * @returns {{ statusLabel: 'PASS' | 'FAIL', exitCode: number, summaryLines: string }}
 */
function runQuickTestSummary(testCommand) {
  const opts = {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  };
  const res =
    process.platform === 'win32'
      ? childProcess.spawnSync(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', testCommand],
          opts
        )
      : childProcess.spawnSync('sh', ['-c', testCommand], opts);

  const exitCode =
    !res.error && res.signal === null && typeof res.status === 'number'
      ? res.status
      : 1;
  const statusLabel = exitCode === 0 ? 'PASS' : 'FAIL';

  const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  const lines = combined
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const matchedSummary = lines.filter((l) =>
    /(?:PASS|FAIL|SKIP|kết quả|tổng kết|tests?\s+passed|exit)/i.test(l)
  );
  const pickedLines =
    matchedSummary.length > 0 ? matchedSummary.slice(-6) : lines.slice(-5);

  return {
    statusLabel,
    exitCode,
    summaryLines: pickedLines.join(' | ') || '(Không có stdout/stderr)',
  };
}

/**
 * Cập nhật hoặc ghi đè khối `## Snapshot Cứu Hộ Quota (Auto-Checkpoint)` trong `.agents/state/HANDOFF.md`
 * thông qua cặp thẻ `<!-- AUTO_CHECKPOINT_START -->` và `<!-- AUTO_CHECKPOINT_END -->`.
 *
 * @param {string} checkpointSection
 */
function upsertCheckpointIntoHandoff(checkpointSection) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let existing = '';
  if (fs.existsSync(HANDOFF_FILE)) {
    existing = fs.readFileSync(HANDOFF_FILE, 'utf8');
  } else {
    existing = '# HANDOFF: Trạng thái Bàn giao Phiên làm việc\n';
  }

  const wrappedBlock = [
    CHECKPOINT_START_TAG,
    checkpointSection,
    CHECKPOINT_END_TAG,
  ].join('\n');

  const markerRegex =
    /<!-- AUTO_CHECKPOINT_START -->[\s\S]*?<!-- AUTO_CHECKPOINT_END -->/;
  const legacyHeadingRegex =
    /(?:^|\r?\n)(?:---\r?\n\r?\n)?## Snapshot Cứu Hộ Quota \(Auto-Checkpoint\)[\s\S]*$/i;

  let updated = '';
  if (markerRegex.test(existing)) {
    updated = `${existing.replace(markerRegex, wrappedBlock).trimEnd()}\n`;
  } else if (legacyHeadingRegex.test(existing)) {
    updated = `${existing.replace(legacyHeadingRegex, '').trimEnd()}\n\n---\n\n${wrappedBlock}\n`;
  } else {
    updated = `${existing.trimEnd()}\n\n---\n\n${wrappedBlock}\n`;
  }

  fs.writeFileSync(HANDOFF_FILE, updated, 'utf8');
}

function main() {
  const { note } = parseArgs(process.argv.slice(2));
  const config = loadWorkflowConfig(REPO_ROOT);
  const sourceDirs =
    Array.isArray(config.sourceDirs) && config.sourceDirs.length > 0
      ? config.sourceDirs
      : ['src', 'tests'];
  const testCommand = config.testCommand || 'npm test';

  // 1. Chạy git add -N <sourceDirs> để theo dõi cả các file mới chưa stage
  stageIntentToAdd(REPO_ROOT, sourceDirs);

  // 2. Lưu bản sao lưu code đang sửa dở ra .agents/state/checkpoint.patch
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let fullDiff = '';
  try {
    fullDiff = childProcess.execFileSync('git', ['diff', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (_err) {}
  fs.writeFileSync(PATCH_FILE, fullDiff, 'utf8');

  const timestamp = new Date().toISOString();
  const taskId = resolveOpenTaskId();
  const gitStatus = runGitCommand(['status', '--short']) || '(Working tree sạch)';
  const gitDiffStat = runGitCommand(['diff', 'HEAD', '--stat']) || '(Không có thay đổi so với HEAD)';
  const testResult = runQuickTestSummary(testCommand);

  const checkpointSection = [
    '## Snapshot Cứu Hộ Quota (Auto-Checkpoint)',
    `- **Thời gian Checkpoint**: \`${timestamp}\``,
    `- **Task đang mở (\`taskId\`)**: \`${taskId}\``,
    `- **Ghi chú (\`--note\`)**: ${note || '(Không có ghi chú)'}`,
    `- **Bản sao lưu Patch**: \`.agents/state/checkpoint.patch\` (${fullDiff.length} bytes)`,
    `- **Tóm tắt Test (\`${testCommand}\`)**: **${testResult.statusLabel}** (\`exitCode: ${testResult.exitCode}\`) — ${testResult.summaryLines}`,
    '- **Trạng thái Git (`git status --short`)**:',
    '  ```text',
    ...gitStatus.split(/\r?\n/).map((line) => `  ${line}`),
    '  ```',
    '- **Thống kê Diff (`git diff HEAD --stat`)**:',
    '  ```text',
    ...gitDiffStat.split(/\r?\n/).map((line) => `  ${line}`),
    '  ```',
  ].join('\n');

  upsertCheckpointIntoHandoff(checkpointSection);
  console.log(
    `[CHECKPOINT SAVED]: Đã cập nhật Snapshot Cứu Hộ Quota vào .agents/state/HANDOFF.md và .agents/state/checkpoint.patch (Task: ${taskId} | Test: ${testResult.statusLabel}, exitCode=${testResult.exitCode}).`
  );
}

main();
