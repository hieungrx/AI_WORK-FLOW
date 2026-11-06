# HANDOFF: Trạng thái Bàn giao Phiên làm việc

## 1. Bối cảnh & Mục tiêu dự án
Dự án Demo minh họa kiến trúc điều phối **Multi-Account Antigravity + ChatGPT Mentor** theo quy trình **RPIR (Research - Plan - Implement - Review Code)** tự động hóa qua trình duyệt Chrome CDP (`http://localhost:9222`), kết hợp:
- Bật tự động mức suy luận **Cao / High** (`ensureHighReasoning`).
- Cơ chế **Circuit Breaker (`--mode rescue`)**.
- **Tự động gom luồng chat vào ChatGPT Project (`AI-WORKSPACE`) & Xoay vòng luồng theo Task & Giai đoạn (`SESSION_MAP.json`)**: Lưu cấu trúc phiên riêng biệt theo giai đoạn (`task-x-plan`, `task-x-review`, `task-x-rescue`) và giới hạn cứng tối đa **2 vòng review** cho cùng một giai đoạn (`MAX_ROUNDS_PER_STAGE = 2`).
- **Bộ công cụ Guard tinh giản (`verify_guard.mjs` < 80 dòng)**:
  - `--check-plan`: Kiểm tra `.agents/state/MENTOR_FEEDBACK.md` có `STATUS: APPROVED`.
  - `--pre-commit`: Khi commit có thay đổi trong `src/` hoặc `tests/`, chạy `npm test` đạt `exitCode === 0` và kiểm tra `.agents/state/CODE_REVIEW_FEEDBACK.md` có `CODE_STATUS: APPROVED`.
- **Phạm vi Review Code (`--mode review-code`)**: Chỉ gửi kết quả `npm test` + `git diff HEAD -- src/ tests/` (kèm danh sách/nội dung file mới trong `src/`, `tests/`). Tuyệt đối không gửi kèm code của `.agents/`.

---

## 2. Tiến độ & Kết quả Kiểm thử Hiện tại
- **Task 1 (`src/todo.js`)**: Đã hoàn thành (`[x]`).
- **Task 2 (`src/todo.test.js`)**: Đã hoàn thành (`[x]`).
- **Task 3 (`src/todo.js`, `src/todo.test.js`, `tests/fs_fault.test.js`)**: Đã hoàn thành (`[x]`) và chốt sổ:
  - `src/todo.test.js`: **23/23 PASS | 0 FAIL**.
  - `tests/fs_fault.test.js`: **7/8 PASS | 0 FAIL | 1 SKIP** (FS-3 skip hợp lệ trên Windows NTFS).
  - Lệnh `npm test` đạt `exitCode: 0` (100% PASS).

---

## 3. Quy tắc Bảo vệ Công cụ
- Khi thực hiện các Task trong `ROADMAP.md`, Worker chỉ làm việc trên `src/`, `tests/` và `.agents/state/`. **TUYỆT ĐỐI KHÔNG** tự ý chỉnh sửa các script trong `.agents/scripts/`.

---

## 4. Trạng thái Bàn giao
- Toàn bộ 3 Task trong `.agents/state/ROADMAP.md` đã hoàn thành `[x]`.
- Quy trình điều phối RPIR và bộ công cụ Guard trong `.agents/scripts/` đã được tinh giản và sẵn sàng sử dụng cho các dự án/task tiếp theo.
