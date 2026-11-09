#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig } from './verify_guard.mjs';
import { git, captureCode, repositoryIdentity, assertSafePath, normalizeScope } from './review_artifact.mjs';
import { readJson, writeJson, writeAtomic, digest, withRunnerLease, hasPendingTransaction, commitStateFiles } from './workflow_state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_NAMES = ['CURRENT_PLAN.md', 'ROADMAP.md', 'HANDOFF.md'];
const HASH = /^[a-f0-9]{64}$/;
function localPath(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('UNSAFE_CHECKPOINT_PATH');
  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('SYMLINK_CHECKPOINT_REFUSED'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return resolved;
}
function readCapturedState(stateDir) {
  const state = {};
  for (const name of STATE_NAMES) if (fs.existsSync(path.join(stateDir, name))) state[name] = fs.readFileSync(path.join(stateDir, name), 'utf8');
  return state;
}
export function readCheckpointManifest(root, folder) {
  const resolved = localPath(root, folder);
  const expectedParent = path.resolve(root, '.agents/state/.backups/checkpoints');
  const comparable = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (comparable(path.dirname(resolved)) !== comparable(expectedParent)) throw new Error('CHECKPOINT_OUTSIDE_BACKUP_DIRECTORY');
  const manifestFile = localPath(root, path.join(resolved, 'manifest.json'));
  const checksumFile = localPath(root, path.join(resolved, 'manifest.sha256'));
  const expectedHash = fs.readFileSync(checksumFile, 'utf8').trim();
  if (!HASH.test(expectedHash) || digest(fs.readFileSync(manifestFile)) !== expectedHash) throw new Error('CHECKPOINT_MANIFEST_CORRUPT');
  const manifest = readJson(manifestFile);
  if (manifest.schemaVersion !== 2 || !/^checkpoint-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(manifest.id) || manifest.id !== path.basename(resolved)) throw new Error('INVALID_CHECKPOINT_ID');
  if (typeof manifest.repoRoot !== 'string' || typeof manifest.branch !== 'string' || !manifest.branch || !/^[a-f0-9]{40,64}$/.test(manifest.baseCommit) || !HASH.test(manifest.codeDiffHash)) throw new Error('INVALID_CHECKPOINT_IDENTITY');
  const scope = normalizeScope(manifest.scope);
  if (JSON.stringify(scope) !== JSON.stringify(manifest.scope)) throw new Error('INVALID_CHECKPOINT_SCOPE');
  for (const key of ['stagedPatch', 'unstagedPatch', 'status', 'taskId']) if (typeof manifest[key] !== 'string') throw new Error('INVALID_CHECKPOINT_FIELD: ' + key);
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.untracked)) throw new Error('INVALID_CHECKPOINT_FILES');
  const paths = new Map();
  const validatePath = (rel) => {
    if (typeof rel !== 'string' || !rel || rel.includes('\\') || path.posix.normalize(rel) !== rel || !scope.some((s) => rel === s || rel.startsWith(s + '/'))) throw new Error('CHECKPOINT_FILE_OUTSIDE_SCOPE');
    assertSafePath(root, rel);
    return comparable(rel);
  };
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object') throw new Error('INVALID_CHECKPOINT_FILE');
    const key = validatePath(file.path);
    if (paths.has(key)) throw new Error('DUPLICATE_CHECKPOINT_FILE');
    if (file.deleted !== true && (!HASH.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) throw new Error('INVALID_CHECKPOINT_FILE');
    paths.set(key, file);
  }
  const seen = new Set();
  for (const file of manifest.untracked) {
    if (!file || typeof file !== 'object' || typeof file.base64 !== 'string') throw new Error('INVALID_CHECKPOINT_UNTRACKED_FILE');
    const key = validatePath(file.path);
    const record = paths.get(key);
    const bytes = Buffer.from(file.base64, 'base64');
    if (seen.has(key) || !record || record.deleted || bytes.toString('base64') !== file.base64 || digest(bytes) !== file.sha256 || record.sha256 !== file.sha256 || record.bytes !== bytes.length) throw new Error('CHECKPOINT_FILE_CORRUPT');
    seen.add(key);
  }
  if (!manifest.state || typeof manifest.state !== 'object' || Array.isArray(manifest.state) || Object.entries(manifest.state).some(([name, text]) => !STATE_NAMES.includes(name) || typeof text !== 'string')) throw new Error('INVALID_CHECKPOINT_STATE');
  if (!manifest.session || typeof manifest.session !== 'object' || Array.isArray(manifest.session) || (manifest.session.currentTask || '') !== manifest.taskId) throw new Error('INVALID_CHECKPOINT_SESSION');
  return { manifest, manifestHash: expectedHash };
}
export function createCheckpoint(root, { note = '', runTests = false, beforePublish = null } = {}) {
  if (hasPendingTransaction(root)) throw new Error('STATE_RECOVERY_REQUIRED');
  const config = loadWorkflowConfig(root);
  const identity = repositoryIdentity(root);
  const code = captureCode(root, config.sourceDirs);
  const stagedPatch = git(root, ['diff', '--cached', '--binary', '--full-index', '--', ...config.sourceDirs]);
  const unstagedPatch = git(root, ['diff', '--binary', '--full-index', '--', ...config.sourceDirs]);
  const status = git(root, ['status', '--porcelain=v1', '-z', '--', ...config.sourceDirs]);
  const stateDir = path.join(root, '.agents/state');
  const session = readJson(path.join(stateDir, 'SESSION_MAP.json'), { missing: {} });
  const id = 'checkpoint-' + crypto.randomUUID();
  const folder = localPath(root, path.join(stateDir, '.backups/checkpoints', id));
  fs.mkdirSync(folder, { recursive: true });
  const untracked = code.newFilesList.map((rel) => {
    const bytes = fs.readFileSync(assertSafePath(root, rel));
    return { path: rel, base64: bytes.toString('base64'), sha256: digest(bytes) };
  });
  let tests = { status: 'NOT_RUN' };
  if (runTests) {
    const opts = { cwd: root, encoding: 'utf8', timeout: 240_000, windowsHide: true };
    const res = process.platform === 'win32' ? childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', config.testCommand], opts) : childProcess.spawnSync('sh', ['-c', config.testCommand], opts);
    tests = { status: !res.error && !res.signal && res.status === 0 && !/WORKFLOW_NO_TESTS/.test(res.stdout || '') ? 'PASS' : 'FAIL', exitCode: res.status, command: config.testCommand };
  }
  const state = readCapturedState(stateDir);
  const manifest = { schemaVersion: 2, id, ...identity, taskId: session.currentTask || '', session, state, scope: config.sourceDirs, codeDiffHash: code.codeDiffHash, files: code.files, stagedPatch, unstagedPatch, status, untracked, note, tests, createdAt: new Date().toISOString() };
  const assertUnchanged = () => {
    if (JSON.stringify(repositoryIdentity(root)) !== JSON.stringify(identity) || JSON.stringify(loadWorkflowConfig(root)) !== JSON.stringify(config) || captureCode(root, config.sourceDirs).codeDiffHash !== code.codeDiffHash || git(root, ['status', '--porcelain=v1', '-z', '--', ...config.sourceDirs]) !== status || git(root, ['diff', '--cached', '--binary', '--full-index', '--', ...config.sourceDirs]) !== stagedPatch || git(root, ['diff', '--binary', '--full-index', '--', ...config.sourceDirs]) !== unstagedPatch || JSON.stringify(readCapturedState(stateDir)) !== JSON.stringify(state) || JSON.stringify(readJson(path.join(stateDir, 'SESSION_MAP.json'), { missing: {} })) !== JSON.stringify(session)) throw new Error('CHECKPOINT_CHANGED_DURING_CAPTURE');
  };
  assertUnchanged();
  writeJson(path.join(folder, 'manifest.json'), manifest);
  const manifestHash = digest(fs.readFileSync(path.join(folder, 'manifest.json')));
  writeAtomic(path.join(folder, 'manifest.sha256'), manifestHash + '\n');
  readCheckpointManifest(root, folder);
  if (beforePublish) beforePublish();
  assertUnchanged();
  const handoff = state['HANDOFF.md'] || '# HANDOFF\n';
  commitStateFiles(root, {
    'CHECKPOINT_LATEST.json': JSON.stringify({ id, folder, manifestHash }, null, 2) + '\n',
    'HANDOFF.md': handoff.trimEnd() + '\n\nCheckpoint: ' + id + '\nTask: ' + manifest.taskId + '\nTests: ' + tests.status + '\n',
  });
  return { id, folder, tests, fileCount: code.files.length };
}

export function restoreCheckpoint(root, folder, { confirmRestore = '' } = {}) {
  if (hasPendingTransaction(root)) throw new Error('STATE_RECOVERY_REQUIRED');
  const { manifest } = readCheckpointManifest(root, folder);
  if (manifest.schemaVersion !== 2 || confirmRestore !== manifest.id) throw new Error('RESTORE_REQUIRES_EXPLICIT_CONFIRMATION');
  const identity = repositoryIdentity(root);
  if (['main', 'master'].includes(identity.branch)) throw new Error('PROTECTED_BRANCH');
  if (identity.repoRoot !== manifest.repoRoot || identity.branch !== manifest.branch || identity.baseCommit !== manifest.baseCommit) throw new Error('RESTORE_BASE_OR_BRANCH_MISMATCH');
  const scope = normalizeScope(manifest.scope);
  if (git(root, ['status', '--porcelain=v1', '-z', '--', ...scope])) throw new Error('RESTORE_TARGET_MUST_BE_CLEAN_IN_SCOPE');
  const config = loadWorkflowConfig(root);
  if (JSON.stringify(config.sourceDirs) !== JSON.stringify(scope)) throw new Error('RESTORE_SCOPE_MISMATCH');
  for (const file of manifest.untracked) if (fs.existsSync(assertSafePath(root, file.path))) throw new Error('RESTORE_UNTRACKED_TARGET_EXISTS');
  const stateDir = path.join(root, '.agents/state');
  const marker = path.join(stateDir, '.restore_pending.json');
  const restoreBackup = localPath(root, path.join(stateDir, '.backups', 'before-restore-' + crypto.randomUUID()));
  fs.mkdirSync(restoreBackup, { recursive: true });
  for (const name of [...STATE_NAMES, 'STATE_LOCK.json', 'SESSION_MAP.json', 'MENTOR_FEEDBACK.md', 'CODE_REVIEW_FEEDBACK.md']) if (fs.existsSync(path.join(stateDir, name))) fs.copyFileSync(path.join(stateDir, name), path.join(restoreBackup, name));
  writeJson(marker, { checkpointId: manifest.id, restoreBackup });
  const opts = { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 50 * 1024 * 1024 };
  const include = scope.flatMap((s) => ['--include=' + s, '--include=' + s + '/**']);
  if (manifest.stagedPatch) {
    childProcess.execFileSync('git', ['apply', '--check', '--index', ...include, '-'], { ...opts, input: manifest.stagedPatch });
    childProcess.execFileSync('git', ['apply', '--index', ...include, '-'], { ...opts, input: manifest.stagedPatch });
  }
  if (manifest.unstagedPatch) {
    childProcess.execFileSync('git', ['apply', '--check', ...include, '-'], { ...opts, input: manifest.unstagedPatch });
    childProcess.execFileSync('git', ['apply', ...include, '-'], { ...opts, input: manifest.unstagedPatch });
  }
  for (const file of manifest.untracked) {
    const target = assertSafePath(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.base64, 'base64'), { flag: 'wx' });
  }
  if (captureCode(root, scope).codeDiffHash !== manifest.codeDiffHash || git(root, ['status', '--porcelain=v1', '-z', '--', ...scope]) !== manifest.status || git(root, ['diff', '--cached', '--binary', '--full-index', '--', ...scope]) !== manifest.stagedPatch || git(root, ['diff', '--binary', '--full-index', '--', ...scope]) !== manifest.unstagedPatch) throw new Error('RESTORE_VERIFICATION_FAILED: preserve recovery marker and backup.');
  for (const [name, text] of Object.entries(manifest.state)) {
    writeAtomic(path.join(stateDir, name), text);
  }
  // Never revive historical approvals by copying state back.
  writeJson(path.join(stateDir, 'STATE_LOCK.json'), { schemaVersion: 2, taskId: manifest.taskId, plan: null, code: null, planHash: '', codeDiffHash: '' });
  writeAtomic(path.join(stateDir, 'MENTOR_FEEDBACK.md'), 'STATUS: PENDING\nRestored checkpoint; request fresh approval.\n');
  writeAtomic(path.join(stateDir, 'CODE_REVIEW_FEEDBACK.md'), 'CODE_STATUS: PENDING\n');
  const currentSession = readJson(path.join(stateDir, 'SESSION_MAP.json'), { missing: manifest.session });
  writeJson(path.join(stateDir, 'SESSION_MAP.json'), { ...currentSession, currentTask: manifest.taskId });
  fs.unlinkSync(marker);
  return { restored: manifest.id, restoreBackup, approval: 'PENDING' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => args.find((a) => a.startsWith(flag + '='))?.slice(flag.length + 1) || (args.includes(flag) ? args[args.indexOf(flag) + 1] || '' : '');
  withRunnerLease(ROOT, [], async () => {
    const folder = value('--restore');
    const result = folder ? restoreCheckpoint(ROOT, path.resolve(folder), { confirmRestore: value('--confirm-restore') }) : createCheckpoint(ROOT, { note: value('--note'), runTests: args.includes('--test') });
    console.log(JSON.stringify(result, null, 2));
  }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
