#!/usr/bin/env node
/**
 * Gửi phản hồi từ AI Agent về Telegram (kèm bàn phím điều khiển / đổi dự án) và đánh dấu đã xử lý TELEGRAM_INBOX.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const IS_INSIDE_AGENTS =
  path.basename(SCRIPT_DIR) === 'scripts' &&
  path.basename(path.dirname(SCRIPT_DIR)) === '.agents';
const repoRoot = IS_INSIDE_AGENTS
  ? path.resolve(SCRIPT_DIR, '..', '..')
  : 'D:\\laragon\\www\\TechPilot';
const inboxPath = path.join(repoRoot, '.agents', 'state', 'TELEGRAM_INBOX.json');
const projectsFile = path.join(SCRIPT_DIR, 'projects.json');

const args = process.argv.slice(2);
const showProjectsMenu = args.includes('--projects');
const textArg = args.filter((a) => a !== '--projects').join(' ').trim();

function buildQuickKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 Trạng thái', callback_data: 'hub:status' },
        { text: '🗺️ Roadmap', callback_data: 'hub:roadmap' },
        { text: '🧪 Chạy Test', callback_data: 'hub:test' },
      ],
      [
        { text: '✅ Duyệt Gate (Override)', callback_data: 'hub:approve' },
        { text: '⏩ Gia hạn +2 vòng', callback_data: 'hub:extend' },
      ],
      [
        { text: '📸 Lưu Checkpoint', callback_data: 'hub:checkpoint' },
        { text: '🆕 Tạo Phiên Mới', callback_data: 'hub:newchat' },
      ],
      [
        { text: '📂 Đổi dự án', callback_data: 'hub:projects' },
        { text: '🖥️ Mở trên Antigravity IDE', callback_data: 'hub:open_ide' },
      ],
    ],
  };
}

function buildProjectsKeyboard() {
  let cfg = { activeProject: 'TechPilot', projects: { TechPilot: repoRoot } };
  if (fs.existsSync(projectsFile)) {
    try {
      cfg = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
    } catch (_e) {}
  }
  const names = Object.keys(cfg.projects || {});
  const rows = [];
  for (let i = 0; i < names.length; i += 2) {
    const pair = names.slice(i, i + 2).map((name) => ({
      text: `${name === cfg.activeProject ? '✅ ' : '📁 '}${name}`,
      callback_data: `proj:${name}`,
    }));
    rows.push(pair);
  }
  rows.push([{ text: '🔙 Quay lại bảng điều khiển', callback_data: 'hub:status' }]);
  return { inline_keyboard: rows };
}

async function main() {
  const tgModulePath = pathToFileURL(path.join(repoRoot, '.agents', 'scripts', 'telegram.mjs')).href;
  const tg = await import(tgModulePath);
  const { token, chatId } = tg.getTelegramCredentials(repoRoot);

  if (textArg) {
    await tg.callTelegramApi(token, 'sendMessage', {
      chat_id: chatId,
      text: textArg,
      reply_markup: showProjectsMenu ? buildProjectsKeyboard() : buildQuickKeyboard(),
    });
  }

  const targetRoots = new Set([repoRoot]);
  if (fs.existsSync(projectsFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      for (const pRoot of Object.values(cfg.projects || {})) {
        if (pRoot) targetRoots.add(String(pRoot));
      }
    } catch (_e) {}
  }

  for (const r of targetRoots) {
    const pInbox = path.join(r, '.agents', 'state', 'TELEGRAM_INBOX.json');
    if (fs.existsSync(pInbox)) {
      try {
        const inbox = JSON.parse(fs.readFileSync(pInbox, 'utf8'));
        for (const item of inbox) {
          item.processed = true;
          item.processedAt = new Date().toISOString();
        }
        fs.writeFileSync(pInbox, `${JSON.stringify(inbox, null, 2)}\n`, 'utf8');
      } catch (_e) {}
    }
  }
  console.log('[TELEGRAM REPLY]: Sent and marked inbox as processed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
