# HANDOFF: Trạng thái Bàn giao Phiên làm việc

## 1. Bối cảnh & Mục tiêu dự án
Dự án Demo minh họa kiến trúc điều phối **Multi-Account Antigravity + ChatGPT Mentor** theo quy trình **RPIR (Research - Plan - Implement - Review Code)** tự động hóa hoàn toàn qua trình duyệt Chrome CDP (`http://localhost:9222`), kết hợp:
- Bật tự động mức suy luận **Cao / High** (`ensureHighReasoning`).
- Cơ chế **Circuit Breaker (`--mode rescue`)**.
- **Tự động xoay vòng luồng chat theo từng Task (Per-Task Thread Rotation)** qua `.agents/state/SESSION_MAP.json`, tham số `--task <task_id>`, `--new-thread` và khối khởi tạo ngữ cảnh `--- NGỮ CẢNH BÀN GIAO DỰ ÁN (BOOTSTRAP) ---`.
- **Khóa mã băm trạng thái SHA-256 (`STATE_LOCK.json`) & Git Pre-commit Hook (`verify_guard.mjs`)**: Chống sửa kế hoạch sau khi đã duyệt (`--check-plan`) và chống sửa code lén / commit khi chưa qua bước Review Code của Mentor (`--pre-commit`).

## 2. Những việc đã hoàn thành
- **Task 1 (`todo.js`)**: Đã hoàn thành toàn bộ quy trình RPI (kế hoạch v2.1 được phê duyệt `STATUS: APPROVED`, triển khai thành công 13 hàm/hằng số trong `todo.js`).
- **Task 2 (`todo.test.js`)**: Đã hoàn thành toàn bộ chu trình RPIR (`DESIGN GATE PASSED` & `IMPLEMENTATION GATE PASSED — CODE_STATUS: APPROVED` với `22/22 PASS`).
- **Nâng cấp Ưu tiên 1 (RPIR + High Reasoning + Rescue Mode)**:
  - Hỗ trợ 3 chế độ `--mode <plan|review-code|rescue>` (mặc định là `plan`), tự động bật mức suy luận **Cao / High**, tối ưu tốc độ điền văn bản lớn vào ProseMirror (`fillPromptFast`), và tự động chạy kèm bằng chứng kiểm thử trong `--mode review-code`.
- **Nâng cấp Ưu tiên 2 (Per-Task Thread Rotation qua `.agents/state/SESSION_MAP.json`)**:
  - Lưu ánh xạ luồng chat theo từng Task trong `.agents/state/SESSION_MAP.json` (đã lưu URL của `task-2`).
  - Hỗ trợ `--task <task_id>` và `--new-thread`. Khi `task_id` chưa có URL trong `SESSION_MAP.json`, `prepareTaskThread` tự động coi `isNewThread = true` (mở phiên mới + gắn khối Bootstrap từ `ROADMAP.md` và `HANDOFF.md`) ngay cả khi không truyền cờ `--new-thread`.
- **Nâng cấp Ưu tiên 3 (Khóa mã băm trạng thái SHA-256 & Git Pre-commit Hook)**:
  - Chuẩn hóa xuống dòng `.replace(/\r\n/g, '\n').trim()` trên Windows trước khi tính SHA-256.
  - Cập nhật `.agents/scripts/ask_mentor.mjs`:
    - Ở `--mode plan`: Khi đạt `STATUS: APPROVED`, tự động tính `planSha256` của `.agents/state/CURRENT_PLAN.md`, lưu vào `.agents/state/STATE_LOCK.json` (kèm `taskId`, `planApprovedAt`) và chèn `<!-- PLAN_SHA256: <hash> | TASK: <task_id> -->` vào cuối `.agents/state/MENTOR_FEEDBACK.md`.
    - Ở `--mode review-code`: Khi test pass (`testExitCode === 0`) và đạt `CODE_STATUS: APPROVED`, tự động tính `codeSha256` từ `git diff HEAD` của `src/` và `tests/` (+ file untracked nếu có), lưu vào `.agents/state/STATE_LOCK.json` (kèm `taskId`, `testExitCode: 0`, `codeApprovedAt`) và chèn `<!-- CODE_SHA256: <hash> | TASK: <task_id> | TEST_EXIT: 0 -->` vào cuối `.agents/state/CODE_REVIEW_FEEDBACK.md`.
  - Tạo `.agents/scripts/verify_guard.mjs` hỗ trợ `--check-plan` và `--pre-commit`.
  - Tích hợp `--check-plan` vào `.agents/scripts/check_plan_approved.sh` và cài đặt `.git/hooks/pre-commit` gọi tự động `node .agents/scripts/verify_guard.mjs --pre-commit`.

## 3. Ghi nhận Technical Debt (Chuẩn bị cho Task 3)
1. **Path containment (`isInsideDir`)**: Tinh chỉnh điều kiện kiểm tra `rel === '..' || rel.startsWith('..' + path.sep)` để không từ chối nhầm thư mục con hợp lệ có tên bắt đầu bằng `..` (ví dụ `..foo`).
2. **Runner self-verification (`T9.1`)**: Bổ sung thêm assertion kiểm tra `failures[0].stack`, `failures.length` và `passed + failed === total` ở cả hai nhánh.
3. **Fault injection**: Các bài kiểm thử lỗi I/O hiện dùng mock hàm `fs` ở tầng JavaScript; nếu mở rộng có thể bổ sung tích hợp kiểm thử lỗi filesystem thực tế.

## 4. Trạng thái hiện tại
- **Task 1**: Đã hoàn thành `[x]`.
- **Task 2**: Đã hoàn thành `[x]` (`DESIGN GATE: APPROVED`, `IMPLEMENTATION GATE: CODE_STATUS: APPROVED`, đã khóa `planSha256` và `codeSha256` trong `.agents/state/STATE_LOCK.json`).
- **Trạng thái Mentor & Khóa An toàn**:
  - `.agents/state/CODE_REVIEW_FEEDBACK.md`: `CODE_STATUS: APPROVED` (kèm `CODE_SHA256`).
  - `.agents/state/STATE_LOCK.json`: Đã lưu `planSha256`, `codeSha256`, `testExitCode: 0` cho `task-2`.
  - `.agents/state/MENTOR_FEEDBACK.md`: `STATUS: PENDING` (khóa Safety Gate chờ Task 3).

## 5. Bước tiếp theo (Next Steps)
- Bắt đầu **Task 3** (giải quyết các mục Technical Debt từ Task 2) theo đúng chu trình RPIR với luồng chat mới tự động (`--task task-3`).
