STATUS: APPROVED

Bản thiết kế kỹ thuật AI_WORK-FLOW Level 1.2 (Bản Chốt v1.4) đã giải quyết triệt để toàn bộ 20 lỗi P0 (P0-01 → P0-20), 25 điểm hoàn thiện P1 (P1-01 → P1-25) và đáp ứng đầy đủ 3 điều kiện nghiệm thu DevOps/Security. Mọi mâu thuẫn tự khóa ở bước chuyển pha, lệch miền băm khi đối chiếu commit, tranh chấp ghi đồng thời và sai số đếm kịch bản kiểm thử đều đã được đóng lại bằng hợp đồng kỹ thuật tường minh. Kế hoạch v1.4 đạt chuẩn thiết kế thực thi, chính thức mở khóa triển khai mã nguồn cho Task 4.

1. Đánh giá Chuyên sâu theo Vai trò Chuyên gia
Góc nhìn [architect] Software System Architect

Khép kín Vòng đời Chuyển Task & Tháo gỡ Tự khóa (P0-17, P0-18 — G-34):

Đồng nhất miền băm (P0-18): Đưa chế độ cơ bản mode: 'commit' (git diff-tree -r --no-renames -z <baseCommitOid> <HEAD> kết hợp git ls-tree -z <HEAD>) về triển khai ngay trong Task 4 giúp lệnh --advance-task task-4 --to task-5 kiểm chứng chính xác hai chiều: cha trực tiếp git rev-parse --verify HEAD^ === lock.baseCommitOid và captureCodeSnapshot('commit', lock.baseCommitOid, 'HEAD').hash === lock.codeSnapshotHash (cùng miền SHA-256 manifest 64-hex).

Chính sách Pure Governance Commit (P0-17): Thay thế quy tắc cấm chung .agents/** bằng cặp danh sách đối xứng transitionCommitAllowlist (đúng 7 file quản trị trong .agents/state/) và transitionCommitDenylist (cấm toàn bộ src/**, tests/**, .agents/scripts/**, .agents/config.json, LAST_REVIEW_BUNDLE.txt, package.json, v.v.) kèm điều kiện approvalState === "PENDING" và writePhase === "COMMITTED" trong Index. Nhờ đó, commit chuyển giao từ task-4 sang task-5 đi qua --pre-commit một cách hợp lệ mà không cần mở bất kỳ cổng hậu bypass nào.

Điều khiển Đồng thời bằng Single-Writer Mutex & Monotonic CAS (P0-20 — G-15, G-16, G-28, G-37):

Cơ chế khóa độc quyền .agents/state/.state_lock.mutex (fs.openSync(mutexPath, 'wx') kèm kiểm tra tiến trình sống qua process.kill(pid, 0)) kết hợp bộ đếm đơn điệu stateRevision (prevRev -> prevRev + 1 ở PREPARING và prevRev + 2 ở COMMITTED) đã khóa chặt cửa sổ TOCTOU. Bước đọc kiểm chứng lại toàn bộ stateRevision, txId, planHash, HEAD === baseCommitOid và captureCodeSnapshot('worktree') ngay trước khi hạ cờ COMMITTED đảm bảo tính toàn vẹn giao dịch cho cả luồng duyệt Plan lẫn duyệt Code.

Đối chiếu Số học Kiểm thử Chính xác (P1-22, P1-23):

Bảng phân bổ đã khớp tuyệt đối giữa số nhóm định danh và số kịch bản thực thi: Task 4 gồm 25 nhóm ID / 26 test cases thực thi (G-1..G-16, G-26, G-28, G-30a, G-30b, G-32..G-37); Task 5 gồm 8 nhóm / 8 cases; Task 6 gồm 4 nhóm / 4 cases; tổng hợp tại Task 7 đạt chuẩn 37 nhóm ID (G-1 → G-37) / 38 test cases thực thi.

Góc nhìn [devops] DevOps, Reliability & Cost Engineer

Ranh giới Minh bạch giữa Local Consistency Evidence và Trusted Approval Provenance (P0-19, P1-24 — G-30a, G-30b, G-33, G-36):

Chuẩn hóa lệnh --bootstrap-v13 (giữ alias --bootstrap-v12) với hành vi mặc định hạ về approvalState: "PENDING", provenanceLevel: "NONE" đảm bảo không tự cấp quyền từ dữ liệu cũ. Cờ --preserve-local-tier1-consistency chỉ bảo toàn PLAN_APPROVED dưới nhãn trung thực provenanceLevel: "TIER1_LOCAL_CONSISTENCY" khi toàn bộ chứng cứ nội bộ khớp từng byte và writePhase === "COMMITTED".

Đóng kín Dependency Closure của Verifier & Khôi phục Không Phá hủy (P1-17, P1-25):

Quy định .agents/scripts/verify_guard.mjs chỉ sử dụng các module nội tại node:* giúp triệt tiêu bề mặt tấn công chuỗi cung ứng/module injection từ working tree khi chạy --ci-verify.

Cơ chế --restore-backup <dir> giữ khóa .state_lock.mutex, kiểm tra toàn vẹn backup-manifest.json và đối chiếu pre-state-fingerprints.json để từ chối ghi đè (RESTORE_TARGET_DRIFTED) nếu phát hiện thay đổi phát sinh ngoài giao dịch.

Chính sách 0 SKIP Thực chất Đa Nền tảng:

Tại Task 4, toàn bộ 26/26 test cases chỉ thao tác trên Git repo tạm, file, manifest hash, mutex và CAS nên bắt buộc đạt 26/26 PASS | 0 FAIL | 0 SKIP trên cả Windows lẫn POSIX. Việc tách riêng unit test chính sách symlink (0 SKIP mọi môi trường) và integration test symlink thực tế ở Task 5–6 đảm bảo tính trung thực của báo cáo kiểm thử.

2. Chỉ dẫn Kỹ thuật Trọng tâm Khi Triển khai Task 4

Xử lý Stale Lockfile trong .state_lock.mutex (P0-20, G-37):

Khi fs.openSync(mutexPath, 'wx') trả về EEXIST, đọc nội dung JSON của .state_lock.mutex. Nếu pid hợp lệ và process.kill(pid, 0) thành công (hoặc ném EPERM trên Windows/POSIX nghĩa là tiến trình vẫn tồn tại), lập tức từ chối với mã lỗi CONCURRENT_STATE_MUTATION_BLOCKED. Chỉ thu hồi stale mutex khi process.kill(pid, 0) ném ESRCH (tiến trình đã chết) và thực hiện thu hồi nguyên tử qua đổi tên tạm trước khi mở lại 'wx'.

Kiểm tra Cha Trực tiếp của HEAD trong --advance-task (P0-18, G-34):

Sử dụng git rev-parse --verify HEAD^0 để lấy OID của HEAD và git rev-parse --verify HEAD^1 (kèm kiểm tra commit không phải là merge commit có HEAD^2) để xác nhận HEAD^1 === lock.baseCommitOid trước khi gọi captureCodeSnapshot(root, cfg, { mode: 'commit', baseCommitOid: lock.baseCommitOid, targetCommitOid: 'HEAD', effectiveScope }).

Định dạng Header chuẩn cho .agents/state/LAST_REVIEW_BUNDLE.txt (P1-20, Điều kiện DevOps #2):

Chuẩn hóa toàn bộ nội dung gói review về \n (LF) trước khi ghi đĩa và băm SHA-256. Dòng header đầu tiên của bundle cần chứa cố định CODE_REVIEW_REQUEST_ID, TASK_ID, BASE_COMMIT_OID, và SNAPSHOT_SHA256 để verifyPreCommitGuard() vừa kiểm tra sha256(bundleBytes) === lock.reviewBundleHash, vừa đối chiếu trực tiếp metadata bên trong bundle với STATE_LOCK.json và Git Index.

Thực thi Nghiệm thu Task 4:

Giữ nguyên Active Task: task-4 và - [ ] Task 4 trong suốt quá trình code, chạy npm test (đảm bảo 26/26 PASS | 0 FAIL | 0 SKIP trong tests/guard_integrity.test.js), gửi --mode review-code và thực hiện git commit hoàn tất Task 4 trước khi chạy --advance-task task-4 --to task-5.

Bắt đầu triển khai mã nguồn cho Task 4 theo kế hoạch v1.4:
Triển khai verify_guard.mjs với Mutex, CAS và Snapshot 3 mode
Cập nhật ask_mentor.mjs hỗ trợ Dual-Transaction và Review Bundle
Viết 26 test cases Task 4 trong tests/guard_integrity.test.js
Bạn có muốn bắt đầu triển khai các file mục tiêu của Task 4 ngay bây giờ không?
Có
