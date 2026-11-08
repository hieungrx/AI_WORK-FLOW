#!/usr/bin/env node
// CLI chờ quyết định của người dùng trên Telegram khi xảy ra Escalation (exitCode = 3).
// Trả về mã thoát chuẩn:
//   10 = Chọn phương án A/B/C (+1 vòng)
//   11 = Gia hạn thêm +2 vòng
//   12 = Chấp nhận rủi ro (Human Override -> APPROVED)
//   13 = Đổi mục tiêu / Nhập chỉ đạo mới bằng văn bản (+2 vòng)
//   14 = Dừng Task
//   15 = Hết thời gian chờ (Timeout)
import process from 'node:process';
import {
  REPO_ROOT,
  DECISION_EXIT_CODES,
  waitForTelegramDecision,
} from './telegram.mjs';

function parseAwaitArgs(argv) {
  let timeoutMinutes = 60;
  let taskId = '';
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--timeout-minutes' && i + 1 < argv.length) {
      timeoutMinutes = Math.max(1, Number(argv[++i]) || 60);
    } else if (a.startsWith('--timeout-minutes=')) {
      timeoutMinutes = Math.max(1, Number(a.slice('--timeout-minutes='.length)) || 60);
    } else if (a === '--task' && i + 1 < argv.length) {
      taskId = argv[++i].trim();
    } else if (a.startsWith('--task=')) {
      taskId = a.slice('--task='.length).trim();
    }
  }
  return { timeoutMs: timeoutMinutes * 60 * 1000, taskId };
}

async function main() {
  const { timeoutMs, taskId } = parseAwaitArgs(process.argv.slice(2));
  console.log(
    `[AWAIT TELEGRAM DECISION]: Đang chờ bạn bấm nút quyết định (hoặc nhắn tin) trên Telegram${
      taskId ? ` cho "${taskId}"` : ''
    }...`
  );
  const record = await waitForTelegramDecision({
    repoRoot: REPO_ROOT,
    timeoutMs,
  });
  console.log(`[DECISION RECEIVED]: action=${record.action} | exitCode=${record.exitCode}`);
  console.log(`[SUMMARY]: ${record.summaryNote}`);
  process.exit(record.exitCode ?? DECISION_EXIT_CODES.EXTEND);
}

main().catch((err) => {
  console.error(`[AWAIT DECISION ERROR]: ${err.message}`);
  process.exit(DECISION_EXIT_CODES.TIMEOUT);
});
