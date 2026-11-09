import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { digest } from './workflow_state.mjs';

export function git(root, args) {
  return childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
}

export function normalizeScope(scope) {
  if (!Array.isArray(scope) || !scope.length) throw new Error('INVALID_SOURCE_DIRS');
  return [...new Set(scope.map((value) => {
    const rel = String(value).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').some((s) => ['..', '.', '.git', 'node_modules'].includes(s)) || rel.startsWith('-')) throw new Error('UNSAFE_REVIEW_SCOPE');
    if (/^\.agents\/(?:state|skills)(?:\/|$)/.test(rel) || /(?:^|\/)\.env(?:\.|$)/i.test(rel)) throw new Error('PRIVATE_REVIEW_SCOPE');
    return rel;
  }))].sort();
}

export function repositoryIdentity(root) {
  const realRoot = fs.realpathSync(root);
  const actual = fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim());
  if (actual.toLowerCase() !== realRoot.toLowerCase()) throw new Error('REPOSITORY_ROOT_MISMATCH');
  const branch = git(root, ['symbolic-ref', '--short', 'HEAD']).trim();
  return { repoRoot: realRoot, branch, baseCommit: git(root, ['rev-parse', 'HEAD']).trim() };
}

export function isPrivatePath(rel) {
  return /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.git|node_modules|\.aws|\.ssh)(?:\/|$)/i.test(rel) || /^\.agents\/state(?:\/|$)/.test(rel) || /\.(?:pem|p12|pfx|key)$/i.test(rel);
}

export function assertSafePath(root, rel) {
  const resolved = path.resolve(root, rel);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || isPrivatePath(relative.replace(/\\/g, '/'))) throw new Error(`PRIVATE_OR_OUTSIDE_SCOPE: ${rel}`);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`SYMLINK_REVIEW_REFUSED: ${rel}`);
  }
  return resolved;
}

export function captureCode(root, scope) {
  const dirs = normalizeScope(scope);
  for (const dir of dirs) assertSafePath(root, dir);
  const changed = git(root, ['diff', 'HEAD', '--name-only', '-z', '--', ...dirs]).split('\0').filter(Boolean);
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...dirs]).split('\0').filter(Boolean);
  const files = [...new Set([...changed, ...untracked])].sort().map((name) => {
    const file = assertSafePath(root, name);
    if (!fs.existsSync(file)) return { path: name, deleted: true };
    if (!fs.statSync(file).isFile()) throw new Error(`UNSUPPORTED_REVIEW_FILE: ${name}`);
    const bytes = fs.readFileSync(file);
    return { path: name, sha256: digest(bytes), bytes: bytes.length };
  });
  const newFilesContent = untracked.sort().map((name) => {
    const bytes = fs.readFileSync(assertSafePath(root, name));
    return `=== NEW FILE: ${name} ===\n${bytes.includes(0) ? `[BINARY BASE64]\n${bytes.toString('base64')}` : bytes.toString('utf8')}`;
  }).join('\n\n');
  const gitDiff = git(root, ['diff', '--binary', '--full-index', 'HEAD', '--', ...dirs]);
  return {
    files, codeDiffHash: digest(JSON.stringify({ files, gitDiff })),
    gitDiff,
    gitStatus: git(root, ['status', '--short', '--', ...dirs]), newFilesList: untracked, newFilesContent,
  };
}

export function captureBinding(root, config, { taskId, mode = 'plan', sourceDirs = config.sourceDirs } = {}) {
  if (!taskId || !['plan', 'review-code', 'rescue'].includes(mode)) throw new Error('INVALID_REVIEW_IDENTITY');
  const planFile = path.join(root, '.agents/state/CURRENT_PLAN.md');
  const plan = fs.readFileSync(planFile, 'utf8').replace(/\r\n/g, '\n').trim();
  if (!plan) throw new Error('EMPTY_PLAN');
  const scope = normalizeScope(sourceDirs);
  return {
    ...repositoryIdentity(root), taskId, mode, sourceDirs: scope,
    configHash: digest(JSON.stringify(config)),
    planHash: digest(plan), codeDiffHash: captureCode(root, scope).codeDiffHash,
  };
}

export function assertBindingCurrent(root, config, binding) {
  const current = captureBinding(root, config, binding);
  for (const key of ['repoRoot', 'branch', 'baseCommit', 'taskId', 'mode', 'configHash', 'planHash', 'codeDiffHash']) {
    if (current[key] !== binding[key]) throw new Error(`STALE_REVIEW: ${key} changed; request a new review.`);
  }
  if (JSON.stringify(current.sourceDirs) !== JSON.stringify(binding.sourceDirs)) throw new Error('STALE_REVIEW: sourceDirs');
  return true;
}

export function assertNoRecognizableSecrets(text) {
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/,
    /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
    /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{20,}/i,
  ];
  if (patterns.some((pattern) => pattern.test(text))) throw new Error('REVIEW_SECRET_DETECTED: remove credentials from review input or test output before sending.');
}

export function collectSnapshot(root, config, taskId, mode, { runTests = true } = {}) {
  const binding = captureBinding(root, config, { taskId, mode });
  const code = captureCode(root, config.sourceDirs);
  const planContent = fs.readFileSync(path.join(root, '.agents/state/CURRENT_PLAN.md'), 'utf8').trim();
  let result = null;
  if (runTests) {
    const opts = { cwd: root, encoding: 'utf8', timeout: 240_000, windowsHide: true, maxBuffer: 5 * 1024 * 1024 };
    result = childProcess.spawnSync(config.testCommand, { ...opts, shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh' });
  }
  assertBindingCurrent(root, config, binding);
  const testEvidence = result ? `Command: ${config.testCommand}\nExit Code: ${result.status}\nSignal: ${result.signal || 'none'}\n${result.stdout || ''}\n${result.stderr || ''}\n${result.error ? 'TEST_PROCESS_ERROR' : ''}` : 'NOT_RUN: dry-run or plan review';
  const positiveTestExitCode = result && !result.error && !result.signal && result.status === 0 && !/WORKFLOW_NO_TESTS/.test(result.stdout || '') ? 0 : 1;
  const snapshot = { ...code, binding, planContent, testEvidence, positiveTestExitCode, testEvidenceHash: digest(testEvidence) };
  snapshot.fullBundleText = [
    '=== APPROVED PLAN / ACCEPTANCE CRITERIA ===', planContent,
    '=== FILE MANIFEST ===', JSON.stringify(code.files, null, 2),
    '=== TEST EVIDENCE ===', testEvidence,
    '=== DIFF (including binary changes) ===', code.gitDiff,
    '=== UNTRACKED FILE CONTENTS ===', code.newFilesContent,
  ].join('\n\n');
  if (snapshot.fullBundleText.length > 2_000_000) throw new Error('REVIEW_TOO_LARGE: split the task before review.');
  assertNoRecognizableSecrets(snapshot.fullBundleText);
  return snapshot;
}
