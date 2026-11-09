#!/usr/bin/env node
import path from 'node:path';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const suites = [
  ['.agents/scripts/run_tests.mjs'],
  ['.agents/tests/review_policy.test.mjs'],
  ['--test', '.agents/tests/hardening.test.mjs'],
];
let failed = 0;
for (const suite of suites) {
  const result = childProcess.spawnSync(process.execPath, suite, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0 || result.error || result.signal) failed++;
}
console.log('WORKFLOW_TEST_SUITES: ' + (suites.length - failed) + '/' + suites.length + ' PASS');
process.exitCode = failed ? 1 : 0;
