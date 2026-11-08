# ROADMAP: Dự án AI-WorkFlow

## Mục tiêu
Hoàn thiện và kiểm nghiệm thực tế quy trình RPIR v2 với module Quản lý & Tối ưu Ghi nhận Nợ Kỹ thuật (`TECH_DEBT.md`).

## Quy ước Thẻ Model & Chuyên gia
- Worker Agent: gắn thẻ `[WORKER_MODEL: pro]` (kiến trúc/phức tạp) hoặc `[WORKER_MODEL: flash]` (đơn giản/kiểm thử).
- Mentor Gate: tự động định tuyến chuyên gia qua `node .agents/scripts/ask_mentor.mjs --mode <plan|review-code|rescue> --task <task_id> --role <role_key>`.

## Danh sách Công việc (Tasks)
- [x] [WORKER_MODEL: pro] Task 1: Xây dựng module Quản lý & Tối ưu Ghi nhận Nợ Kỹ thuật (`src/tech_debt.mjs`) và bộ kiểm thử tự động (`tests/tech_debt.test.mjs`), tích hợp vào `review_policy.mjs`.
- [x] [WORKER_MODEL: pro] Task 2: Xây dựng cơ chế khóa tệp liên tiến trình (`withFileLock`) chống Lost Update khi ghi đồng thời `TECH_DEBT.md` (`[P1-02]`) và bổ sung kiểm thử Concurrency đa tiến trình + kiểm thử tích hợp luồng Review (`[P1-01]`).
- [x] [WORKER_MODEL: pro] Task 3: Hoàn thiện cơ chế bảo vệ `withFileLock` (từ chối callback bất đồng bộ `thenable` `[P1-03]`, xử lý tường minh lỗi giải phóng khóa `[P1-01]`) và mở rộng kiểm thử tiến trình con bị kill thực tế `[P1-02]` + tranh chấp `append`/`resolve` xen kẽ `[P2-01]`.
