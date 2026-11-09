# Quy tắc Điều phối Multi-Account Antigravity + ChatGPT Mentor (CLAUDE.md)

Tài liệu này quy định quy trình làm việc bắt buộc cho mọi AI Agent (Claude / Antigravity / Gemini) tham gia dự án.

## 1. Khởi đầu Phiên làm việc (Mandatory Session Start)
Ngay khi bắt đầu bất kỳ phiên làm việc nào, Agent **BẮT BUỘC** phải đọc các file trạng thái theo thứ tự sau trước khi thực hiện bất kỳ hành động nào khác:
1. `.agents/state/HANDOFF.md` — Nắm bắt ngữ cảnh, tiến độ hiện tại và công việc bàn giao từ phiên trước.
2. `.agents/state/MENTOR_FEEDBACK.md` — Kiểm tra trạng thái phê duyệt (`STATUS: PENDING`, `STATUS: APPROVED`, hoặc `STATUS: REJECTED`) và nhận xét từ ChatGPT Mentor.
3. `.agents/state/ROADMAP.md` — Xem danh sách các task tổng thể của dự án.
4. `.agents/state/SESSION_MAP.json` & `.agents/state/STATE_LOCK.json` (nếu có) — Kiểm tra ánh xạ luồng chat theo từng Task và khóa mã băm SHA-256 (`planHash`, `codeDiffHash`).

## 2. Quy tắc Chọn Model, Xoay vòng Luồng Chat (Per-Task Thread Rotation) & Quy trình RPIR

### 2.1. Quy tắc Chọn Model & Mức Suy luận trong `.agents/state/ROADMAP.md`
- Mỗi task trong `.agents/state/ROADMAP.md` có thể gắn thẻ cấu hình điều phối:
  - `[WORKER_MODEL: pro/flash]` (ví dụ `pro` cho task kiến trúc phức tạp, `flash` cho task đơn giản/kiểm thử): Model khuyến nghị cho Worker Agent (Claude / Antigravity / Gemini) khi thực thi task.
  - ChatGPT Mentor mặc định được gọi trực tiếp qua `node .agents/scripts/ask_mentor.mjs --task <task_id>` (không truyền `--model gpt-4o` để tránh làm nhiễu ngữ cảnh), hỗ trợ 3 chế độ `--mode <plan|review-code|rescue>` (mặc định là `plan`), và tự động kích hoạt mức độ suy luận phù hợp trước khi gửi prompt.

### 2.2. Tự động Đồng bộ Project & Xoay vòng Luồng Chat theo Task (`SESSION_MAP.json` & `--task <task_id>`)
- **Tự động nhận diện & khởi tạo Project trên ChatGPT theo tên dự án Antigravity**:
  - Khi `"projectName"` trong `.agents/config.json` để trống (`""`), hệ thống tự động lấy **chính xác tên thư mục gốc của Workspace trong Antigravity** làm tên Project mục tiêu.
  - Khi gọi `ask_mentor.mjs` (hoặc `npm run init-workflow` / `npm run ensure-project`), script tự kiểm tra danh sách Dự án trên sidebar ChatGPT: nếu đã có thì mở vào đúng Project đó (`/g/g-p-.../project`); nếu **chưa có thì tự động bấm "Thêm dự án mới", điền đúng tên dự án Antigravity và tạo Project mới ngay lập tức**, sau đó khóa URL vào `.agents/state/SESSION_MAP.json`.
  - **2 Chế độ khung chat trong ChatGPT Project (`chatgptComposerMode` / `--composer <chat|work>`)**: Mặc định dùng `chat` (*Trò chuyện* — không chọn model, 3 cấp suy luận `Tức thì`/`Vừa`/`Cao`, hỗ trợ đầy đủ `@Plugin`); khi cần chọn model (`"chatgptModel"` / `--model`) hoặc truyền `--composer work`, script chuyển sang `work` (*Công việc* — hiện danh sách model ngay khung chat, hỗ trợ `@Plugin` và 5 nấc suy luận).
- Hệ thống quản lý luồng chat riêng biệt cho từng Task trong `.agents/state/SESSION_MAP.json`:
  - Khi gọi `ask_mentor.mjs`, truyền tham số `--task <task_id>` (ví dụ: `--task task-3`). Nếu không truyền `--task`, script sẽ tự động trích xuất mã Task hiện tại từ tiêu đề `.agents/state/CURRENT_PLAN.md` hoặc mục chưa hoàn thành `[ ]` đầu tiên trong `.agents/state/ROADMAP.md`.
  - **Tiếp tục luồng hiện có**: Nếu `task_id` đã có URL trong `.agents/state/SESSION_MAP.json` (và không truyền `--new-thread`), script tự động điều hướng tab ChatGPT tới đúng URL đó để giữ nguyên mạch review của Task hiện tại.
  - **Khởi tạo luồng mới cho Task mới**: Nếu `task_id` chưa có URL trong `.agents/state/SESSION_MAP.json` (hoặc có cờ `--new-thread`), script tự động coi `isNewThread = true`, mở phiên trò chuyện mới bên trong Project, tự động ghép khối `--- NGỮ CẢNH BÀN GIAO DỰ ÁN (BOOTSTRAP) ---` vào đầu prompt lượt đầu tiên, và lưu URL `/c/...` mới vào `.agents/state/SESSION_MAP.json`.

### 2.3. Quy trình RPIR Tự động hóa & Cơ chế Circuit Breaker
Mọi Agent phải tuân thủ nghiêm ngặt quy trình RPIR khép kín được định nghĩa chi tiết trong `.agents/skills/mentor-rpi/SKILL.md`:
1. **Context Loading**: Đọc `.agents/state/HANDOFF.md`, `.agents/state/MENTOR_FEEDBACK.md` và `.agents/state/ROADMAP.md`.
2. **Research**: Phân tích yêu cầu của task hiện tại trong `.agents/state/ROADMAP.md` và khảo sát codebase.
3. **Plan & Auto-Mentor Review (`--mode plan`)**: Lập kế hoạch thiết kế chi tiết vào `.agents/state/CURRENT_PLAN.md`, đặt `.agents/state/MENTOR_FEEDBACK.md` ở trạng thái `STATUS: PENDING` và cập nhật `HANDOFF.md`. Sau khi viết xong `CURRENT_PLAN.md`, Agent **tự động gọi lệnh**:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode plan --task <task_id> --role <role_key>
   ```
   - Nếu kết quả trả về có **`STATUS: APPROVED`**: Script tự động khóa mã băm `planHash` vào `.agents/state/STATE_LOCK.json`. Agent **tự động chuyển ngay sang bước 4 (Implement) trong cùng phiên chạy**.
   - Nếu kết quả trả về có **`STATUS: REJECTED`**: Phân tích kỹ nhận xét trong `.agents/state/MENTOR_FEEDBACK.md`, cập nhật lại `.agents/state/CURRENT_PLAN.md` và gọi lại `node .agents/scripts/ask_mentor.mjs --mode plan --task <task_id> --role <role_key>`.
4. **Implement**: Chỉ thực thi viết/sửa code trong `src/` sau khi `.agents/state/MENTOR_FEEDBACK.md` có `STATUS: APPROVED` và mã băm của `CURRENT_PLAN.md` khớp với `planHash` trong `STATE_LOCK.json`:
   - **Quy tắc Circuit Breaker (`--mode rescue`)**: Nếu chạy test hoặc sửa lỗi thất bại quá **3 lần liên tiếp** ở bước Implement, Agent phải **dừng ngay việc tự thử nghiệm** và gọi lệnh:
     ```bash
     node .agents/scripts/ask_mentor.mjs --mode rescue --task <task_id> --error "<tóm tắt lỗi>"
     ```
5. **Review Code (`--mode review-code`)**: Sau khi Implement và chạy pass toàn bộ test, Agent **BẮT BUỘC** phải chạy lệnh:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode review-code --task <task_id>
   ```
   - Chỉ khi test pass (`exitCode === 0`) và nhận được **`CODE_STATUS: APPROVED`** trong `.agents/state/CODE_REVIEW_FEEDBACK.md` (kèm khóa `codeDiffHash` vào `.agents/state/STATE_LOCK.json`), Agent mới được phép đánh dấu hoàn thành `[x]` cho Task trong `.agents/state/ROADMAP.md`, commit code và đặt lại `.agents/state/MENTOR_FEEDBACK.md` về `STATUS: PENDING` cho task tiếp theo.
6. **Handoff**: Cập nhật `.agents/state/HANDOFF.md` trước khi kết thúc phiên.

### 2.4. Định tuyến Chuyên gia (Specialist Role Routing — `.agents/roles.json` & `--role`)
Hệ thống tích hợp danh bạ 9 Chuyên gia trong `.agents/roles.json` (`strategy`, `architect`, `backend`, `frontend`, `workflow`, `qa`, `devops`, `creative`, `motion`). Khi gọi `ask_mentor.mjs`, Worker có thể truyền `--role <role_key>` (1 hoặc kết hợp tối đa 2 vai trò cách nhau dấu phẩy):
- **Mặc định thông minh khi không truyền `--role`**:
  - `--mode plan` -> mặc định dùng `architect` (*Software System Architect*).
  - `--mode review-code` -> mặc định dùng `qa` (*Independent QA & Gate Reviewer*).
  - `--mode rescue` -> mặc định dùng `architect,workflow`.

## 3. Quy tắc Khóa An toàn & Bảo vệ Công cụ (Safety Gate & Tool Protection)
- **Bảo vệ bộ công cụ điều phối**: *"Khi thực hiện các Task trong `ROADMAP.md`, Worker chỉ làm việc trên `src/`, `tests/` và `.agents/state/`. TUYỆT ĐỐI KHÔNG tự ý chỉnh sửa các script trong `.agents/scripts/`."*
- **Giới hạn phạm vi & Chính sách Review v2 (`ask_mentor.mjs` & `review_policy.mjs`)**:
  - Ở chế độ `--mode review-code`, chỉ gửi kết quả chạy `npm test` + `git diff HEAD -- src/ tests/` (kèm danh sách/nội dung file mới trong `src/`, `tests/`). Tuyệt đối KHÔNG gửi kèm code của `.agents/` vào gói review.
  - **Ngân sách vòng theo giai đoạn (`stageRounds` trong `SESSION_MAP.json`)**: Bộ đếm vòng gắn với từng giai đoạn (`task-N-plan`, `task-N-review`, `task-N-rescue`), **KHÔNG bị reset khi truyền `--new-thread`**. Giới hạn mặc định: ChatGPT `plan = 3, review-code = 2, rescue = 2`; Gemini `plan = 2, review-code = 2, rescue = 2`.
  - **Severity Gate (P0-only Blocking)**: Chỉ lỗi `P0` mới được phép `REJECTED`; góp ý `P1/P2` tự động lưu vào `.agents/state/TECH_DEBT.md` và vẫn `APPROVED`.
  - **Quy tắc Hội tụ & Delta Review**: Từ vòng 2 chỉ kiểm tra các P0 đang mở (`REVIEW_LEDGER.json`) + lỗi `[NEW-P0-xx]`; khi tiếp tục cùng luồng ở pha `plan`, chỉ gửi phần unified diff thay đổi của `CURRENT_PLAN.md`.
  - **Chính sách 2 Mentor (`dualMentorPolicy: "chatgpt-gate"`)**: ChatGPT giữ quyền quyết định cuối; Gemini vẫn bắt buộc đóng góp ý kiến khi `--provider both`.
  - **Escalation (Exit Code `3`)**: Khi dùng hết số vòng mà vẫn `REJECTED`, script tự động ghi khối `## ⚠️ ESCALATION` vào `.agents/state/HANDOFF.md` và thoát với `exitCode = 3`. **Agent BẮT BUỘC phải dừng lại báo người dùng**, tuyệt đối KHÔNG tự gọi `--reset-rounds` hay `--new-thread`.
- **Khóa trước khi sửa code (`--check-plan`)**: Hook `.agents/scripts/check_plan_approved.sh` tự động gọi `node .agents/scripts/verify_guard.mjs --check-plan` trước mọi thao tác ghi/sửa vào `src/`.
- **Khóa trước khi Git Commit (`--pre-commit`)**: Hook `.agents/hooks/pre-commit` tự động gọi `node .agents/scripts/verify_guard.mjs --pre-commit`. Khi commit có thay đổi trong `src/` hoặc `tests/`, bắt buộc `.agents/state/CODE_REVIEW_FEEDBACK.md` có `CODE_STATUS: APPROVED`, khớp `codeDiffHash` và `npm test` đạt `exitCode === 0`.

## 4. Kết thúc Phiên & Bàn giao (Mandatory Handoff)
- Trước khi dừng hoặc kết thúc phiên làm việc (hoặc khi hết hạn mức/chuyển đổi tài khoản), Agent **LUÔN LUÔN** phải cập nhật đầy đủ trạng thái hiện tại, những việc đã làm, và bước tiếp theo vào `.agents/state/HANDOFF.md`.

## 5. Điều khiển Từ xa Thời gian thực qua Telegram & Reactive Wakeup Bridge (v3.0)
Khi trong `.env` đã cấu hình `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID`, Agent hỗ trợ cơ chế điều khiển 2 chiều tức thì (< 0.5s) từ điện thoại:
- Chạy nền `node .agents/scripts/telegram_daemon.mjs --no-banner` và `node .agents/scripts/wakeup_watcher.mjs`.
- Khi người dùng gửi tin nhắn chữ hoặc Voice (`.ogg` lưu tại `.agents/state/media/`) trên Telegram, `wakeup_watcher.mjs` tự thoát (`exit 0`) để đánh thức Agent thực thi yêu cầu và trả lời qua `node .agents/scripts/send_reply.mjs "<phản hồi>"`.
