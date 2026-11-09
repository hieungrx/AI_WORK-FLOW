import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const stateDirectory = (root) => path.join(root, '.agents', 'state');
export const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function readJson(file, { missing } = {}) {
  if (!fs.existsSync(file)) {
    if (missing !== undefined) return structuredClone(missing);
    throw new Error(`STATE_MISSING: ${path.basename(file)}`);
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch { throw new Error(`STATE_CORRUPT: ${path.basename(file)}; restore a verified backup, never reset counters automatically.`); }
}

export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
export const writeJson = (file, value) => writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

// Held across awaits; deliberately separate from the synchronous tech-debt callback lock.
export function acquireLease(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { pid: process.pid, host: os.hostname(), nonce: crypto.randomUUID(), createdAt: new Date().toISOString() };
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`RUNNER_BUSY: ${path.basename(file)}; inspect the owner before recovery.`);
    throw e;
  }
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return () => {
    const current = readJson(file);
    if (current.nonce !== record.nonce) throw new Error('LOCK_OWNER_CHANGED');
    fs.unlinkSync(file);
  };
}

export function recoverLease(file) {
  const release = acquireLease(file + '.recovery.lock');
  try {
    if (!fs.existsSync(file)) return false;
    const raw = fs.readFileSync(file, 'utf8');
    const owner = readJson(file);
    if (owner.host !== os.hostname() || isAlive(owner.pid)) throw new Error('LOCK_OWNER_ACTIVE_OR_UNKNOWN');
    if (fs.readFileSync(file, 'utf8') !== raw) throw new Error('LOCK_OWNER_CHANGED');
    fs.unlinkSync(file);
    return true;
  } finally { release(); }
}

export async function withRunnerLease(root, endpoints, fn) {
  const releases = [];
  try {
    releases.push(acquireLease(path.join(stateDirectory(root), '.workflow-runner.lock')));
    for (const endpoint of [...new Set(endpoints)].sort()) {
      const key = digest(new URL(endpoint).origin.toLowerCase());
      releases.push(acquireLease(path.join(os.tmpdir(), `ai-workflow-cdp-${key}.lock`)));
    }
    return await fn();
  } finally { for (const release of releases.reverse()) release(); }
}

export function withStateLock(root, fn) {
  const release = acquireLease(path.join(stateDirectory(root), '.workflow-state.lock'));
  try {
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('STATE_CALLBACK_MUST_BE_SYNCHRONOUS');
    return result;
  } finally { release(); }
}

function validateWrites(writes) {
  if (!writes || typeof writes !== 'object' || Array.isArray(writes) || !Object.keys(writes).length) throw new Error('INVALID_STATE_TRANSACTION');
  for (const [name, content] of Object.entries(writes)) {
    if (!/^(?:[A-Z_]+\.(?:json|md)|requests\/[a-f0-9]{64}\.json)$/.test(name) || typeof content !== 'string') throw new Error('INVALID_STATE_TRANSACTION');
  }
}
function applyJournal(root, journal) {
  if (!journal || typeof journal.id !== 'string' || !/^[a-f0-9-]{36}$/.test(journal.id)) throw new Error('INVALID_STATE_TRANSACTION');
  validateWrites(journal.writes);
  for (const [name, content] of Object.entries(journal.writes)) writeAtomic(path.join(stateDirectory(root), name), content);
}

export function hasPendingTransaction(root) {
  return fs.existsSync(path.join(stateDirectory(root), '.transition_journal.json')) || fs.existsSync(path.join(stateDirectory(root), '.restore_pending.json'));
}

// Journaled redo: approvals are unusable while the journal exists.
export function commitStateFiles(root, writes, { afterWrite = null } = {}) {
  if (hasPendingTransaction(root)) throw new Error('STATE_RECOVERY_REQUIRED');
  validateWrites(writes);
  const journal = { id: crypto.randomUUID(), writes };
  const file = path.join(stateDirectory(root), '.transition_journal.json');
  writeJson(file, journal);
  let i = 0;
  for (const [name, content] of Object.entries(writes)) {
    writeAtomic(path.join(stateDirectory(root), name), content);
    if (afterWrite) afterWrite(++i);
  }
  fs.unlinkSync(file);
}

export function recoverStateTransaction(root) {
  const file = path.join(stateDirectory(root), '.transition_journal.json');
  if (!fs.existsSync(file)) return false;
  return withStateLock(root, () => {
    applyJournal(root, readJson(file));
    fs.unlinkSync(file);
    return true;
  });
}

export function requestPath(root, provider, threadKey) {
  if (!['chatgpt', 'gemini'].includes(provider)) throw new Error('INVALID_PROVIDER');
  return path.join(stateDirectory(root), 'requests', `${digest(`${provider}:${threadKey}`)}.json`);
}
export const loadRequest = (root, provider, key) => readJson(requestPath(root, provider, key), { missing: {} });
export const saveRequest = (root, request) => writeJson(requestPath(root, request.provider, request.threadKey), request);
export const pendingRequest = (r) => ['PREPARED', 'SENDING', 'SENT', 'RECEIVED'].includes(r?.status);

const TRANSITIONS = {
  PREPARED: ['SENDING', 'ERROR'], SENDING: ['SENT', 'RECEIVED'], SENT: ['RECEIVED'],
  RECEIVED: ['VALIDATED', 'ERROR'], VALIDATED: [], ERROR: [],
};
export function transitionRequest(root, request, status, patch = {}) {
  if (!TRANSITIONS[request.status]?.includes(status)) throw new Error(`INVALID_TRANSITION: ${request.status} -> ${status}`);
  const next = { ...request, ...patch, status, updatedAt: new Date().toISOString() };
  saveRequest(root, next);
  return next;
}

export function recordMetric(root, value) {
  // Only metadata supplied explicitly by the controller, never prompts, URLs or credentials.
  const allowed = ['requestId', 'taskId', 'provider', 'mode', 'event', 'round', 'durationMs', 'status', 'activationVerified'];
  const entry = { at: new Date().toISOString() };
  for (const key of allowed) if (value[key] !== undefined) entry[key] = value[key];
  fs.appendFileSync(path.join(stateDirectory(root), 'METRICS.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
