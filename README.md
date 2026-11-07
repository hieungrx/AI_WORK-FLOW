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
  - **Tự động nhận diện & tạo Project trên ChatGPT trùng tên dự án Antigravity**: Mặc định lấy đúng tên thư mục gốc của Workspace trong Antigravity. Nếu trên ChatGPT chưa có Project đó, hệ thống **tự động bấm "Thêm dự án mới", điền tên dự án và khởi tạo Project** ngay khi chạy `npm run init-workflow` hoặc lần gọi `ask_mentor.mjs` đầu tiên!
  - Xoay vòng luồng chat độc lập cho từng Task và từng giai đoạn (`task-1-plan`, `task-1-review`, `task-1-rescue`).
  - **Review Policy v2 (`review_policy.mjs`)**:
    - Bộ đếm vòng theo giai đoạn (`stageRounds`), không bị reset bởi `--new-thread` (`chatgpt`: `plan=3, review-code=2, rescue=2`; `gemini`: `plan=2, review-code=2, rescue=2`).
    - **Severity Gate**: chỉ lỗi `P0` mới chặn (`REJECTED`); góp ý `P1/P2` tự động vào `.agents/state/TECH_DEBT.md`.
    - **Convergence & Delta Review**: từ vòng 2 chỉ kiểm tra P0 đang mở (`REVIEW_LEDGER.json`) + `NEW-P0`, và chỉ gửi unified diff của `CURRENT_PLAN.md` khi tiếp tục cùng luồng.
    - **Dual-Mentor (`dualMentorPolicy: "chatgpt-gate"`)**: ChatGPT quyết định, Gemini góp ý (khi `--provider both`, Gemini chạy trước để đưa ý kiến thứ hai vào prompt ChatGPT).
    - **Escalation (`exitCode = 3`)**: hết số vòng sẽ ghi mục `## ⚠️ ESCALATION` vào `HANDOFF.md` và dừng chờ người quyết định. Hỗ trợ `--dry-run` để kiểm tra quyết định mà không chạm Chrome.
- **"Thư mục Project" riêng cho Gemini (`SESSION_MAP.json` -> `geminiThreads`)**:
  - Gemini Web không có Project, nên mỗi Task & giai đoạn (`task-4-plan`, `task-4-review`, `task-5-plan`, ...) được lưu một URL hội thoại Gemini riêng — cùng giai đoạn thì mở lại đúng link cũ, sang Task/giai đoạn mới (hoặc `--new-thread`) thì mở đoạn chat Gemini mới tinh, tránh trôi ngữ cảnh và nặng tab.
  - Lượt đầu của mỗi luồng Gemini mới tự động được bơm `BOOTSTRAP` gồm `ROADMAP.md` + `HANDOFF.md` + `REPO SKELETON MAP` + `CURRENT_PLAN.md`.
  - Nếu cấu hình `"geminiGemUrl"` (link Gem, ví dụ Gem `AI-WORKSPACE Mentor`), mọi luồng mới sẽ được mở bên trong Gem đó thay vì trang chủ Gemini.
  - `geminiThreadUrl` (kiểu cũ) chỉ còn là con trỏ "luồng dùng gần nhất" và được tự động di trú vào `geminiThreads["<currentTask>-plan"]`.
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

### Bước 1: Clone bộ khung sang thư mục dự án mới & mở trong Antigravity
```bash
git clone https://github.com/hieungrx/AI_WORK-FLOW.git Ten-Du-An-Moi
cd Ten-Du-An-Moi
npm install
```
*(Mở thư mục `Ten-Du-An-Moi` làm một Project/Workspace mới trong Antigravity).*

### Bước 2: Mở trình duyệt Chrome Debug (`start-system.bat`)
Chạy trực tiếp file `start-system.bat` (Windows) để tự mở 2 profile Chrome độc lập:
- **Cổng `9222`**: ChatGPT Mentor (`%USERPROFILE%\.chrome-mentor-profile`)
- **Cổng `9223`**: Google Gemini Mentor (`%USERPROFILE%\.chrome-gemini-profile`)

### Bước 3: Khởi tạo dự án mới (`npm run init-workflow`)
Chạy lệnh duy nhất dưới đây:
```bash
npm run init-workflow
```
Lệnh này sẽ tự động:
1. Lấy **chính xác tên thư mục dự án Antigravity** (`Ten-Du-An-Moi`) gán vào `.agents/config.json` và `package.json` *(có thể ghi đè tùy ý bằng `-- --name "Tên Khác"`)*.
2. Kích hoạt Git Pre-commit Hook (`.agents/hooks/pre-commit`) và đặt lại sạch sẽ `.agents/state/*`.
3. Kết nối tới Chrome cổng `9222`: nếu trên ChatGPT **chưa có Project `Ten-Du-An-Moi`**, hệ thống sẽ **tự động tạo luôn Project mới** và khóa link `/g/g-p-.../project` vào `.agents/state/SESSION_MAP.json`! *(Nếu lúc chạy chưa bật Chrome, hệ thống vẫn tự tạo Project ở ngay lần gọi `ask_mentor.mjs` đầu tiên).*

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

File `.agents/config.json` cho phép cấu hình nhanh thông số dự án (khi `"projectName": ""` để trống, hệ thống tự động lấy tên thư mục gốc của dự án trong Antigravity):
```json
{
  "projectName": "",
  "cdpUrl": "http://127.0.0.1:9222",
  "geminiCdpUrl": "http://127.0.0.1:9223",
  "geminiGemUrl": "",
  "sourceDirs": ["src", "tests"],
  "testCommand": "npm test",
  "maxReviewRounds": {
    "chatgpt": { "plan": 3, "review-code": 2, "rescue": 2 },
    "gemini": { "plan": 2, "review-code": 2, "rescue": 2 }
  },
  "dualMentorPolicy": "chatgpt-gate",
  "useGptMention": true
}
```

- `geminiGemUrl`: Dán link Gem của bạn (dạng `https://gemini.google.com/gem/<gemId>`). Tạo Gem tại **Gemini → Gems → Trình quản lý Gem → Gem mới**, đặt tên `AI-WORKSPACE Mentor` và dán quy tắc review kiến trúc vào ô **Hướng dẫn / Instructions**. Nếu lỡ dán link một cuộc trò chuyện trong Gem (`/gem/<gemId>/<chatId>`), script tự cắt về link gốc của Gem. Để trống `""` = dùng Gemini thường.
