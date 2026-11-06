# ROADMAP: Dự án Demo - CLI Quản lý Công việc (Todo CLI bằng Node.js)

## Mục tiêu
Xây dựng ứng dụng CLI quản lý danh sách công việc (Todo CLI) bằng Node.js thuần (sử dụng module chuẩn `fs`, `path`), lưu trữ dữ liệu bền vững vào file `tasks.json` và có bộ kiểm thử tự động đi kèm.

## Quy ước Thẻ Model & Mức Suy luận (Model & Reasoning Tags)
- ChatGPT Mentor được gọi trực tiếp qua `node .agents/scripts/ask_mentor.mjs` (không truyền `--model gpt-4o`), tự động kích hoạt mức độ suy luận **Cao / High** (`ensureHighReasoning`).
- `[WORKER_MODEL: <pro/flash>]`: Model khuyến nghị cho Worker Agent khi thực thi task (`pro` cho thiết kế/logic phức tạp, `flash` hoặc `pro/flash` cho kiểm thử/tác vụ tiêu chuẩn).

## Danh sách Công việc (Tasks)
- [x] [WORKER_MODEL: pro] Task 1: Viết module `src/todo.js` hỗ trợ thêm, xóa, liệt kê và đánh dấu hoàn thành task (lưu vào `tasks.json`).
- [x] [WORKER_MODEL: pro/flash] Task 2: Viết script kiểm thử tự động `src/todo.test.js` kiểm tra toàn bộ các hàm của `src/todo.js`.
