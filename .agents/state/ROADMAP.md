# ROADMAP: Dự án <TỰ ĐỘNG THEO TÊN THƯ MỤC DỰ ÁN>

## Mục tiêu
Mô tả mục tiêu tổng thể của sản phẩm tại đây.

## Quy ước Thẻ Model & Chuyên gia
- Worker Agent: gắn thẻ `[WORKER_MODEL: pro]` (kiến trúc/phức tạp) hoặc `[WORKER_MODEL: flash]` (đơn giản/kiểm thử).
- Mentor Gate: tự động định tuyến chuyên gia qua `node .agents/scripts/ask_mentor.mjs --mode <plan|review-code|rescue> --task <task_id> --role <role_key>`.

## Danh sách Công việc (Tasks)
- [ ] [WORKER_MODEL: pro] Task 1: Thiết kế và khởi tạo kiến trúc cốt lõi của ứng dụng trong `src/`.
- [ ] [WORKER_MODEL: pro/flash] Task 2: Xây dựng tính năng chính và bộ kiểm thử tự động trong `tests/`.
