# AI_WORK-FLOW — Multi-Account Antigravity + ChatGPT Mentor Starter Template

Bộ khung khởi tạo (**Starter Template**) tự động hóa quy trình phát triển phần mềm **RPIR (Research → Plan → Implement → Review Code)** kết hợp giữa **Worker Agent** (Antigravity / Gemini / Claude) và **ChatGPT Mentor (9 Specialist Roles)** qua giao thức Chrome DevTools Protocol (CDP).

---

## 1. Kiến trúc & Tính năng Cốt lõi

- **Tự động hóa RPIR khép kín**:
  - **Design Gate (`--mode plan`)**: Gửi `.agents/state/CURRENT_PLAN.md` cho ChatGPT Mentor duyệt trước khi cho phép sửa code trong `src/`.
  - **Implementation Gate (`--mode review-code`)**: Chỉ gửi kết quả chạy `npm test` + `git diff HEAD -- src/ tests/` (kèm danh sách/nội dung file mới trong `src/`, `tests/`). Tuyệt đối không gửi kèm code hạ tầng `.agents/`.
  - **Circuit Breaker (`--mode rescue`)**: Tự động gửi lỗi và diff cho Mentor gỡ bế tắc khi thử nghiệm thất bại quá 3 lần liên tiếp.
- **Định tuyến 9 Chuyên gia (`Specialist Role Routing` — `.agents/roles.json` & `--role`)**:
  - Hỗ trợ truyền `--role <role_key>` (1 hoặc kết hợp 2 vai trò cách nhau dấu phẩy, ví dụ `--role architect,backend`).
  - Mặc định thông minh: `--mode plan` -> `architect`; `--mode review-code` -> `qa`; `--mode rescue` -> `architect,workflow`.
  - Hỗ trợ tự động gắn Role Header vào đầu Prompt và tùy chọn `@mention` Custom GPT (`"useGptMention": true` trong `.agents/config.json`).
- **Quản lý Luồng Chat theo Project & Giai đoạn (`SESSION_MAP.json`)**:
  - Tự động điều hướng vào thư mục Dự án trên ChatGPT (mặc định `AI-WORKSPACE`).
  - Xoay vòng luồng chat độc lập cho từng Task và từng giai đoạn (`task-1-plan`, `task-1-review`, `task-1-rescue`).
  - Giới hạn cứng tối đa **2 vòng review** (`maxReviewRounds: 2`) cho mỗi giai đoạn.
- **Tự động gạt Mức Suy luận (`setThinkingEffort` & `--effort <high|standard>`)**:
  - Tự động chọn mức `high` ("Cao") cho `--mode plan` và `--mode rescue`; tự động chọn mức `standard` ("Chuẩn" / "Trung bình" / "Standard") cho `--mode review-code` để tối ưu tốc độ phản hồi (có thể ghi đè qua `--effort <high|standard>`).
- **Bản đồ Khung Mã nguồn Tự động (`Repo Skeleton Map`)**:
  - Tự động quét `sourceDirs`, trích xuất chữ ký `function`, `class`, `export`, `interface`, `type`, `def`, `public function` (tối đa 150 dòng) và đính kèm khối `--- REPO SKELETON MAP ---` vào `BOOTSTRAP` khi khởi tạo luồng chat mới.
- **Checkpoint Cứu hộ Quota (`checkpoint.mjs` & `npm run checkpoint`)**:
  - Tự động chụp nhanh thời gian, `taskId` đang mở, `git status --short`, `git diff --stat`, và kết quả chạy test (`PASS/FAIL`, `exitCode`) vào mục `## Snapshot Cứu Hộ Quota (Auto-Checkpoint)` trong `.agents/state/HANDOFF.md` để tài khoản kế tiếp tiếp quản ngay lập tức.
- **Bộ khóa an toàn gọn nhẹ (`verify_guard.mjs` < 80 dòng & `.agents/hooks/pre-commit`)**:
  - Chặn sửa code trong `src/` khi `MENTOR_FEEDBACK.md` chưa có `STATUS: APPROVED`.
  - Chặn `git commit` chạm vào `src/` hoặc `tests/` nếu `CODE_REVIEW_FEEDBACK.md` chưa có `CODE_STATUS: APPROVED` hoặc `npm test` thất bại (`exitCode !== 0`).

---

## 2. Danh bạ 9 Chuyên gia (`.agents/roles.json`)

| Mã `--role` | Tên Chuyên gia / Custom GPT | Chuyên môn cốt lõi |
| :--- | :--- | :--- |
| `strategy` | **Product Strategy & Scope Lead** | Phân tích phạm vi, chia nhỏ ROADMAP, chống scope creep |
| `architect` | **Software System Architect** | Thiết kế kiến trúc hệ thống, data flow, module contracts |
| `backend` | **Backend & Distributed Systems Engineer** | API, DB, bất đồng bộ, hiệu năng, fault-tolerance |
| `frontend` | **Frontend Product Engineer** | UI components, state management, responsive, accessibility |
| `workflow` | **AI Workflow & Prompt Engineer** | Tối ưu điều phối multi-agent, prompt, context engineering |
| `qa` | **Independent QA & Gate Reviewer** | Kiểm định chéo git diff, test coverage, nghiệm thu Gate |
| `devops` | **DevOps, Reliability & Cost Engineer** | CI/CD, bảo mật, cấu hình môi trường, tối ưu chi phí |
| `creative` | **Creative Director & Experience Designer** | Định hướng thẩm mỹ, UX flow, micro-interactions |
| `motion` | **Creative Motion & WebGL Engineer** | Animation, 3D/WebGL, shaders, tối ưu FPS/GPU |

---

## 3. Hướng dẫn Sử dụng làm Template cho Dự án Mới

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

## 4. Các Lệnh Điều phối RPIR Thường Dùng

1. **Gửi Kế hoạch Thiết kế (`CURRENT_PLAN.md`) kèm định tuyến Chuyên gia phù hợp**:
   ```bash
   # Task API / Backend:
   node .agents/scripts/ask_mentor.mjs --mode plan --task task-1 --role architect,backend

   # Task Giao diện UI/UX:
   node .agents/scripts/ask_mentor.mjs --mode plan --task task-2 --role creative,frontend

   # Task 3D / Animation:
   node .agents/scripts/ask_mentor.mjs --mode plan --task task-3 --role motion
   ```
2. **Gửi Review Code sau khi Implement và chạy pass `npm test`** (mặc định định tuyến tới `qa`):
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode review-code --task task-1
   ```
3. **Kích hoạt Circuit Breaker khi gặp lỗi quá 3 lần liên tiếp** (mặc định định tuyến tới `architect,workflow`):
   ```bash
   node .agents/scripts/ask_mentor.mjs --mode rescue --task task-1 --error "Tóm tắt lỗi"
   ```
4. **Lưu Snapshot Cứu hộ Quota trước khi đổi tài khoản (`checkpoint.mjs`)**:
   ```bash
   node .agents/scripts/checkpoint.mjs --note "Đang làm dở phần xử lý lỗi"
   # hoặc:
   npm run checkpoint -- --note "Đang làm dở phần xử lý lỗi"
   ```
5. **Kiểm tra thủ công Guard**:
   ```bash
   node .agents/scripts/verify_guard.mjs --check-plan
   node .agents/scripts/verify_guard.mjs --pre-commit
   ```

---

## 5. Tùy chỉnh Cấu hình (`.agents/config.json`)

File `.agents/config.json` cho phép cấu hình nhanh thông số dự án:
```json
{
  "projectName": "AI-WORKSPACE",
  "cdpUrl": "http://127.0.0.1:9222",
  "sourceDirs": ["src", "tests"],
  "testCommand": "npm test",
  "maxReviewRounds": 2,
  "useGptMention": false
}
```