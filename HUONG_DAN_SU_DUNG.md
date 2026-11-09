# 📘 HƯỚNG DẪN CHI TIẾT SỬ DỤNG AI-WORKFLOW TEMPLATE (RPIR v2)

Tài liệu này hướng dẫn từng bước từ A → Z cách sử dụng bộ khung **AI-WorkFlow Template** để phát triển dự án phần mềm mới với sự phối hợp tự động giữa **Worker Agent** (Antigravity / Gemini / Claude) và **Hội đồng Mentor** (ChatGPT Project + 9 Chuyên gia `@Plugin` & Google Gemini).

---

## 🎯 1. Tổng quan: Hệ thống này làm việc như thế nào?

Hãy hình dung bạn là **Giám đốc Sản phẩm (Product Owner)**, còn hệ thống gồm 2 nhóm AI tự động phối hợp với nhau:

1. **👷 Worker Agent (Antigravity)**: Là lập trình viên trực tiếp đọc yêu cầu, khảo sát code, viết bản thiết kế kỹ thuật, viết code vào `src/` và viết unit test vào `tests/`.
2. **🧠 Hội đồng Mentor (ChatGPT & Gemini chạy trên Chrome thật)**: Là Kiến trúc sư trưởng & QA độc lập.
   - Worker **không được phép tự ý viết code ngay**, mà phải gửi bản thiết kế (`CURRENT_PLAN.md`) lên ChatGPT/Gemini duyệt trước (**Design Gate**).
   - Khi viết code và chạy pass `npm test` xong, Worker **không được phép tự ý commit**, mà phải gửi `git diff` + kết quả test lên Mentor kiểm định (**Implementation Gate**).
   - Nếu Worker sửa lỗi quá 3 lần không xong, hệ thống tự kích hoạt **Circuit Breaker (`--mode rescue`)** để hỏi Mentor cách gỡ bế tắc.

```
[Bạn giao yêu cầu]
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ Bước 1: RESEARCH & PLAN (Worker viết CURRENT_PLAN.md)    │
└──────────────────────────┬───────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Bước 2: DESIGN GATE (ask_mentor.mjs --mode plan)         │
│  ├─ ChatGPT Project (Chế độ Trò chuyện + @Plugin + Cao)  │
│  └─ Kết quả: STATUS: APPROVED (Khóa mã băm planSha256)   │
└──────────────────────────┬───────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Bước 3: IMPLEMENT & TEST (Worker code src/ & tests/)     │
│  └─ Nếu lỗi > 3 lần ──► Circuit Breaker (--mode rescue)  │
└──────────────────────────┬───────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Bước 4: CODE REVIEW GATE (ask_mentor.mjs --mode review)  │
│  ├─ Gửi kết quả npm test + git diff (src/, tests/)       │
│  └─ Kết quả: CODE_STATUS: APPROVED ──► Cho phép Commit   │
└──────────────────────────────────────────────────────────┘
```

---

## 🚀 2. Bắt đầu một Dự án Mới trong 3 Bước (Chỉ mất 2 phút)

### Bước 1: Copy hoặc Clone bộ khung sang thư mục dự án mới
Tên thư mục bạn đặt cũng chính là **tên Project sẽ tự động được tạo trên ChatGPT**!

```bash
# Cách 1: Clone từ Git (hoặc copy thư mục AI-WorkFlow sang tên mới)
git clone <link-repo-template-cua-ban> Ten-Du-An-Moi
cd Ten-Du-An-Moi

# Cài đặt thư viện kết nối trình duyệt (playwright-core)
npm install
```
Sau đó, mở thư mục `Ten-Du-An-Moi` bằng **Antigravity**.

---

### Bước 2: Bật trình duyệt Chrome Mentor (`start-system.bat`)
Click đúp vào file [`start-system.bat`](file:///e:/Desktop/AI-WorkFlow/start-system.bat) (hoặc chạy `.\start-system.bat` trong Terminal).
Script sẽ tự động mở 2 cửa sổ Chrome độc lập:
- **Cửa sổ 1 (Cổng `9222`)**: Mở `https://chatgpt.com/` — Hãy đăng nhập tài khoản ChatGPT của bạn (chỉ cần đăng nhập 1 lần đầu tiên, phiên đăng nhập được lưu vào `%USERPROFILE%\.chrome-mentor-profile`).
- **Cửa sổ 2 (Cổng `9223`)**: Mở `https://gemini.google.com/app` — Đăng nhập tài khoản Google Gemini (nếu bạn muốn dùng chế độ 2 Mentor `--provider both` hoặc `--provider gemini`).

> 💡 **Lưu ý**: Trong suốt quá trình làm việc, bạn chỉ cần để 2 cửa sổ Chrome này chạy nền (có thể thu nhỏ xuống thanh Taskbar, **không đóng hẳn**).

---

### Bước 3: Khởi tạo dự án (`npm run init-workflow`)
Tại Terminal của Antigravity, chạy lệnh:

```bash
npm run init-workflow
```

**Điều gì sẽ tự động diễn ra khi bạn gõ lệnh này?**
1. Hệ thống tự nhận diện **tên thư mục gốc trong Antigravity** (ví dụ `Ten-Du-An-Moi`).
2. Tự động kích hoạt khóa bảo vệ Git (`git config core.hooksPath .agents/hooks`).
3. Làm sạch toàn bộ file trạng thái trong `.agents/state/` về trạng thái khởi đầu chuẩn.
4. Tự động điều khiển Chrome (cổng `9222`) kiểm tra thanh bên trái của ChatGPT:
   - Nếu đã có Project trùng tên thư mục dự án → Mở thẳng vào Project đó.
   - Nếu **chưa có Project** → Tự động bấm **"Thêm dự án mới"**, điền đúng tên dự án và nhấn **"Tạo dự án"**, rồi lưu URL Project vào [`.agents/state/SESSION_MAP.json`](file:///e:/Desktop/AI-WorkFlow/.agents/state/SESSION_MAP.json).

*(Mẹo: Nếu bạn muốn đặt tên Project trên ChatGPT khác với tên thư mục máy tính, hãy chạy: `npm run init-workflow -- --name "Tên Dự Án Của Tôi"`).*

---

## 🧩 2B. Áp dụng Workflow vào Dự án ĐÃ CÓ SẴN (Checklist từng bước)

> Dùng mục này khi bạn đã có sẵn một dự án (có code, có `package.json`, có Git...) và muốn "cắm" workflow vào. **KHÔNG clone template đè lên dự án**, vì sẽ mất `package.json` và `README` gốc.

### Bước 0: Chốt một mốc Git sạch (bắt buộc)
Review code của workflow so sánh với `HEAD` (`git diff HEAD`), nên dự án **phải là Git repo và có ít nhất 1 commit**:
```bash
cd Du-An-Cua-Ban
git init            # chỉ khi dự án chưa có Git
git add -A
git commit -m "chore: moc truoc khi gan AI-WorkFlow"
```

### Bước 1: Copy đúng 3 thứ từ template sang thư mục gốc dự án
| Copy | Ghi chú |
| :--- | :--- |
| Thư mục `.agents/` (toàn bộ) | Bộ công cụ + trạng thái |
| `GEMINI.md` (và `CLAUDE.md` nếu dùng Claude) | Quy tắc mà Antigravity tự đọc mỗi phiên, **phải nằm ở thư mục gốc Workspace** |
| `start-system.bat` | Script bật Chrome có mở port |

❌ **Không copy:** `package.json`, `package-lock.json`, `README.md`, `src/`, `tests/`, `.git/`, `node_modules/`.

### Bước 2: Gộp `package.json` (không ghi đè)
```bash
npm init -y                      # chỉ khi dự án chưa có package.json (ví dụ dự án Python/PHP)
npm i -D playwright-core
```
Thêm các script sau vào mục `"scripts"` của `package.json` gốc, **giữ nguyên script `"test"` của dự án**:
```json
"ask-mentor": "node .agents/scripts/ask_mentor.mjs",
"ensure-project": "node .agents/scripts/ask_mentor.mjs --ensure-project",
"init-workflow": "node .agents/scripts/init_project.mjs",
"checkpoint": "node .agents/scripts/checkpoint.mjs"
```
> ⚠️ `init-workflow` sẽ **đổi trường `"name"`** trong `package.json` thành tên thư mục (viết thường). Nếu tên package quan trọng (ví dụ thư viện publish lên npm), hãy sửa lại sau khi init.

### Bước 3: Khai báo thư mục code & lệnh test thật trong `.agents/config.json`
```json
"sourceDirs": ["app", "lib", "tests"],
"testCommand": "npx vitest run"
```
- `sourceDirs`: các thư mục chứa code và test **thật** của dự án. Guard pre-commit, `git diff` gửi review và Repo Skeleton Map đều dựa vào đây.
- `testCommand`: lệnh test thật (ví dụ `npm test`, `npx jest`, `pytest -q`, `php artisan test`). Script review và pre-commit sẽ chạy lệnh này.

> [!WARNING]
> Hạn chế hiện tại: hook chặn sửa code trước khi Plan được duyệt (`check_plan_approved.sh`) **chỉ nhận diện thư mục `src/`**. Nếu code của bạn nằm ở thư mục khác thì hook này chưa bảo vệ được, và Agent phải tự giác tuân thủ `GEMINI.md`. Hạn chế này nằm trong kế hoạch nâng cấp `adopt-workflow`.

### Bước 4: "Khởi tạo port" = bật Chrome bằng `start-system.bat`
- Port 9222/9223 **chỉ tồn tại khi Chrome được mở bằng script này** (có cờ `--remote-debugging-port`). Mở Chrome bình thường thì **không có port**.
- **Mỗi lần khởi động lại máy** đều phải chạy lại `start-system.bat`.
- Lần đầu: đăng nhập ChatGPT ở cửa sổ 9222 và Gemini ở cửa sổ 9223.
- Kiểm tra nhanh: mở `http://127.0.0.1:9222/json/version` trên trình duyệt. Thấy chuỗi JSON nghĩa là port đã sẵn sàng.

### Bước 5: Khởi tạo & tự kiểm tra
```bash
npm run init-workflow                               # reset .agents/state, gắn git hook, tạo Project ChatGPT
npm run ensure-project                              # xác nhận đã kết nối ChatGPT Project
npm test                                            # lệnh test của dự án phải chạy được
node .agents/scripts/verify_guard.mjs --check-plan  # KỲ VỌNG: bị chặn (vì chưa có Plan duyệt) => guard hoạt động
```

### Bước 6: Câu lệnh đầu tiên giao cho Antigravity (mẫu cho dự án có sẵn)
> *"Đây là dự án ĐÃ CÓ SẴN, vừa được gắn AI-WorkFlow. Hãy đọc `GEMINI.md` và các file trong `.agents/state/`. Sau đó khảo sát toàn bộ codebase (cấu trúc, công nghệ, cách chạy test). **Chưa sửa bất kỳ dòng code nào.** Mục tiêu tiếp theo của tôi là: [mô tả]. Hãy viết lại `.agents/state/ROADMAP.md` thành các Task nhỏ phù hợp với code hiện có, rồi lập `CURRENT_PLAN.md` cho Task 1 và gửi Mentor duyệt (`--role strategy` hoặc `architect`) theo quy trình RPIR."*

### ✅ Checklist mỗi ngày làm việc
1. Chạy `start-system.bat` (nếu vừa bật máy).
2. Mở dự án trong Antigravity và nhắn: *"Đọc HANDOFF.md và tiếp tục theo RPIR."*
3. Trước khi nghỉ hoặc đổi tài khoản: `npm run checkpoint -- --note "..."`.

---

## 💬 3. Cách Giao Việc Hàng Ngày cho Antigravity

Sau khi xong 3 bước khởi tạo trên, công việc hàng ngày của bạn cực kỳ đơn giản: **Mở khung chat của Antigravity và ra lệnh bằng ngôn ngữ tự nhiên**.

### Mẫu câu lệnh 1: Khi bắt đầu dự án mới
> *"Hãy đọc trạng thái dự án. Tôi muốn xây dựng ứng dụng [mô tả ý tưởng của bạn, ví dụ: Quản lý chi tiêu cá nhân bằng Node.js/React...]. Hãy chia nhỏ các Task vào `.agents/state/ROADMAP.md` và bắt đầu thực hiện `task-1` theo đúng quy trình RPIR."*

### Mẫu câu lệnh 2: Khi muốn làm tiếp Task tiếp theo
> *"Hãy tiếp tục thực hiện Task tiếp theo trong `.agents/state/ROADMAP.md` theo quy trình RPIR."*

### Mẫu câu lệnh 3: Khi vừa đổi tài khoản Antigravity (hết Quota)
> *"Hãy đọc `.agents/state/HANDOFF.md` để nắm bối cảnh phiên trước và tiếp tục công việc đang dang dở."*

**Antigravity sẽ tự động làm toàn bộ các bước sau mà bạn không cần copy-paste thủ công:**
1. Đọc `HANDOFF.md`, `MENTOR_FEEDBACK.md`, `ROADMAP.md`.
2. Viết bản thiết kế kỹ thuật vào `.agents/state/CURRENT_PLAN.md`.
3. Tự gọi script `ask_mentor.mjs --mode plan` để mở Chrome ChatGPT, chọn đúng Project, chọn chế độ **Trò chuyện**, bật mức suy luận **Cao**, gọi `@Plugin` chuyên gia tương ứng và chèn thẳng nội dung prompt vào ô chat.
4. Đợi ChatGPT trả lời xong, tự trích xuất kết quả về `.agents/state/MENTOR_FEEDBACK.md`:
   - Nếu **`STATUS: APPROVED`**: Tự động mở khóa `src/`, viết code + viết test, chạy `npm test`.
   - Nếu **`STATUS: REJECTED`**: Tự đọc lỗi `P0` mà Mentor chỉ ra, sửa lại `CURRENT_PLAN.md` và gửi duyệt lại.
5. Khi code & test đã PASS, tự gọi `ask_mentor.mjs --mode review-code` để Mentor kiểm tra code thực tế trước khi đánh dấu `[x]` hoàn thành Task.

---

## 🧑‍🔬 4. Hệ thống 9 Chuyên gia (`--role`) & 2 Chế độ Khung Chat ChatGPT

### 4.1. Danh sách 9 Chuyên gia trong [`.agents/roles.json`](file:///e:/Desktop/AI-WorkFlow/.agents/roles.json)
Khi chạy `ask_mentor.mjs`, hệ thống tự động gắn khối Role Header và thử gọi `@<Tên_Plugin>` trong khung chat ChatGPT tương ứng với từng loại công việc:

| Mã `--role` | Tên Plugin / Chuyên gia trên ChatGPT | Khi nào sử dụng? |
| :--- | :--- | :--- |
| `strategy` | **Product Strategy & Scope Lead** | Phân tích yêu cầu sản phẩm, chia nhỏ `ROADMAP.md` |
| `architect` | **Software System Architect** | *(Mặc định cho `--mode plan`)* Thiết kế kiến trúc, cấu trúc thư mục, luồng dữ liệu |
| `backend` | **Backend & Distributed Systems Engineer** | Thiết kế API, Database, xử lý bất đồng bộ, hiệu năng, khóa file |
| `frontend` | **Frontend Product Engineer** | Xây dựng giao diện UI/UX, component, state management, responsive |
| `workflow` | **AI Workflow & Prompt Engineer** | Tối ưu luồng điều phối multi-agent, prompt engineering |
| `qa` | **Independent QA & Gate Reviewer** | *(Mặc định cho `--mode review-code`)* Kiểm tra chéo `git diff` và bộ test |
| `devops` | **DevOps, Reliability & Cost Engineer** | Cấu hình CI/CD, Docker, môi trường, bảo mật |
| `creative` | **Creative Director & Experience Designer** | Định hướng thẩm mỹ, trải nghiệm người dùng, micro-interactions |
| `motion` | **Creative Motion & WebGL Engineer** | Hiệu ứng chuyển động phức tạp, 3D/WebGL, shaders |

> Bạn hoặc Worker có thể kết hợp tối đa 2 chuyên gia cùng lúc, ví dụ: `--role architect,backend` hoặc `--role creative,frontend`.

---

### 4.2. Hai Chế độ Khung Chat trong ChatGPT Project (`chat` vs `work`)
Trong ChatGPT Project có 2 chế độ khung nhập liệu, bạn có thể chỉnh trong [`.agents/config.json`](file:///e:/Desktop/AI-WorkFlow/.agents/config.json) tại trường `"chatgptComposerMode"`:

1. **`"chat"` (*Trò chuyện* — Mặc định khuyến nghị)**:
   - Không hiển thị nút chọn model phức tạp.
   - Có **3 cấp độ suy luận**: `Tức thì` (`instant`), `Vừa` (`standard`), `Cao` (`high`).
   - Hỗ trợ gọi đầy đủ **`@Plugin` chuyên gia** ngay trong Project và chèn toàn bộ nội dung vào khung chat (không bao giờ sinh file đính kèm `.txt` rác).
2. **`"work"` (*Công việc*)**:
   - Hiển thị nút chọn Model ngay tại khung chat (ví dụ khi bạn điền `"chatgptModel": "GPT-6.1 Sol"` hoặc truyền `--model "GPT-6.1 Sol"`).
   - Hỗ trợ gọi `@Plugin` chuyên gia và thanh suy luận 5 mức (`Nhẹ nhàng`, `Vừa`, `Cao`, `Chuyên sâu`, `Max`).

---

## 🛠️ 5. Bảng Tra cứu Nhanh các Lệnh CLI (Dành cho bạn hoặc Worker)

| Mục đích | Lệnh chạy trong Terminal |
| :--- | :--- |
| **Khởi tạo dự án mới** (tự lấy tên thư mục & tự tạo Project trên ChatGPT) | `npm run init-workflow` |
| **Khởi tạo dự án mới + Xóa sạch file mẫu nếu muốn `src/` trống hoàn toàn** | `npm run init-workflow -- --clean-demo` |
| **Chỉ kiểm tra / tự tạo Project trên ChatGPT mà không reset state** | `npm run ensure-project` |
| **Chạy toàn bộ Unit Test của dự án** | `npm test` |
| **Gửi duyệt Kế hoạch (`CURRENT_PLAN.md`) với ChatGPT Mentor** | `node .agents/scripts/ask_mentor.mjs --mode plan --task task-1 --role architect,backend` |
| **Gửi duyệt Kế hoạch với cả 2 Mentor (Gemini góp ý trước → ChatGPT chốt)** | `node .agents/scripts/ask_mentor.mjs --mode plan --task task-1 --provider both` |
| **Gửi duyệt Code (`git diff` + kết quả `npm test`) sau khi code xong** | `node .agents/scripts/ask_mentor.mjs --mode review-code --task task-1` |
| **Gọi cứu hộ khi sửa lỗi thất bại quá 3 lần liên tiếp** | `node .agents/scripts/ask_mentor.mjs --mode rescue --task task-1 --error "Mô tả lỗi"` |
| **Chụp nhanh trạng thái (Snapshot) trước khi đổi tài khoản Antigravity** | `npm run checkpoint -- --note "Đang làm dở phần X"` |
| **Kết nối Bot Telegram thông báo & quyết định 2 chiều** | `npm run telegram-setup` |
| **Khởi chạy Telegram Real-time Daemon 24/7 (< 0.5s)** | `npm run telegram-daemon` (hoặc mở `start-telegram-daemon.bat`) |
| **Bật cầu nối Reactive Wakeup tự đánh thức Agent khi có tin nhắn/voice** | `npm run telegram-watch` |
| **Gửi câu trả lời trực tiếp từ Agent về Telegram kèm bàn phím điều khiển** | `npm run telegram-reply -- "Nội dung phản hồi"` |
| **Chờ bạn bấm nút quyết định trên Telegram khi xảy ra Escalation** | `npm run await-decision` |

---

## 📂 6. Giải thích Cấu trúc Thư mục Dự án

```text
Ten-Du-An-Moi/
├── src/                          # Nơi chứa mã nguồn chính của ứng dụng (Bị khóa cho tới khi Plan được APPROVED)
├── tests/                        # Nơi chứa các file kiểm thử tự động (*.test.mjs / *.test.js)
├── start-system.bat              # Script click đúp để mở Chrome ChatGPT (9222) và Gemini (9223)
├── GEMINI.md                     # Quy tắc bắt buộc mà Antigravity luôn tự động đọc mỗi phiên
├── .agents/
│   ├── config.json               # Cấu hình dự án (tên Project, cổng Chrome, số vòng review, chế độ chat/work)
│   ├── roles.json                # Danh bạ 9 Chuyên gia (@Plugin & Role Header)
│   ├── hooks/pre-commit          # Khóa Git: Chặn commit nếu chưa pass test hoặc chưa được Mentor duyệt code
│   ├── scripts/                  # Bộ công cụ tự động hóa (Worker TUYỆT ĐỐI không được tự sửa thư mục này)
│   └── state/                    # Bộ nhớ trạng thái của dự án (Nơi giao tiếp giữa các phiên làm việc)
│       ├── ROADMAP.md            # Danh sách các Task của dự án ([ ] chưa làm, [x] đã xong)
│       ├── CURRENT_PLAN.md       # Bản thiết kế kỹ thuật của Task đang làm
│       ├── MENTOR_FEEDBACK.md    # Phản hồi duyệt Thiết kế từ Mentor (STATUS: APPROVED / REJECTED)
│       ├── CODE_REVIEW_FEEDBACK.md # Phản hồi duyệt Code từ Mentor (CODE_STATUS: APPROVED / REJECTED)
│       ├── TECH_DEBT.md          # Sổ tay tự động lưu các góp ý cải tiến nhẹ (P1/P2) để không làm chậm tiến độ
│       ├── HANDOFF.md            # Biên bản bàn giao giữa các phiên / các tài khoản Antigravity
│       ├── SESSION_MAP.json      # Lưu đường dẫn Project và các luồng chat theo từng Task
│       └── STATE_LOCK.json       # Khóa mã băm SHA-256 chống sửa lén kế hoạch hoặc code sau khi đã duyệt
```

---

## ❓ 7. Xử lý Tình huống Thường gặp (FAQ & Troubleshooting)

### Hỏi 1: Khi đang chạy mà Mentor từ chối (`REJECTED`) hết số vòng quy định (Escalation - Exit Code 3) thì làm sao?
- **Nguyên nhân**: Để tránh việc AI lặp vô tận tốn thời gian, hệ thống giới hạn tối đa **3 vòng duyệt Plan** và **2 vòng duyệt Code** cho mỗi Task. Khi vượt quá số vòng này, hệ thống sẽ ghi mục `## ⚠️ ESCALATION` vào `.agents/state/HANDOFF.md` và dừng lại báo cho bạn.
- **Cách xử lý**: Bạn xem qua lý do trong `MENTOR_FEEDBACK.md`, chỉ đạo hướng giải quyết cho Antigravity, và nếu muốn cấp thêm lượt chạy mới cho Task đó, bạn chạy lệnh:
  ```bash
  node .agents/scripts/ask_mentor.mjs --mode plan --task task-1 --reset-rounds
  ```

### Hỏi 2: Tôi muốn thử nghiệm code nhanh trong `src/` mà chưa có `STATUS: APPROVED` thì tại sao bị chặn?
- **Nguyên nhân**: Cơ chế **Safety Gate (`verify_guard.mjs`)** bảo vệ dự án khỏi việc AI viết code bừa bãi khi chưa có thiết kế được duyệt.
- **Cách xử lý**: Luôn yêu cầu Antigravity viết `CURRENT_PLAN.md` và chạy `ask_mentor.mjs --mode plan` trước. Ngay khi ChatGPT trả về `STATUS: APPROVED`, khóa `src/` sẽ tự động mở.

### Hỏi 3: Khi tài khoản Antigravity hiện tại sắp hết hạn mức (Quota), tôi chuyển sang tài khoản khác như thế nào để không mất mạch việc?
1. Trước khi tắt tài khoản cũ, chạy lệnh:
   ```bash
   npm run checkpoint -- --note "Ghi chú ngắn gọn việc đang làm"
   ```
2. Mở tài khoản Antigravity mới (hoặc chạy `start-system.bat --multi-account`), mở lại đúng thư mục dự án và nhắn:
   > *"Đọc `.agents/state/HANDOFF.md` và tiếp tục công việc."*
   Tài khoản mới sẽ nắm bắt 100% tiến độ, mã Task và luồng chat ChatGPT đang mở mà không cần giải thích lại từ đầu!


---

## 📱 8. Điều khiển Dự án Từ xa 24/7 qua Telegram (Real-time Daemon & Reactive Wakeup v3.0)

Từ phiên bản v3.0, bạn có thể ra lệnh bằng chữ hoặc giọng nói (Voice Note `.ogg`), xem trạng thái, chạy kiểm thử, lưu Checkpoint, tạo phiên chat mới và chuyển đổi giữa nhiều dự án ngay trên điện thoại với tốc độ phản hồi **< 0.5 giây** mà không cần ngồi trước máy tính:

1. **Thiết lập lần đầu**: Chạy `npm run telegram-setup` để kết nối Bot Telegram và lưu `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` vào `.env`.
2. **Bật chế độ trực chiến 24/7**:
   - Nhắn cho Antigravity: *"Hãy bật Telegram Real-time Daemon và Reactive Wakeup"* (hoặc chạy `start-telegram-daemon.bat`).
   - Hệ thống sẽ chạy nền `telegram_daemon.mjs` kết hợp với cầu nối đánh thức `wakeup_watcher.mjs`.
3. **Các nút bấm & lệnh điều khiển trên Telegram**:
   - `📊 Trạng thái` (`/status`), `🗺️ Roadmap` (`/roadmap`), `🧪 Chạy Test` (`/test`).
   - `✅ Duyệt Gate (Override)` (`/approve`), `⏩ Gia hạn +2 vòng` (`/extend`).
   - `📸 Lưu Checkpoint` (`/checkpoint`): Tự động chạy `checkpoint.mjs` chốt `HANDOFF.md` từ xa.
   - `🆕 Tạo Phiên Mới` (`/newchat`): Tự động lưu Checkpoint và gọi Antigravity CLI (`agy --mode auto -p "..."`) khởi tạo một phiên hội thoại mới sạch sẽ khi phiên cũ quá dài.
   - `📂 Đổi dự án` (`/projects`) & `🖥️ Mở trên Antigravity IDE`: Chuyển đổi dự án đang điều khiển từ xa và mở dự án trên giao diện Antigravity IDE.
   - **Gửi tin nhắn chữ hoặc Ghi âm (Voice Note)**: Tự động tải file `.ogg` về `.agents/state/media/`, kích hoạt `wakeup_watcher.mjs` đánh thức AI Agent dậy nghe trực tiếp, thực thi yêu cầu và trả lời lại về Telegram qua `npm run telegram-reply -- "<nội dung>"`.
