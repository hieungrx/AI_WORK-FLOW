#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadWorkflowConfig } from './verify_guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const TEST_FILE_REGEX = /\.(?:test|spec)\.(?:c|m)?js$/i;

function collectTestFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTestFiles(fullPath));
    } else if (entry.isFile() && TEST_FILE_REGEX.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

const config = loadWorkflowConfig(REPO_ROOT);
const sourceDirs = Array.isArray(config.sourceDirs) && config.sourceDirs.length > 0
  ? config.sourceDirs
  : ['src', 'tests'];

const testFiles = [];
for (const relDir of sourceDirs) {
  testFiles.push(...collectTestFiles(path.join(REPO_ROOT, relDir)));
}

if (testFiles.length === 0) {
  console.log('[TEST]: Chưa có file kiểm thử (*.test.js / *.spec.js) trong src/ hoặc tests/ — PASS khởi tạo.');
  process.exit(0);
}

const res = childProcess.spawnSync(process.execPath, ['--test', ...testFiles], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
});
process.exit(res.status ?? 1);
