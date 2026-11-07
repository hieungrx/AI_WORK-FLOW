#!/usr/bin/env node
// Guard cho quy trình RPIR (đọc cấu hình từ .agents/config.json).
//   --check-plan : MENTOR_FEEDBACK.md phải có "STATUS: APPROVED" ở dòng đầu (và khớp planHash nếu có).
//   --pre-commit : Khi commit chạm sourceDirs -> không có file stage một nửa, khớp codeDiffHash
//                  trong STATE_LOCK.json, CODE_REVIEW_FEEDBACK.md có "CODE_STATUS: APPROVED", và test exit 0.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const stateFile = (root, name) => path.join(root, '.agents', 'state', name);
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

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

export function loadStateLock(root = REPO_ROOT) {
  try {
    const p = stateFile(root, 'STATE_LOCK.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) {}
  return { taskId: '', planHash: '', codeDiffHash: '', updatedAt: '' };
}

export function saveStateLock(lock, root = REPO_ROOT) {
  const p = stateFile(root, 'STATE_LOCK.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const data = {
    taskId: lock.taskId || '',
    planHash: lock.planHash || '',
    codeDiffHash: lock.codeDiffHash || '',
    updatedAt: lock.updatedAt || new Date().toISOString(),
  };
  fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return data;
}

export function stageIntentToAdd(root = REPO_ROOT, sourceDirs = ['src', 'tests']) {
  const existing = (sourceDirs || []).filter((d) => fs.existsSync(path.join(root, d)));
  if (existing.length === 0) return [];
  try {
    childProcess.execFileSync('git', ['add', '-N', '--', ...existing], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (_e) {}
  return existing;
}

export function computePlanHash(root = REPO_ROOT) {
  const p = stateFile(root, 'CURRENT_PLAN.md');
  if (!fs.existsSync(p)) return '';
  return sha256(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trim());
}

export function computeCodeDiffHash(root = REPO_ROOT, sourceDirs = ['src', 'tests']) {
  const existing = stageIntentToAdd(root, sourceDirs);
  if (existing.length === 0) return sha256('');
  try {
    const diff = childProcess.execFileSync('git', ['diff', 'HEAD', '--', ...existing], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024,
    });
    return sha256(diff.replace(/\r\n/g, '\n'));
  } catch (_e) {
    return '';
  }
}

function firstLine(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)[0].trim();
}

export function verifyPlanGuard(root = REPO_ROOT) {
  if (!/^STATUS:\s*APPROVED\b/i.test(firstLine(stateFile(root, 'MENTOR_FEEDBACK.md')))) {
    return { ok: false, reason: 'MENTOR_FEEDBACK.md chưa có "STATUS: APPROVED". Không được sửa code khi kế hoạch chưa duyệt!' };
  }
  const lock = loadStateLock(root);
  if (lock.planHash && lock.planHash !== computePlanHash(root)) {
    return { ok: false, reason: 'CURRENT_PLAN.md đã thay đổi so với planHash đã duyệt trong STATE_LOCK.json!' };
  }
  return { ok: true, reason: '[VERIFY_GUARD] Kế hoạch đã được duyệt (STATUS: APPROVED).' };
}

function stagedTouchesCode(root, sourceDirs) {
  const out = childProcess.execFileSync('git', ['diff', '--cached', '--name-only', '-z'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefixes = sourceDirs.map((d) => `${d.replace(/\\/g, '/').replace(/\/+$/, '')}/`);
  return out.split('\0').some((p) => prefixes.some((pre) => p.replace(/\\/g, '/').startsWith(pre)));
}

function hasUnstagedCodeChanges(root, sourceDirs) {
  const existing = stageIntentToAdd(root, sourceDirs);
  if (existing.length === 0) return [];
  const out = childProcess.execFileSync('git', ['diff', '--name-only', '-z', '--', ...existing], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\0').map((s) => s.trim()).filter(Boolean);
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
  const unstaged = hasUnstagedCodeChanges(root, cfg.sourceDirs);
  if (unstaged.length > 0) {
    return { ok: false, reason: `CHẶN COMMIT: Phát hiện file trong sourceDirs bị stage một nửa hoặc chưa stage: ${unstaged.join(', ')}` };
  }
  const lock = loadStateLock(root);
  const currentDiffHash = computeCodeDiffHash(root, cfg.sourceDirs);
  if (!lock.codeDiffHash || lock.codeDiffHash !== currentDiffHash) {
    return { ok: false, reason: 'CHẶN COMMIT: codeDiffHash hiện tại không khớp với STATE_LOCK.json (code đã thay đổi sau khi duyệt).' };
  }
  const code = runTestCmd(root, cfg.testCommand);
  if (code !== 0) return { ok: false, reason: `CHẶN COMMIT: "${cfg.testCommand}" thất bại (exit code: ${code}).` };
  return { ok: true, reason: '[VERIFY_GUARD] Pre-commit hợp lệ (CODE_STATUS: APPROVED, khớp codeDiffHash, test exit 0).' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const mode = process.argv.includes('--check-plan') ? 'plan' : process.argv.includes('--pre-commit') ? 'commit' : '';
  if (!mode) { console.error('Cách dùng: node .agents/scripts/verify_guard.mjs <--check-plan | --pre-commit>'); process.exit(1); }
  const res = mode === 'plan' ? verifyPlanGuard() : verifyPreCommitGuard();
  if (!res.ok) { console.error(mode === 'plan' ? `CẢNH BÁO CHẶN THAO TÁC: ${res.reason}` : res.reason); process.exit(mode === 'plan' ? 2 : 1); }
  console.log(res.reason);
}
