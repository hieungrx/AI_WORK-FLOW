# AI_WORK-FLOW — Multi-Account Antigravity + ChatGPT Mentor Starter Template

Bộ khung khởi tạo (**Starter Template**) tự động hóa quy trình phát triển phần mềm **RPIR (Research → Plan → Implement → Review Code)** kết hợp giữa **Worker Agent** (Antigravity / Gemini / Claude) và **ChatGPT Mentor** qua giao thức Chrome DevTools Protocol (CDP).

---

## 1. Kiến trúc & Tính năng Cốt lõi

- **Tự động hóa RPIR khép kín**:
  - **Design Gate (`--mode plan`)**: Gửi `.agents/state/CURRENT_PLAN.md` cho ChatGPT Mentor duyệt trước khi cho phép sửa code trong `src/`.
  - **Implementation Gate (`--mode review-code`)**: Chỉ gửi kết quả chạy `npm test` + `git diff HEAD -- src/ tests/` (kèm danh sách/nội dung file mới trong `src/`, `tests/`). Tuyệt đối không gửi kèm code hạ tầng `.agents/`.
  - **Circuit Breaker (`--mode rescue`)**: Tự động gửi lỗi và diff cho Mentor gỡ bế tắc khi thử nghiệm thất bại quá 3 lần liên tiếp.
- **Quản lý Luồng Chat theo Project & Giai đoạn (`SESSION_MAP.json`)**:
  - Tự động điều hướng vào thư mục Dự án trên ChatGPT (mặc định `AI-WORKSPACE`).
  - Xoay vòng luồng chat độc lập cho từng Task và từng giai đoạn (`task-1-plan`, `task-1-review`, `task-1-rescue`).
  - Giới hạn cứng tối đa **2 vòng review** (`maxReviewRounds: 2`) cho mỗi giai đoạn.
- **Bộ khóa an toàn gọn nhẹ (`verify_guard.mjs` < 80 dòng & `.agents/hooks/pre-commit`)**:
  - Chặn sửa code trong `src/` khi `MENTOR_FEEDBACK.md` chưa có `STATUS: APPROVED`.
  - Chặn `git commit` chạm vào `src/` hoặc `tests/` nếu `CODE_REVIEW_FEEDBACK.md` chưa có `CODE_STATUS: APPROVED` hoặc `npm test` thất bại (`exitCode !== 0`).

---

## 2. Hướng dẫn Sử dụng làm Template cho Dự án Mới

### Bước 1: Clone repo & Cài đặt dependencies
```bash
git clone https://github.com/hieungrx/AI_WORK-FLOW.git my-new-project
cd my-new-project
npm install
```

### Bước 2: Khởi tạo dự án mới (`npm run init-workflow`)
Chạy lệnh dưới đây để cấu hình Git Pre-commit Hook (`.agents/hooks`), đặt tên Project trên ChatGPT, reset toàn bộ trạng thái trong `.agents/state/` và xóa các file demo Todo CLI:

```bash
npm run init-workflow -- --name "TEN_PROJECT_CHATGPT" --clean-demo
```
*(Nếu chỉ muốn reset trạng thái `.agents/state/` mà vẫn giữ lại code demo Todo CLI để tham khảo, bỏ cờ `--clean-demo`).*

### Bước 3: Mở trình duyệt Chrome với cổng Debug `9222`
Mở Chrome với Remote Debugging port `9222` và đăng nhập sẵn vào `https://chatgpt.com`:

- **Windows (PowerShell / CMD)**:
  ```powershell
  & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\User Data\AntigravityCDP"
  ```
- **macOS / Linux**:
  ```bash
  google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-antigravity-cdp"
  ```

---

## 3. Các Lệnh Điều phối RPIR Thường Dùng

1. **Gửi Kế hoạch Thiết kế (`CURRENT_PLAN.md`) cho ChatGPT Mentor duyệt**:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode plan --task task-1
   ```
2. **Gửi Review Code sau khi Implement và chạy pass `npm test`**:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode review-code --task task-1
   ```
3. **Kích hoạt Circuit Breaker khi gặp lỗi quá 3 lần liên tiếp**:
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode rescue --task task-1 --error "Tóm tắt lỗi"
   ```
4. **Kiểm tra thủ công Guard**:
   ```bash
   node .agents/scripts/verify_guard.mjs --check-plan
   node .agents/scripts/verify_guard.mjs --pre-commit
   ```

---

## 4. Tùy chỉnh Cấu hình (`.agents/config.json`)

File `.agents/config.json` cho phép cấu hình nhanh thông số dự án:
```json
{
  "projectName": "AI-WORKSPACE",
  "cdpUrl": "http://127.0.0.1:9222",
  "sourceDirs": ["src", "tests"],
  "testCommand": "npm test",
  "maxReviewRounds": 2
}
```