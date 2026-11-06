# Quy tắc Điều phối Multi-Account Antigravity + ChatGPT Mentor (GEMINI.md)

Tài liệu này quy định quy trình làm việc bắt buộc cho mọi AI Agent (Antigravity / Gemini / Claude) tham gia dự án.

## 1. Khởi đầu Phiên làm việc (Mandatory Session Start)
Ngay khi bắt đầu bất kỳ phiên làm việc nào, Agent **BẮT BUỘC** phải đọc các file trạng thái theo thứ tự sau trước khi thực hiện bất kỳ hành động nào khác:
1. `.agents/state/HANDOFF.md` — Nắm bắt ngữ cảnh, tiến độ hiện tại và công việc bàn giao từ phiên trước.
2. `.agents/state/MENTOR_FEEDBACK.md` — Kiểm tra trạng thái phê duyệt (`STATUS: PENDING`, `STATUS: APPROVED`, hoặc `STATUS: REJECTED`) và nhận xét từ ChatGPT Mentor.
3. `.agents/state/ROADMAP.md` — Xem danh sách các task tổng thể của dự án.
4. `.agents/state/SESSION_MAP.json` & `.agents/state/STATE_LOCK.json` (nếu có) — Kiểm tra ánh xạ luồng chat theo từng Task và khóa mã băm SHA-256 (`planSha256`, `codeSha256`, `testExitCode`).

## 2. Quy tắc Chọn Model, Xoay vòng Luồng Chat (Per-Task Thread Rotation) & Quy trình RPIR

### 2.1. Quy tắc Chọn Model & Mức Suy luận trong `.agents/state/ROADMAP.md`
- Mỗi task trong `.agents/state/ROADMAP.md` có thể gắn thẻ cấu hình điều phối:
  - `[WORKER_MODEL: pro/flash]` (ví dụ `pro` cho task kiến trúc phức tạp, `flash` cho task đơn giản/kiểm thử): Model khuyến nghị cho Worker Agent (Antigravity / Gemini / Claude) khi thực thi task.
  - ChatGPT Mentor mặc định được gọi trực tiếp qua `node .agents/scripts/ask_mentor.mjs --task <task_id>` (không truyền `--model gpt-4o` để tránh làm nhiễu ngữ cảnh), hỗ trợ 3 chế độ `--mode <plan|review-code|rescue>` (mặc định là `plan`), và tự động kích hoạt mức độ suy luận **Cao / High** (`ensureHighReasoning(page)`) trước khi gửi prompt.

### 2.2. Tự động Xoay vòng Luồng Chat theo Task (`SESSION_MAP.json` & `--task <task_id>`)
- Hệ thống quản lý luồng chat riêng biệt cho từng Task trong `.agents/state/SESSION_MAP.json`:
  - Khi gọi `ask_mentor.mjs`, truyền tham số `--task <task_id>` (ví dụ: `--task task-3`). Nếu không truyền `--task`, script sẽ tự động trích xuất mã Task hiện tại từ tiêu đề `.agents/state/CURRENT_PLAN.md` hoặc mục chưa hoàn thành `[ ]` đầu tiên trong `.agents/state/ROADMAP.md`.
  - **Tiếp tục luồng hiện có**: Nếu `task_id` đã có URL trong `.agents/state/SESSION_MAP.json` (và không truyền `--new-thread`), script tự động điều hướng tab ChatGPT tới đúng URL đó để giữ nguyên mạch review của Task hiện tại.
  - **Khởi tạo luồng mới cho Task mới**: Nếu `task_id` chưa có URL trong `.agents/state/SESSION_MAP.json` (hoặc có cờ `--new-thread`), script tự động coi `isNewThread = true`, mở phiên trò chuyện mới sạch sẽ (qua `projectUrl` hoặc nút "Trò chuyện mới"), tự động ghép khối `--- NGỮ CẢNH BÀN GIAO DỰ ÁN (BOOTSTRAP) ---` (gồm `ROADMAP.md` và `HANDOFF.md`) vào đầu prompt lượt đầu tiên, và lưu URL `/c/...` mới vào `.agents/state/SESSION_MAP.json`.

### 2.3. Quy trình RPIR Tự động hóa & Cơ chế Circuit Breaker
Mọi Agent phải tuân thủ nghiêm ngặt quy trình RPIR khép kín được định nghĩa chi tiết trong `.agents/skills/mentor-rpi/SKILL.md`:
1. **Context Loading**: Đọc `.agents/state/HANDOFF.md`, `.agents/state/MENTOR_FEEDBACK.md` và `.agents/state/ROADMAP.md`.
2. **Research**: Phân tích yêu cầu của task hiện tại trong `.agents/state/ROADMAP.md` và khảo sát codebase.
3. **Plan & Auto-Mentor Review (`--mode plan`)**: Lập kế hoạch thiết kế chi tiết vào `.agents/state/CURRENT_PLAN.md`, đặt `.agents/state/MENTOR_FEEDBACK.md` ở trạng thái `STATUS: PENDING` và cập nhật `HANDOFF.md`. Sau khi viết xong `CURRENT_PLAN.md`, Antigravity **KHÔNG dừng lại chờ người dùng copy-paste thủ công nữa**, mà phải **tự động gọi lệnh**:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode plan --task <task_id>
   ```
   - Nếu kết quả trả về có **`STATUS: APPROVED`**: Script tự động khóa mã băm `planSha256` vào `.agents/state/STATE_LOCK.json` (kèm `<!-- PLAN_SHA256: <hash> | TASK: <task_id> -->` cuối `MENTOR_FEEDBACK.md`). Agent **tự động chuyển ngay sang bước 4 (Implement) trong cùng phiên chạy**.
   - Nếu kết quả trả về có **`STATUS: REJECTED`**: Phân tích kỹ nhận xét trong `.agents/state/MENTOR_FEEDBACK.md`, cập nhật lại `.agents/state/CURRENT_PLAN.md` và gọi lại `node .agents/scripts/ask_mentor.mjs --mode plan --task <task_id>`.
4. **Implement**: Chỉ thực thi viết/sửa code trong `src/` sau khi `.agents/state/MENTOR_FEEDBACK.md` có `STATUS: APPROVED` và mã băm của `CURRENT_PLAN.md` khớp với `planSha256` trong `STATE_LOCK.json`:
   - **Quy tắc Circuit Breaker (`--mode rescue`)**: Nếu chạy test hoặc sửa lỗi thất bại quá **3 lần liên tiếp** ở bước Implement, Agent phải **dừng ngay việc tự thử nghiệm** và gọi lệnh:
     ```bash
     node .agents/scripts/ask_mentor.mjs --mode rescue --task <task_id> --error "<tóm tắt lỗi>"
     ```
     để gửi `CURRENT_PLAN.md` kèm `git diff` hiện tại và thông tin lỗi cho ChatGPT Mentor phân tích, nhận hướng dẫn gỡ bế tắc trong `.agents/state/MENTOR_FEEDBACK.md`.
5. **Review Code (`--mode review-code`)**: Sau khi Implement và chạy pass toàn bộ test, Agent **BẮT BUỘC** phải chạy lệnh:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode review-code --task <task_id>
   ```
   để gửi `git status --short`, `git diff` và `CURRENT_PLAN.md` cho ChatGPT Mentor kiểm tra chéo code thực tế so với bản thiết kế:
   - Chỉ khi test pass (`testExitCode === 0`) và nhận được **`CODE_STATUS: APPROVED`** trong `.agents/state/CODE_REVIEW_FEEDBACK.md` (kèm khóa mã băm `codeSha256` vào `.agents/state/STATE_LOCK.json` và `<!-- CODE_SHA256: <hash> | TASK: <task_id> | TEST_EXIT: 0 -->`), Agent mới được phép đánh dấu hoàn thành `[x]` cho Task trong `.agents/state/ROADMAP.md`, commit code và đặt lại `.agents/state/MENTOR_FEEDBACK.md` về `STATUS: PENDING` cho task tiếp theo.
   - Nếu nhận được **`CODE_STATUS: REJECTED`**, Agent phải sửa code theo phản hồi trong `.agents/state/CODE_REVIEW_FEEDBACK.md`, chạy lại test và gọi lại `--mode review-code --task <task_id>`.
6. **Handoff**: Cập nhật `.agents/state/HANDOFF.md` trước khi kết thúc phiên.

## 3. Quy tắc Khóa An toàn & Khóa Mã băm SHA-256 (Safety Gate & Pre-commit Guard)
- **Khóa trước khi sửa code (`--check-plan`)**: Hook `.agents/scripts/check_plan_approved.sh` tự động gọi `node .agents/scripts/verify_guard.mjs --check-plan` trước mọi thao tác ghi/sửa vào `src/`. Thao tác sẽ bị chặn (`exit 2`) nếu `MENTOR_FEEDBACK.md` chưa có `STATUS: APPROVED` hoặc `CURRENT_PLAN.md` bị chỉnh sửa sau khi duyệt (lệch `planSha256` trong `STATE_LOCK.json`).
- **Khóa trước khi Git Commit (`--pre-commit`)**: Hook `.git/hooks/pre-commit` tự động gọi `node .agents/scripts/verify_guard.mjs --pre-commit`. Mọi lệnh `git commit` có chứa thay đổi trong `src/` (hoặc `tests/`) hoặc đánh dấu hoàn thành `[x]` trong `.agents/state/ROADMAP.md` bắt buộc phải thỏa mãn:
  1. `.agents/state/CODE_REVIEW_FEEDBACK.md` có `CODE_STATUS: APPROVED`.
  2. `testExitCode === 0` trong `.agents/state/STATE_LOCK.json`.
  3. Mã băm diff hiện tại của `src/` và `tests/` khớp tuyệt đối với `codeSha256` trong `.agents/state/STATE_LOCK.json` (chống sửa code lén sau khi Mentor review).
  *(Cho phép commit các file cấu hình/hạ tầng trong `.agents/` khi không chạm tới `src/` và không đánh dấu `[x]` mới trong `ROADMAP.md`).*

## 4. Kết thúc Phiên & Bàn giao (Mandatory Handoff)
- Trước khi dừng hoặc kết thúc phiên làm việc (hoặc khi hết hạn mức/chuyển đổi tài khoản), Agent **LUÔN LUÔN** phải cập nhật đầy đủ trạng thái hiện tại, những việc đã làm, và bước tiếp theo vào `.agents/state/HANDOFF.md`.
