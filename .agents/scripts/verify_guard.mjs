#!/usr/bin/env node
// Guard tối giản cho quy trình RPIR.
//   --check-plan : MENTOR_FEEDBACK.md phải có "STATUS: APPROVED" ở dòng đầu.
//   --pre-commit : Nếu commit chạm src/ hoặc tests/ -> `npm test` phải exit 0
//                  và CODE_REVIEW_FEEDBACK.md phải có "CODE_STATUS: APPROVED" ở dòng đầu.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const stateFile = (root, name) => path.join(root, '.agents', 'state', name);

function firstLine(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0].trim();
}

export function verifyPlanGuard(root = REPO_ROOT) {
  if (/^STATUS:\s*APPROVED\b/i.test(firstLine(stateFile(root, 'MENTOR_FEEDBACK.md')))) {
    return { ok: true, reason: '[VERIFY_GUARD] Kế hoạch đã được duyệt (STATUS: APPROVED).' };
  }
  return { ok: false, reason: 'MENTOR_FEEDBACK.md chưa có "STATUS: APPROVED". Không được sửa src/ khi kế hoạch chưa duyệt!' };
}

function stagedTouchesCode(root) {
  const out = childProcess.execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\0').some((p) => /^(src|tests)\//.test(p.replace(/\\/g, '/')));
}

function runNpmTest(root) {
  const opts = { cwd: root, encoding: 'utf8', stdio: 'inherit', timeout: 600_000, windowsHide: true };
  const res = process.platform === 'win32'
    ? childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm test'], opts)
    : childProcess.spawnSync('npm', ['test'], opts);
  return res.error || res.signal ? 1 : res.status;
}

export function verifyPreCommitGuard(root = REPO_ROOT) {
  let touchesCode;
  try {
    touchesCode = stagedTouchesCode(root);
  } catch (err) {
    return { ok: false, reason: `CHẶN COMMIT: Không đọc được danh sách file staged: ${err.message}` };
  }
  if (!touchesCode) return { ok: true, reason: '[VERIFY_GUARD] Commit không chạm src/ hoặc tests/ — cho phép.' };

  if (!/^CODE_STATUS:\s*APPROVED\b/i.test(firstLine(stateFile(root, 'CODE_REVIEW_FEEDBACK.md')))) {
    return { ok: false, reason: 'CHẶN COMMIT: CODE_REVIEW_FEEDBACK.md chưa có "CODE_STATUS: APPROVED".' };
  }
  const exitCode = runNpmTest(root);
  if (exitCode !== 0) return { ok: false, reason: `CHẶN COMMIT: npm test thất bại (exit code: ${exitCode}).` };
  return { ok: true, reason: '[VERIFY_GUARD] Pre-commit hợp lệ (CODE_STATUS: APPROVED, npm test exit 0).' };
}

function runCli() {
  const args = process.argv.slice(2);
  const mode = args.includes('--check-plan') ? 'plan' : args.includes('--pre-commit') ? 'commit' : '';
  if (!mode) {
    console.error('Cách dùng: node .agents/scripts/verify_guard.mjs <--check-plan | --pre-commit>');
    process.exit(1);
  }
  const res = mode === 'plan' ? verifyPlanGuard() : verifyPreCommitGuard();
  if (!res.ok) {
    console.error(mode === 'plan' ? `CẢNH BÁO CHẶN THAO TÁC: ${res.reason}` : res.reason);
    process.exit(mode === 'plan' ? 2 : 1);
  }
  console.log(res.reason);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  runCli();
}
