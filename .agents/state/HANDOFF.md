# HANDOFF: Trạng thái Bàn giao Phiên làm việc

## 1. Bối cảnh hiện tại
- Bộ khung **AI-WorkFlow Template (RPIR v2)** đã sẵn sàng cho dự án mới:
  - Tự động nhận diện tên thư mục gốc của Workspace trong Antigravity và tự động tạo Project tương ứng trên ChatGPT (chế độ `Trò chuyện`, hỗ trợ `@Plugin` chuyên gia, chèn prompt trực tiếp không tạo file đính kèm rác).
  - Tích hợp sẵn module quản lý vòng đời Nợ Kỹ thuật (`src/tech_debt.mjs` & `tests/tech_debt.test.mjs` — `16/16 PASS`) với khóa tệp độc quyền liên tiến trình (`withFileLock` + Fail-Closed Quarantine) và khử trùng lặp SHA-256.

## 2. Bước tiếp theo (Next Steps)
1. Cập nhật danh sách Task của dự án mới vào `.agents/state/ROADMAP.md`.
2. Lập kế hoạch thiết kế cho `task-1` vào `.agents/state/CURRENT_PLAN.md` và chạy `node .agents/scripts/ask_mentor.mjs --mode plan --task task-1 --role <role_key>`.
