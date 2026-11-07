# ROADMAP: Dự án AI_WORK-FLOW — Multi-Account Antigravity + ChatGPT Mentor

## Mục tiêu
1. **Giai đoạn 1 (Task 1 – Task 3)**: Xây dựng ứng dụng Demo Todo CLI bằng Node.js thuần kèm bộ kiểm thử đơn vị và kiểm thử lỗi Filesystem thực tế để minh họa quy trình RPIR.
2. **Giai đoạn 2 (Level 1.2 — Integrity & Security Hardening: Task 4 – Task 7)**: Gia cố toàn diện hợp đồng phê duyệt (`Approval State Contract`), bản chụp mã nguồn tất định (`Deterministic Snapshot Contract`), bảo vệ hạ tầng (`.agents/` & `Three-Zone Scope`) và bộ kiểm thử đối kháng 21 kịch bản (`tests/guard_integrity.test.js`).

## Quy ước Thẻ Model & Mức Suy luận (Model & Reasoning Tags)
- ChatGPT Mentor được gọi qua `node .agents/scripts/ask_mentor.mjs`, tự động điều chỉnh mức suy luận (`setThinkingEffort`: `high` cho `plan`/`rescue`, `standard` cho `review-code`).
- `[WORKER_MODEL: <pro/flash>]`: Model khuyến nghị cho Worker Agent khi thực thi task (`pro` cho thiết kế/kiến trúc bảo mật, `pro/flash` cho kiểm thử/tác vụ tiêu chuẩn).

## Danh sách Công việc (Tasks)

### Giai đoạn 1: Ứng dụng Demo Todo CLI (Đã hoàn thành)
- [x] [WORKER_MODEL: pro] Task 1: Viết module `src/todo.js` hỗ trợ thêm, xóa, liệt kê và đánh dấu hoàn thành task (lưu vào `tasks.json`).
- [x] [WORKER_MODEL: pro/flash] Task 2: Viết script kiểm thử tự động `src/todo.test.js` kiểm tra toàn bộ các hàm của `src/todo.js`.
- [x] [WORKER_MODEL: pro/flash] Task 3: Giải quyết triệt để 3 mục Technical Debt (tinh chỉnh Path containment `isInsideDir`, bổ sung assertion định lượng cho Runner self-verification `T9.1`, và xây dựng bộ kiểm thử lỗi Filesystem thực tế không dùng mock trong `tests/fs_fault.test.js`).

### Giai đoạn 2: Nâng cấp Level 1.2 — Integrity & Security Hardening
- [ ] [WORKER_MODEL: pro] Task 4: Approval State Contract — Chuẩn hóa Schema `STATE_LOCK.json` v1.2 (FSM `PENDING -> PLAN_APPROVED -> CODE_APPROVED`), migration an toàn không tự cấp quyền, mandatory single-footer (`PLAN_SHA256`), giao dịch phê duyệt 4 bước chống TOCTOU và kiểm thử hợp đồng `G-1..G-4`, `G-10..G-16`.
- [ ] [WORKER_MODEL: pro] Task 5: Deterministic Snapshot Contract — Xây dựng `captureCodeSnapshot` 100% chỉ đọc (UTF-8 byte order, `git hash-object --stdin --path` tương đương Git Index, kiểm tra `fileMode`/symlink/unmerged index, phạm vi 3 vùng `reviewScope`/`protectedInfrastructure`/`commitAllowlist`) và kiểm thử `G-5..G-9`, `G-17`, `G-18`, `G-20`.
- [ ] [WORKER_MODEL: pro] Task 6: Infrastructure Protection — Nâng cấp `check_plan_approved.sh` + `verify_guard.mjs --check-tool` (JSON contract fail-closed, `realpathSync` chống symlink escape, khóa file trạng thái phê duyệt & `.agents/config.json`) và chế độ `--ci-verify` kèm kiểm thử `G-19`, `G-21`.
- [ ] [WORKER_MODEL: pro/flash] Task 7: Adversarial Regression Suite — Hoàn thiện và tích hợp toàn bộ 21 kịch bản kiểm thử đối kháng (`G-1` -> `G-21`) trong `tests/guard_integrity.test.js` vào `npm test` cùng tài liệu hóa Trust Boundary & Non-Destructive Rollback.
