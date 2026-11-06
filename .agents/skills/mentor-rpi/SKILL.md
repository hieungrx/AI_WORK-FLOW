---
name: mentor-rpi
description: >-
  Quy trình 5 bước Research - Plan - Implement (RPI) kết hợp cơ chế phê duyệt
  từ ChatGPT Mentor và bàn giao trạng thái (Handoff) cho hệ thống Multi-Account
  Antigravity + ChatGPT Mentor. Kích hoạt skill này cho mọi tác vụ phát triển
  phần mềm trong dự án.
---

# Quy trình Mentor-RPI (Research - Plan - Implement)

Mọi Agent làm việc trong dự án phải tuân thủ tuyệt đối quy trình 5 bước khép kín dưới đây để đảm bảo tính liên tục giữa nhiều tài khoản (Multi-Account) và sự kiểm soát chất lượng từ ChatGPT Mentor.

---

## Bước 1: Nạp ngữ cảnh & Xác định Model (Context Loading & Model Selection)
Trước khi thực hiện bất kỳ thao tác phân tích hay lập trình nào, Agent **BẮT BUỘC** phải đọc các file bộ nhớ dùng chung theo thứ tự:
1. `.agents/state/HANDOFF.md` — Xác định trạng thái bàn giao từ phiên trước, task đang thực hiện và bước hiện tại trong chu trình RPI.
2. `.agents/state/MENTOR_FEEDBACK.md` — Kiểm tra trạng thái phê duyệt hiện tại (`STATUS: PENDING`, `STATUS: APPROVED`, hoặc `STATUS: REJECTED`) cùng các góp ý chi tiết của ChatGPT Mentor.
3. `.agents/state/ROADMAP.md` — Đối chiếu danh sách công việc tổng thể, tiến độ dự án và đọc thẻ cấu hình của từng Task:
   - `[WORKER_MODEL: <pro/flash>]`: Model khuyến nghị cho Worker Agent (Antigravity / Gemini / Claude) thực hiện task hiện tại.
   - Đối với ChatGPT Mentor: mặc định gọi trực tiếp `node .agents/scripts/ask_mentor.mjs` (không truyền `--model gpt-4o`), script sẽ tự động chuyển mức độ suy luận trên khung chat sang **Cao / High** (`ensureHighReasoning(page)`).

---

## Bước 2: Nghiên cứu (Research)
Khi bắt đầu một Task mới hoặc khi kế hoạch cần điều chỉnh (`STATUS: PENDING` hoặc `STATUS: REJECTED`):
1. Đọc kỹ yêu cầu của Task mục tiêu trong `.agents/state/ROADMAP.md`.
2. Khảo sát cấu trúc thư mục, các file hiện có trong `src/`, các ràng buộc kỹ thuật và các trường hợp biên (edge cases).
3. Nếu có phản hồi từ Mentor trong `.agents/state/MENTOR_FEEDBACK.md`, phân tích kỹ các điểm cần sửa đổi.
4. **Lưu ý quan trọng**: Không tạo hoặc sửa bất kỳ file nào trong `src/` ở bước này.

---

## Bước 3: Lập kế hoạch & Tự động Xin Phê duyệt từ Mentor (Plan & Auto-Mentor Review)
1. Viết bản thiết kế kỹ thuật chi tiết cho Task hiện tại vào `.agents/state/CURRENT_PLAN.md`, bao gồm:
   - Mục tiêu và phạm vi của Task.
   - Cấu trúc dữ liệu, kiến trúc module và danh sách các hàm/API (kèm tham số, kiểu trả về, xử lý lỗi).
   - Luồng xử lý chính và các trường hợp biên (edge cases).
   - Cách thức kiểm chứng sau khi cài đặt.
2. Đảm bảo `.agents/state/MENTOR_FEEDBACK.md` đang ở trạng thái `STATUS: PENDING` (nếu vừa sửa lại kế hoạch sau khi bị `REJECTED`, đặt lại về `STATUS: PENDING`).
3. Cập nhật `.agents/state/HANDOFF.md` ghi rõ đã hoàn thành bước Research & Plan cho Task hiện tại.
4. **TỰ ĐỘNG GỌI CHATGPT MENTOR (KHÔNG DỪNG CHỜ COPY-PASTE)**:
   - Sau khi viết xong `CURRENT_PLAN.md`, Antigravity **KHÔNG** dừng lại chờ người dùng copy-paste nữa, mà phải **tự gọi lệnh**:
     ```bash
     node .agents/scripts/ask_mentor.mjs
     ```
     (không truyền `--model gpt-4o` để không làm nhiễu ngữ cảnh của Mentor).
   - Script `ask_mentor.mjs` sẽ kết nối tới trình duyệt Chrome qua CDP (`http://localhost:9222`), tự động đảm bảo mức độ suy luận ở mức **Cao / High** (`ensureHighReasoning(page)`), gửi nội dung `CURRENT_PLAN.md` cho ChatGPT Mentor, đợi phản hồi hoàn tất, ghi đè vào `.agents/state/MENTOR_FEEDBACK.md` và in ra trạng thái `APPROVED` hoặc `REJECTED`.
   - **Nếu kết quả trả về có `STATUS: APPROVED`**: Tự động chuyển sang **Bước 4 (Implement)** ngay trong cùng phiên chạy.
   - **Nếu kết quả trả về có `STATUS: REJECTED`**: Phân tích kỹ nhận xét trong `.agents/state/MENTOR_FEEDBACK.md`, chỉnh sửa `.agents/state/CURRENT_PLAN.md` và gọi lại `node .agents/scripts/ask_mentor.mjs`. Tuyệt đối không viết code vào `src/` khi chưa có `STATUS: APPROVED` trong `.agents/state/MENTOR_FEEDBACK.md`.

---

## Bước 4: Triển khai (Implement)
Chỉ thực hiện bước này khi đọc `.agents/state/MENTOR_FEEDBACK.md` thấy có dòng chữ **`STATUS: APPROVED`**:
1. Đọc lại `.agents/state/CURRENT_PLAN.md` và các ghi chú bổ sung (nếu có) trong `.agents/state/MENTOR_FEEDBACK.md`.
2. Tiến hành viết hoặc chỉnh sửa code trong thư mục `src/` theo đúng thiết kế đã được duyệt (lúc này hook `.agents/scripts/check_plan_approved.sh` sẽ cho phép thao tác).
3. Chạy kiểm thử / xác minh hoạt động của code vừa triển khai.
4. **Quy tắc Circuit Breaker (`--mode rescue`)**:
   - Nếu chạy test hoặc sửa lỗi thất bại quá **3 lần liên tiếp** ở bước Implement, Agent phải **dừng ngay việc tự thử nghiệm** và gọi lệnh:
     ```bash
     node .agents/scripts/ask_mentor.mjs --mode rescue --error "<tóm tắt lỗi>"
     ```
   - Đọc hướng dẫn gỡ bế tắc của ChatGPT Mentor được ghi vào `.agents/state/MENTOR_FEEDBACK.md` trước khi thực hiện bước tiếp theo.

---

## Bước 5: Kiểm tra Chéo Mã nguồn (Review Code — `--mode review-code`)
Sau khi Implement và chạy pass toàn bộ test, Agent **BẮT BUỘC** phải thực hiện bước Review Code với ChatGPT Mentor:
1. Gọi lệnh tự động:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode review-code
   ```
   (Script sẽ tự động thu thập `git status --short`, `git diff` / snapshot code kết hợp với `.agents/state/CURRENT_PLAN.md` để gửi cho ChatGPT Mentor đối chiếu và ghi kết quả vào `.agents/state/CODE_REVIEW_FEEDBACK.md`).
2. Kiểm tra dòng đầu tiên trong `.agents/state/CODE_REVIEW_FEEDBACK.md`:
   - **Nếu có `CODE_STATUS: APPROVED`**:
     - Đánh dấu hoàn thành `[x]` cho Task đó trong `.agents/state/ROADMAP.md`.
     - Đặt lại `.agents/state/MENTOR_FEEDBACK.md` về `STATUS: PENDING` để khóa an toàn trước khi chuyển sang Task tiếp theo.
   - **Nếu có `CODE_STATUS: REJECTED`**:
     - Đọc kỹ các điểm cần khắc phục trong `.agents/state/CODE_REVIEW_FEEDBACK.md`, chỉnh sửa code, chạy lại toàn bộ test cho tới khi pass, và gọi lại `node .agents/scripts/ask_mentor.mjs --mode review-code`.

---

## Bước 6: Cập nhật Bàn giao (Update Handoff)
Trước khi dừng phiên làm việc (do chờ Mentor duyệt, hoàn thành Task, hoặc chuyển đổi tài khoản):
1. Cập nhật đầy đủ vào `.agents/state/HANDOFF.md` các thông tin:
   - Task vừa thực hiện / đang thực hiện.
   - Bước hiện tại trong quy trình RPIR (`Research & Plan`, `Waiting for Mentor Approval`, `Implementing`, `Code Review`, hoặc `Implemented & Verified`).
   - Tóm tắt những thay đổi đã thực hiện.
   - Hướng dẫn rõ ràng hành động tiếp theo cho Agent/phiên kế tiếp.
