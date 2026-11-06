# Quy tắc Điều phối Multi-Account Antigravity + ChatGPT Mentor (CLAUDE.md)

Tài liệu này quy định quy trình làm việc bắt buộc cho mọi AI Agent (Claude / Antigravity / Gemini) tham gia dự án.

## 1. Khởi đầu Phiên làm việc (Mandatory Session Start)
Ngay khi bắt đầu bất kỳ phiên làm việc nào, Agent **BẮT BUỘC** phải đọc các file trạng thái theo thứ tự sau trước khi thực hiện bất kỳ hành động nào khác:
1. `.agents/state/HANDOFF.md` — Nắm bắt ngữ cảnh, tiến độ hiện tại và công việc bàn giao từ phiên trước.
2. `.agents/state/MENTOR_FEEDBACK.md` — Kiểm tra trạng thái phê duyệt (`STATUS: PENDING`, `STATUS: APPROVED`, hoặc `STATUS: REJECTED`) và nhận xét từ ChatGPT Mentor.
3. `.agents/state/ROADMAP.md` — Xem danh sách các task tổng thể của dự án.

## 2. Quy tắc Chọn Model & Tuân thủ Quy trình RPIR (Research - Plan - Implement - Review Code)

### 2.1. Quy tắc Chọn Model & Mức Suy luận trong `.agents/state/ROADMAP.md`
- Mỗi task trong `.agents/state/ROADMAP.md` có thể gắn thẻ cấu hình điều phối:
  - `[WORKER_MODEL: pro/flash]` (ví dụ `pro` cho task kiến trúc phức tạp, `flash` cho task đơn giản/kiểm thử): Model khuyến nghị cho Worker Agent (Claude / Antigravity / Gemini) khi thực thi task.
  - ChatGPT Mentor mặc định được gọi trực tiếp qua `node .agents/scripts/ask_mentor.mjs` (không truyền `--model gpt-4o` để tránh làm nhiễu ngữ cảnh), hỗ trợ 3 chế độ `--mode <plan|review-code|rescue>` (mặc định là `plan`), và tự động kích hoạt mức độ suy luận **Cao / High** (`ensureHighReasoning(page)`) trước khi gửi prompt.

### 2.2. Quy trình RPIR Tự động hóa & Cơ chế Circuit Breaker
Mọi Agent phải tuân thủ nghiêm ngặt quy trình RPIR khép kín được định nghĩa chi tiết trong `.agents/skills/mentor-rpi/SKILL.md`:
1. **Context Loading**: Đọc `.agents/state/HANDOFF.md`, `.agents/state/MENTOR_FEEDBACK.md` và `.agents/state/ROADMAP.md`.
2. **Research**: Phân tích yêu cầu của task hiện tại trong `.agents/state/ROADMAP.md` và khảo sát codebase.
3. **Plan & Auto-Mentor Review (`--mode plan`)**: Lập kế hoạch thiết kế chi tiết vào `.agents/state/CURRENT_PLAN.md`, đặt `.agents/state/MENTOR_FEEDBACK.md` ở trạng thái `STATUS: PENDING` và cập nhật `HANDOFF.md`. Sau khi viết xong `CURRENT_PLAN.md`, Agent **KHÔNG dừng lại chờ người dùng copy-paste thủ công nữa**, mà phải **tự động gọi lệnh**:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode plan
   ```
   (hoặc `node .agents/scripts/ask_mentor.mjs`, không truyền `--model gpt-4o`) để tự động chuyển mức suy luận lên **Cao / High**, gửi kế hoạch và nhận phản hồi trực tiếp từ ChatGPT Mentor vào `.agents/state/MENTOR_FEEDBACK.md`:
   - Nếu kết quả trả về có **`STATUS: APPROVED`**: **Tự động chuyển ngay sang bước 4 (Implement) trong cùng phiên chạy**.
   - Nếu kết quả trả về có **`STATUS: REJECTED`**: Phân tích kỹ nhận xét trong `.agents/state/MENTOR_FEEDBACK.md`, cập nhật lại `.agents/state/CURRENT_PLAN.md` và gọi lại `node .agents/scripts/ask_mentor.mjs --mode plan`.
4. **Implement**: Chỉ thực thi viết/sửa code trong `src/` sau khi `.agents/state/MENTOR_FEEDBACK.md` có `STATUS: APPROVED`:
   - **Quy tắc Circuit Breaker (`--mode rescue`)**: Nếu chạy test hoặc sửa lỗi thất bại quá **3 lần liên tiếp** ở bước Implement, Agent phải **dừng ngay việc tự thử nghiệm** và gọi lệnh:
     ```bash
     node .agents/scripts/ask_mentor.mjs --mode rescue --error "<tóm tắt lỗi>"
     ```
     để gửi `CURRENT_PLAN.md` kèm `git diff` hiện tại và thông tin lỗi cho ChatGPT Mentor phân tích, nhận hướng dẫn gỡ bế tắc trong `.agents/state/MENTOR_FEEDBACK.md`.
5. **Review Code (`--mode review-code`)**: Sau khi Implement và chạy pass toàn bộ test, Agent **BẮT BUỘC** phải chạy lệnh:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode review-code
   ```
   để gửi `git status --short`, `git diff` và `CURRENT_PLAN.md` cho ChatGPT Mentor kiểm tra chéo code thực tế so với bản thiết kế:
   - Chỉ khi nhận được **`CODE_STATUS: APPROVED`** trong `.agents/state/CODE_REVIEW_FEEDBACK.md`, Agent mới được phép đánh dấu hoàn thành `[x]` cho Task trong `.agents/state/ROADMAP.md` và đặt lại `.agents/state/MENTOR_FEEDBACK.md` về `STATUS: PENDING` cho task tiếp theo.
   - Nếu nhận được **`CODE_STATUS: REJECTED`**, Agent phải sửa code theo phản hồi trong `.agents/state/CODE_REVIEW_FEEDBACK.md`, chạy lại test và gọi lại `--mode review-code`.
6. **Handoff**: Cập nhật `.agents/state/HANDOFF.md` trước khi kết thúc phiên.

## 3. Quy tắc Khóa An toàn (Safety Gate)
- **TUYỆT ĐỐI KHÔNG** tạo mới, chỉnh sửa hoặc xóa bất kỳ file nào trong thư mục `src/` khi file `.agents/state/MENTOR_FEEDBACK.md` chưa chứa dòng chữ `STATUS: APPROVED`.
- Hook bảo vệ `.agents/scripts/check_plan_approved.sh` (được cấu hình trong `.agents/hooks.json`) sẽ tự động chặn (`exit 2`) mọi thao tác ghi/sửa vào `src/` nếu kế hoạch chưa được phê duyệt.
- Nếu `MENTOR_FEEDBACK.md` đang là `STATUS: PENDING` hoặc `STATUS: REJECTED`, Agent chỉ được phép chỉnh sửa các file kế hoạch/trạng thái trong `.agents/state/`.

## 4. Kết thúc Phiên & Bàn giao (Mandatory Handoff)
- Trước khi dừng hoặc kết thúc phiên làm việc (hoặc khi hết hạn mức/chuyển đổi tài khoản), Agent **LUÔN LUÔN** phải cập nhật đầy đủ trạng thái hiện tại, những việc đã làm, và bước tiếp theo vào `.agents/state/HANDOFF.md`.
