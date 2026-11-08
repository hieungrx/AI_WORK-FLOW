#!/usr/bin/env node
// Công cụ cài đặt & kiểm tra kết nối Telegram Bot 2 chiều (npm run telegram-setup).
import process from 'node:process';
import {
  REPO_ROOT,
  getTelegramCredentials,
  upsertEnvFile,
  getBotInfo,
  detectChatIdFromUpdates,
  callTelegramApi,
} from './telegram.mjs';

function parseSetupArgs(argv) {
  let token = '';
  let chatId = '';
  let waitSeconds = 60;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--token' && i + 1 < argv.length) {
      token = argv[++i].trim();
    } else if (a.startsWith('--token=')) {
      token = a.slice('--token='.length).trim();
    } else if (a === '--chat-id' && i + 1 < argv.length) {
      chatId = argv[++i].trim();
    } else if (a.startsWith('--chat-id=')) {
      chatId = a.slice('--chat-id='.length).trim();
    } else if (a === '--wait' && i + 1 < argv.length) {
      waitSeconds = Math.max(0, Number(argv[++i]) || 0);
    } else if (a === '--no-wait') {
      waitSeconds = 0;
    }
  }
  return { token, chatId, waitSeconds };
}

async function main() {
  const args = parseSetupArgs(process.argv.slice(2));
  const saved = getTelegramCredentials(REPO_ROOT);
  const token = args.token || saved.token;
  let chatId = args.chatId || saved.chatId;

  if (!token) {
    console.error(
      '[TELEGRAM SETUP]: Chưa có TELEGRAM_BOT_TOKEN trong .env.\n' +
        'Hãy thêm TELEGRAM_BOT_TOKEN=<token> vào file .env hoặc chạy: npm run telegram-setup -- --token <token>'
    );
    process.exit(1);
  }

  if (args.token) {
    upsertEnvFile(REPO_ROOT, { TELEGRAM_BOT_TOKEN: token });
  }

  const bot = await getBotInfo(token);
  console.log(
    `[TELEGRAM BOT OK]: Đã kết nối Bot "${bot.first_name}" (@${bot.username} — link: https://t.me/${bot.username})`
  );

  if (!chatId) {
    console.log(
      `\n👉 Hãy mở Telegram, bấm vào link https://t.me/${bot.username} và nhấn nút START (hoặc gửi "/start")...`
    );
    const deadline = Date.now() + args.waitSeconds * 1000;
    while (Date.now() <= deadline) {
      const detected = await detectChatIdFromUpdates(token);
      if (detected?.chatId) {
        chatId = detected.chatId;
        console.log(
          `[TELEGRAM CHAT DETECTED]: Đã nhận diện tài khoản "${detected.firstName || detected.username || chatId}" (chat_id: ${chatId}).`
        );
        break;
      }
      if (args.waitSeconds <= 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!chatId) {
    console.log(
      `\n[CHƯA NHẬN ĐƯỢC /start]: Bot @${bot.username} đã sẵn sàng nhưng bạn chưa nhắn "/start" cho Bot.\n` +
        `Sau khi nhắn "/start" cho @${bot.username} trên Telegram, hãy chạy lại: npm run telegram-setup`
    );
    process.exit(2);
  }

  upsertEnvFile(REPO_ROOT, { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: chatId });
  await callTelegramApi(token, 'sendMessage', {
    chat_id: chatId,
    text:
      `✅ [AI-WorkFlow] Kết nối Telegram 2 chiều thành công!\n` +
      `• Bot: @${bot.username}\n` +
      `• Chat ID: ${chatId}\n` +
      `Từ bây giờ, khi quy trình RPIR gặp Escalation hoặc cần bạn xác nhận mục tiêu, thông báo giải thích dễ hiểu kèm nút bấm sẽ được gửi trực tiếp vào đây.`,
  });
  console.log(`[TELEGRAM READY]: Đã lưu TELEGRAM_CHAT_ID=${chatId} vào .env và gửi tin nhắn kiểm tra thành công!`);
}

main().catch((err) => {
  console.error(`[TELEGRAM SETUP ERROR]: ${err.message}`);
  process.exit(1);
});
