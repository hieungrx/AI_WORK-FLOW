#!/usr/bin/env bash
# Kiểm tra nếu thao tác ghi/sửa chạm tới thư mục src/:
# bắt buộc .agents/state/MENTOR_FEEDBACK.md phải có STATUS: APPROVED
# và mã băm CURRENT_PLAN.md phải khớp với planSha256 trong .agents/state/STATE_LOCK.json

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

INPUT_DATA="$*"
if [ ! -t 0 ]; then
  STDIN_DATA="$(timeout 0.2 cat 2>/dev/null || true)"
  INPUT_DATA="$INPUT_DATA $STDIN_DATA"
fi

# Trích xuất riêng trường đường dẫn file mục tiêu (Path / file_path / TargetFile / path)
# để không bị chặn nhầm khi nội dung văn bản của các file ngoài src/ có nhắc tới chữ "src/"
if [ -n "$INPUT_DATA" ]; then
  TARGET_PATHS="$(echo "$INPUT_DATA" | grep -Eo '"(Path|file_path|TargetFile|path)"[[:space:]]*:[[:space:]]*"[^"]+"' || true)"
  if [ -n "$TARGET_PATHS" ]; then
    if ! echo "$TARGET_PATHS" | grep -Eq '([/\\]|^")src([/\\]|")'; then
      echo '{"decision": "allow"}'
      exit 0
    fi
  elif ! echo "$INPUT_DATA" | grep -Eq '(^|[/\\"'"'"' ])src([/\\]|$)'; then
    echo '{"decision": "allow"}'
    exit 0
  fi
fi

# Khi thao tác chạm tới src/, gọi verify_guard.mjs --check-plan để kiểm tra cả STATUS: APPROVED và planSha256
if command -v node >/dev/null 2>&1 && [ -f "$REPO_ROOT/.agents/scripts/verify_guard.mjs" ]; then
  GUARD_MSG="$(node "$REPO_ROOT/.agents/scripts/verify_guard.mjs" --check-plan 2>&1)"
  GUARD_EXIT=$?
  if [ $GUARD_EXIT -ne 0 ]; then
    echo "$GUARD_MSG" >&2
    echo "$GUARD_MSG"
    exit 2
  fi
  echo '{"decision": "allow"}'
  exit 0
fi

FEEDBACK_FILE=".agents/state/MENTOR_FEEDBACK.md"
if [ ! -f "$FEEDBACK_FILE" ]; then
  FEEDBACK_FILE="$REPO_ROOT/.agents/state/MENTOR_FEEDBACK.md"
fi

if [ ! -f "$FEEDBACK_FILE" ] || ! grep -q "STATUS: APPROVED" "$FEEDBACK_FILE"; then
  echo "CẢNH BÁO CHẶN THAO TÁC: .agents/state/MENTOR_FEEDBACK.md chưa có 'STATUS: APPROVED'. Tuyệt đối không được tạo hoặc sửa file trong src/!" >&2
  echo "CẢNH BÁO CHẶN THAO TÁC: .agents/state/MENTOR_FEEDBACK.md chưa có 'STATUS: APPROVED'. Tuyệt đối không được tạo hoặc sửa file trong src/!"
  exit 2
fi

echo '{"decision": "allow"}'
exit 0
