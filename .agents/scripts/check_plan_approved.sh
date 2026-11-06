#!/usr/bin/env bash
# Kiểm tra nếu .agents/state/MENTOR_FEEDBACK.md không chứa STATUS: APPROVED thì chặn thao tác vào src/ và trả về exit 2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

INPUT_DATA="$*"
if [ ! -t 0 ]; then
  STDIN_DATA="$(timeout 0.2 cat 2>/dev/null || true)"
  INPUT_DATA="$INPUT_DATA $STDIN_DATA"
fi

# Cho phép ghi/sửa các file trạng thái ngoài thư mục src/ (như .agents/state/*)
if [ -n "$INPUT_DATA" ]; then
  if echo "$INPUT_DATA" | grep -Eq '"(Path|file_path|TargetFile|path)"' && ! echo "$INPUT_DATA" | grep -Eq '(^|[/\\"'"'"' ])src([/\\]|$)'; then
    echo '{"decision": "allow"}'
    exit 0
  fi
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