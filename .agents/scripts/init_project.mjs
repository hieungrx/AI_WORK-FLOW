#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig } from './verify_guard.mjs';
import { repositoryIdentity, assertSafePath } from './review_artifact.mjs';
import { readJson, writeJson, writeAtomic, withRunnerLease, hasPendingTransaction } from './workflow_state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function initializeProject(root, { projectName = '', reset = false, confirmReset = '', installHook = false } = {}) {
  const identity = repositoryIdentity(root);
  if (['master', 'main'].includes(identity.branch)) throw new Error('PROTECTED_BRANCH: create a task branch before initialization.');
  const stateDir = path.join(root, '.agents/state');
  if (hasPendingTransaction(root)) throw new Error('STATE_RECOVERY_REQUIRED');
  const config = loadWorkflowConfig(root);
  if (reset && confirmReset !== path.basename(root)) throw new Error('RESET_REQUIRES_EXPLICIT_CONFIRMATION: --confirm-reset=' + path.basename(root));
  const templates = {
    'ROADMAP.md': '# ROADMAP\n\n- [ ] Task 1: Define a small, testable feature.\n',
    'CURRENT_PLAN.md': '# CURRENT_PLAN: Task 1\n\nDescribe scope and acceptance criteria before requesting review.\n',
    'MENTOR_FEEDBACK.md': 'STATUS: PENDING\n',
    'CODE_REVIEW_FEEDBACK.md': 'CODE_STATUS: PENDING\n',
    'HANDOFF.md': '# HANDOFF\n\nNext: research and plan Task 1.\n',
    'SESSION_MAP.json': JSON.stringify({ currentTask: '', projectUrl: '', threads: {}, geminiThreads: {}, stageRounds: {} }, null, 2) + '\n',
    'STATE_LOCK.json': JSON.stringify({ schemaVersion: 2, taskId: '', plan: null, code: null, planHash: '', codeDiffHash: '' }, null, 2) + '\n',
  };
  const transient = ['GEMINI_FEEDBACK.md', 'REVIEW_LEDGER.json', 'TECH_DEBT.md', 'REVIEW_RESPONSE.md', 'HUMAN_DECISION.json', 'ESCALATION_SESSION.json', 'TELEGRAM_CURSOR.json', 'METRICS.jsonl', 'requests', 'review_snapshots'];
  fs.mkdirSync(stateDir, { recursive: true });
  let backup = '';
  if (reset) {
    backup = path.join(stateDir, '.backups', 'reset-' + crypto.randomUUID());
    fs.mkdirSync(backup, { recursive: true });
    const names = [...Object.keys(templates), ...transient].filter((name) => fs.existsSync(path.join(stateDir, name)));
    for (const name of names) {
      const target = path.resolve(stateDir, name);
      if (!target.startsWith(path.resolve(stateDir) + path.sep) || fs.lstatSync(target).isSymbolicLink()) throw new Error('UNSAFE_RESET_TARGET');
      fs.cpSync(target, path.join(backup, name), { recursive: true, errorOnExist: true });
    }
    writeJson(path.join(backup, 'manifest.json'), { ...identity, names, createdAt: new Date().toISOString() });
    // All resolved targets have been verified within the named state directory.
    for (const name of transient) {
      const target = path.resolve(stateDir, name);
      if (!target.startsWith(path.resolve(stateDir) + path.sep)) throw new Error('UNSAFE_RESET_TARGET');
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    }
  }
  const created = [];
  for (const [name, content] of Object.entries(templates)) {
    const file = path.join(stateDir, name);
    if (reset || !fs.existsSync(file)) { writeAtomic(file, content); created.push(name); }
  }
  const configPath = path.join(root, '.agents/config.json');
  if (!fs.existsSync(configPath) || projectName) writeJson(configPath, { ...config, ...(projectName ? { projectName } : {}) });
  if (installHook) {
    const result = childProcess.spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.stdout.trim() && result.stdout.trim() !== '.agents/hooks') throw new Error('EXISTING_HOOKS_PATH: preserve and integrate existing project hooks manually.');
    childProcess.execFileSync('git', ['config', 'core.hooksPath', '.agents/hooks'], { cwd: root, windowsHide: true });
  }
  return { created, backup, projectName: projectName || config.projectName };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => args.find((a) => a.startsWith(flag + '='))?.slice(flag.length + 1) || (args.includes(flag) ? args[args.indexOf(flag) + 1] || '' : '');
  withRunnerLease(ROOT, [], async () => {
    if (args.includes('--clean-demo')) throw new Error('CLEAN_DEMO_REQUIRES_SEPARATE_SCOPED_REMOVAL');
    const result = initializeProject(ROOT, { projectName: value('--name'), reset: args.includes('--reset'), confirmReset: value('--confirm-reset'), installHook: args.includes('--install-hook') });
    console.log(JSON.stringify(result, null, 2));
  }).then(() => {
    if (args.includes('--ensure-project')) {
      const result = childProcess.spawnSync(process.execPath, [path.join(ROOT, '.agents/scripts/ask_mentor.mjs'), '--ensure-project'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
      process.exitCode = result.status ?? 1;
    }
  }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
