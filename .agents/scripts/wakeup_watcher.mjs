#!/usr/bin/env node
/**
 * Reactive Wakeup Bridge cho Antigravity IDE.
 * Theo dõi `.agents/state/TELEGRAM_INBOX.json`. Ngay khi có tin nhắn/voice mới (processed === false),
 * script in ra thông tin chi tiết và thoát với exitCode = 0 để đánh thức AI Agent tự động thực thi!
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const IS_INSIDE_AGENTS =
  path.basename(SCRIPT_DIR) === 'scripts' &&
  path.basename(path.dirname(SCRIPT_DIR)) === '.agents';
const defaultRoot = IS_INSIDE_AGENTS
  ? path.resolve(SCRIPT_DIR, '..', '..')
  : 'D:\\laragon\\www\\TechPilot';
const repoRoot = process.argv[2] || defaultRoot;
const inboxPath = path.join(repoRoot, '.agents', 'state', 'TELEGRAM_INBOX.json');

console.log(`[WAKEUP BRIDGE]: Đang trực chiến chờ lệnh mới từ Telegram tại ${inboxPath}...`);

function checkInbox() {
  if (!fs.existsSync(inboxPath)) return null;
  try {
    const raw = fs.readFileSync(inboxPath, 'utf8');
    if (!raw.trim()) return null;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return null;
    const pending = list.filter((item) => !item.processed);
    return pending.length > 0 ? pending : null;
  } catch (_e) {
    return null;
  }
}

const interval = setInterval(() => {
  const pending = checkInbox();
  if (pending) {
    clearInterval(interval);
    console.log('\n🔔 [TELEGRAM WAKEUP TRIGGERED]: Phát hiện chỉ đạo mới từ người dùng trên Telegram!');
    console.log(JSON.stringify(pending, null, 2));
    process.exit(0);
  }
}, 800);
