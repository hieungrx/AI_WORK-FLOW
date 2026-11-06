# HANDOFF STATE — HOÀN TẤT TOÀN BỘ ROADMAP DỰ ÁN (TASK 1 & TASK 2) + TỰ ĐỘNG HÓA MENTOR CDP

## 1. Trạng thái Chung của Dự án
- **Dự án**: CLI Quản lý Công việc (Todo CLI bằng Node.js) + Hệ thống Điều phối Tự động Antigravity & ChatGPT Mentor qua Chrome CDP.
- **Tiến độ ROADMAP (`.agents/state/ROADMAP.md`)**:
  - `[x] [MENTOR_MODEL: gpt-4o] [WORKER_MODEL: pro] Task 1`: Viết module `src/todo.js` hỗ trợ thêm, xóa, liệt kê và đánh dấu hoàn thành task (lưu vào `tasks.json`).
  - `[x] [MENTOR_MODEL: gpt-4o] [WORKER_MODEL: pro/flash] Task 2`: Viết script kiểm thử tự động `src/todo.test.js` kiểm tra toàn bộ các hàm của `src/todo.js`.
- **Bước hiện tại trong quy trình RPI**: **Implemented & Verified** (100% các task trong `ROADMAP.md` đã hoàn thành và vượt qua toàn bộ kiểm thử nghiệm thu).
- **Trạng thái Mentor (`.agents/state/MENTOR_FEEDBACK.md`)**: Đã đặt lại về `STATUS: PENDING` để khóa cổng an toàn sau khi hoàn tất Task 2.

---

## 2. Tóm tắt Những việc Đã Thực hiện trong Phiên này

### 2.1. Nâng cấp Tự động hóa Quy trình RPI với ChatGPT Mentor (`playwright-core` + Chrome CDP)
1. **Khởi tạo `package.json` & Cài đặt `playwright-core`**:
   - Khởi tạo `package.json` với các script `"test": "node src/todo.test.js"` và `"ask-mentor": "node .agents/scripts/ask_mentor.mjs"`.
2. **Xây dựng `.agents/scripts/ask_mentor.mjs` (Hỗ trợ 3 chế độ `--mode <plan|review-code|rescue>` + High Reasoning)**:
   - Loại bỏ chuỗi `(Model: ...)` ở đầu prompt và bỏ tham số mặc định `--model gpt-4o` để không làm nhiễu ngữ cảnh của Mentor.
   - Bổ sung hàm `ensureHighReasoning(page)` chạy ngay trước bước điền văn bản vào ô chat ProseMirror: tự động kiểm tra nút mức độ suy luận đang ở `"Vừa"`, `"Thấp"`, `"Medium"` hoặc `"Low"` và chuyển sang `"Cao"` / `"High"` (bọc trong `try/catch` an toàn).
   - Hỗ trợ 3 chế độ thực thi qua cờ `--mode <plan|review-code|rescue>` (mặc định là `plan`):
     - `--mode plan`: Đọc `.agents/state/CURRENT_PLAN.md`, gửi cho ChatGPT Mentor duyệt thiết kế kiến trúc, ghi kết quả (`STATUS: APPROVED` hoặc `STATUS: REJECTED`) vào `.agents/state/MENTOR_FEEDBACK.md`.
     - `--mode review-code`: Tự động chạy `git status --short` và `git diff` (giới hạn độ dài an toàn) kết hợp đọc `.agents/state/CURRENT_PLAN.md` để gửi cho ChatGPT Mentor kiểm tra chéo code thực tế so với bản thiết kế, ghi kết quả (`CODE_STATUS: APPROVED` hoặc `CODE_STATUS: REJECTED` ở dòng đầu) vào `.agents/state/CODE_REVIEW_FEEDBACK.md`.
     - `--mode rescue --error "<tóm tắt lỗi>"`: Đọc `.agents/state/CURRENT_PLAN.md`, kèm `git diff` hiện tại và thông tin lỗi test thất bại để xin giải pháp gỡ bế tắc từ ChatGPT Mentor, ghi vào `.agents/state/MENTOR_FEEDBACK.md`.
3. **Cập nhật Quy tắc Điều phối RPIR & Circuit Breaker (`GEMINI.md`, `CLAUDE.md`, `.agents/skills/mentor-rpi/SKILL.md`, `.agents/state/ROADMAP.md`)**:
   - Nâng cấp quy trình từ RPI lên **RPIR (Research -> Plan -> Implement -> Review Code)**.
   - Quy định rõ: Sau khi Implement và chạy pass toàn bộ test, bắt buộc phải chạy `node .agents/scripts/ask_mentor.mjs --mode review-code` và nhận được `CODE_STATUS: APPROVED` trong `.agents/state/CODE_REVIEW_FEEDBACK.md` trước khi được phép đánh dấu hoàn thành Task trong `.agents/state/ROADMAP.md`.
   - Bổ sung **Quy tắc Circuit Breaker**: Nếu chạy test hoặc sửa lỗi thất bại quá 3 lần liên tiếp ở bước Implement, dừng ngay việc tự thử nghiệm và gọi `node .agents/scripts/ask_mentor.mjs --mode rescue --error "<tóm tắt lỗi>"` để nhận hướng dẫn từ Mentor.

### 2.2. Thực thi Chu trình RPI Tự động cho Task 2 (`src/todo.test.js`)
1. **Vòng Review 1 (v1.0 -> `REJECTED`)**:
   - Gửi `CURRENT_PLAN.md` v1.0 qua `ask_mentor.mjs`, nhận phản hồi `STATUS: REJECTED` với 5 Blocker và 7 đề xuất cải tiến kỹ thuật từ ChatGPT Mentor.
2. **Vòng Review 2 (v1.1 -> `APPROVED`)**:
   - Cập nhật `CURRENT_PLAN.md` lên bản v1.1 giải quyết triệt để cả 5 Blocker (Import isolation bằng tiến trình con độc lập ở T7.1, xác định rõ hợp đồng `process.exitCode` ở T7.2, write-path guard ở T4.1, bảo toàn lỗi gốc kèm lỗi cleanup ở `withTempWorkspace`, và tự kiểm chứng runner định lượng ở T9.1–T9.2).
   - Gửi lại qua `node .agents/scripts/ask_mentor.mjs --model gpt-4o` và nhận kết quả **`STATUS: APPROVED` (`DESIGN GATE PASSED`)**.
3. **Triển khai & Kiểm chứng `src/todo.test.js` (Step 4 — Implement)**:
   - Triển khai hoàn chỉnh `src/todo.test.js` bao phủ toàn bộ 13 exports, 8 nhóm nghiệm thu (T1.1 -> T8.3), nhóm tự kiểm chứng runner & cleanup (T9.1 -> T9.2), và tích hợp đầy đủ 5 lưu ý kỹ thuật khi code của Mentor (kiểm thử trực tiếp `validateTaskList`/`saveTasks`, `delete childEnv.TODO_FILE`, kiểm thử lỗi ghi dở một phần file `.tmp`, kiểm chứng exit code `1` cấp tiến trình con khi runner có assertion fail).
   - Chạy `npm test` (`node src/todo.test.js`): đạt tuyệt đối **`22/22 PASS | 0/22 FAIL (Executed: 22)`** với `exitCode = 0`, không phát sinh file rác hay thay đổi ngoài ý muốn trong thư mục dự án.

---

## 3. Hướng dẫn cho Phiên / Account Tiếp theo
- Toàn bộ 2 Task trong `.agents/state/ROADMAP.md` đã hoàn thành (`[x]`).
- Nếu người dùng bổ sung Task mới vào `.agents/state/ROADMAP.md`, thực hiện theo đúng quy trình **RPIR**:
  1. Đọc `HANDOFF.md`, `MENTOR_FEEDBACK.md`, `ROADMAP.md`.
  2. Thực hiện Research & Plan vào `.agents/state/CURRENT_PLAN.md`.
  3. Gọi tự động `node .agents/scripts/ask_mentor.mjs --mode plan` (hoặc `node .agents/scripts/ask_mentor.mjs`) và chuyển sang bước **Implement** ngay khi nhận được `STATUS: APPROVED`.
  4. Ở bước **Implement**, nếu chạy test hoặc sửa lỗi thất bại quá 3 lần liên tiếp (Circuit Breaker), dừng ngay và gọi `node .agents/scripts/ask_mentor.mjs --mode rescue --error "<tóm tắt lỗi>"`.
  5. Sau khi toàn bộ test pass, bắt buộc gọi `node .agents/scripts/ask_mentor.mjs --mode review-code` và nhận `CODE_STATUS: APPROVED` trong `.agents/state/CODE_REVIEW_FEEDBACK.md` trước khi đánh dấu `[x]` hoàn thành Task trong `.agents/state/ROADMAP.md`.
