#!/usr/bin/env node
// Guard tối giản cho quy trình RPIR (đọc cấu hình từ .agents/config.json).
//   --check-plan : MENTOR_FEEDBACK.md phải có "STATUS: APPROVED" ở dòng đầu.
//   --pre-commit : Khi commit chạm sourceDirs -> chạy testCommand đạt exit 0
//                  và CODE_REVIEW_FEEDBACK.md phải có "CODE_STATUS: APPROVED".
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const stateFile = (root, name) => path.join(root, '.agents', 'state', name);

export function loadWorkflowConfig(root = REPO_ROOT) {
  const defaults = {
    projectName: 'AI-WORKSPACE', cdpUrl: 'http://127.0.0.1:9222',
    sourceDirs: ['src', 'tests'], testCommand: 'npm test', maxReviewRounds: 2,
  };
  try {
    const p = path.join(root, '.agents', 'config.json');
    if (fs.existsSync(p)) return { ...defaults, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (_e) {}
  return defaults;
}

function firstLine(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0].trim();
}

export function verifyPlanGuard(root = REPO_ROOT) {
  if (/^STATUS:\s*APPROVED\b/i.test(firstLine(stateFile(root, 'MENTOR_FEEDBACK.md')))) {
    return { ok: true, reason: '[VERIFY_GUARD] Kế hoạch đã được duyệt (STATUS: APPROVED).' };
  }
  return { ok: false, reason: 'MENTOR_FEEDBACK.md chưa có "STATUS: APPROVED". Không được sửa code khi kế hoạch chưa duyệt!' };
}

function stagedTouchesCode(root, sourceDirs) {
  const out = childProcess.execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefixes = sourceDirs.map((d) => `${d.replace(/\\/g, '/').replace(/\/+$/, '')}/`);
  return out.split('\0').some((p) => prefixes.some((pre) => p.replace(/\\/g, '/').startsWith(pre)));
}

function runTestCmd(root, cmd) {
  const opts = { cwd: root, encoding: 'utf8', stdio: 'inherit', timeout: 600_000, windowsHide: true };
  const res = process.platform === 'win32'
    ? childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', cmd], opts)
    : childProcess.spawnSync('sh', ['-c', cmd], opts);
  return res.error || res.signal ? 1 : res.status;
}

export function verifyPreCommitGuard(root = REPO_ROOT) {
  const cfg = loadWorkflowConfig(root);
  let touchesCode;
  try { touchesCode = stagedTouchesCode(root, cfg.sourceDirs); } catch (err) {
    return { ok: false, reason: `CHẶN COMMIT: Không đọc được danh sách file staged: ${err.message}` };
  }
  if (!touchesCode) return { ok: true, reason: '[VERIFY_GUARD] Commit không chạm sourceDirs — cho phép.' };
  if (!/^CODE_STATUS:\s*APPROVED\b/i.test(firstLine(stateFile(root, 'CODE_REVIEW_FEEDBACK.md')))) {
    return { ok: false, reason: 'CHẶN COMMIT: CODE_REVIEW_FEEDBACK.md chưa có "CODE_STATUS: APPROVED".' };
  }
  const code = runTestCmd(root, cfg.testCommand);
  if (code !== 0) return { ok: false, reason: `CHẶN COMMIT: "${cfg.testCommand}" thất bại (exit code: ${code}).` };
  return { ok: true, reason: '[VERIFY_GUARD] Pre-commit hợp lệ (CODE_STATUS: APPROVED, test exit 0).' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const mode = process.argv.includes('--check-plan') ? 'plan' : process.argv.includes('--pre-commit') ? 'commit' : '';
  if (!mode) { console.error('Cách dùng: node .agents/scripts/verify_guard.mjs <--check-plan | --pre-commit>'); process.exit(1); }
  const res = mode === 'plan' ? verifyPlanGuard() : verifyPreCommitGuard();
  if (!res.ok) { console.error(mode === 'plan' ? `CẢNH BÁO CHẶN THAO TÁC: ${res.reason}` : res.reason); process.exit(mode === 'plan' ? 2 : 1); }
  console.log(res.reason);
}