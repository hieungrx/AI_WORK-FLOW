#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig } from './verify_guard.mjs';
import { repositoryIdentity, git } from './review_artifact.mjs';
import { readJson, digest, recoverLease, recoverStateTransaction, withRunnerLease, hasPendingTransaction } from './workflow_state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function doctor(root, { connections = false, fetchImpl = globalThis.fetch } = {}) {
  const checks = [];
  const check = (name, fn) => { try { const detail = fn(); checks.push({ name, status: 'PASS', detail }); return detail; } catch (e) { checks.push({ name, status: 'FAIL', detail: e.message.split('\n')[0] }); return null; } };
  const identity = check('repository', () => repositoryIdentity(root));
  if (identity && ['main', 'master'].includes(identity.branch)) checks.push({ name: 'task-branch', status: 'FAIL', detail: 'Create a task branch before changes.' });
  const config = check('config', () => loadWorkflowConfig(root));
  check('dependencies', () => {
    for (const rel of ['node_modules/playwright-core/package.json', 'src/tech_debt.mjs']) if (!fs.existsSync(path.join(root, rel))) throw new Error('MISSING_RUNTIME_DEPENDENCY: ' + rel);
    return 'Browser package and internal tech-debt import are available.';
  });
  check('git-hook', () => { if (git(root, ['config', '--get', 'core.hooksPath']).trim() !== '.agents/hooks') throw new Error('HOOK_NOT_INSTALLED: init-workflow --install-hook'); return '.agents/hooks'; });
  check('tool-hook', () => {
    const hook = readJson(path.join(root, '.agents/hooks.json'));
    const entries = Object.values(hook).flatMap((v) => v.PreToolUse || []);
    if (!entries.some((v) => v.matcher.includes('write_to_file') && v.hooks.some((h) => h.command === 'node .agents/scripts/check_plan_approved.mjs'))) throw new Error('TOOL_HOOK_MISMATCH');
    return 'Configured; actual host invocation still requires a live test.';
  });
  check('state-integrity', () => {
    for (const name of ['SESSION_MAP.json', 'STATE_LOCK.json', 'REVIEW_LEDGER.json', 'ESCALATION_SESSION.json']) {
      const file = path.join(root, '.agents/state', name); if (fs.existsSync(file)) readJson(file);
    }
    if (hasPendingTransaction(root)) throw new Error('STATE_RECOVERY_REQUIRED');
    return 'JSON readable; this does not assert that a task is approved.';
  });
  if (connections && config) {
    for (const [provider, endpoint] of [['chatgpt', config.cdpUrl], ['gemini', config.geminiCdpUrl]]) {
      try {
        const url = new URL(endpoint);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('CDP_MUST_BE_LOOPBACK');
        const response = await fetchImpl(new URL('/json/version', url), { signal: AbortSignal.timeout(2500) });
        if (!response.ok) throw new Error('CDP_NOT_READY');
        const body = await response.json();
        if (!body.webSocketDebuggerUrl) throw new Error('INVALID_CDP_RESPONSE');
        checks.push({ name: provider + '-connection', status: 'PASS', detail: 'CDP ready; login and UI behavior not yet verified.' });
      } catch { checks.push({ name: provider + '-connection', status: 'FAIL', detail: 'CDP unavailable. Open the configured browser profile.' }); }
    }
  }
  return { ok: checks.every((c) => c.status !== 'FAIL'), checks, liveHostVerified: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  (async () => {
    if (args.includes('--recover-locks')) {
      const cfg = loadWorkflowConfig(ROOT);
      for (const file of [path.join(ROOT, '.agents/state/.workflow-runner.lock'), path.join(ROOT, '.agents/state/.workflow-state.lock'), ...[cfg.cdpUrl, cfg.geminiCdpUrl].map((url) => path.join(os.tmpdir(), 'ai-workflow-cdp-' + digest(new URL(url).origin.toLowerCase()) + '.lock'))]) recoverLease(file);
    }
    if (args.includes('--recover-state')) await withRunnerLease(ROOT, [], () => recoverStateTransaction(ROOT));
    const result = await doctor(ROOT, { connections: args.includes('--connections') });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  })().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
