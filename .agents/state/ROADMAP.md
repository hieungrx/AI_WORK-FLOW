# ROADMAP: Lộ trình Phát triển Dự án

## Quy ước Thẻ Model & Định tuyến Chuyên gia
- Gắn thẻ `[WORKER_MODEL: pro]` cho các Task thiết kế kiến trúc/logic phức tạp hoặc `[WORKER_MODEL: flash]` cho các Task đơn giản/kiểm thử.
- Hệ thống tự động định tuyến tới Chuyên gia ChatGPT Mentor qua lệnh:
  `node .agents/scripts/ask_mentor.mjs --mode <plan|review-code|rescue> --task <task_id> --role <role_key>`

## Danh sách Công việc (Tasks)
- [ ] [WORKER_MODEL: pro] Task 1: Khởi tạo kiến trúc và tính năng đầu tiên của dự án.
