STATUS: APPROVED

Bản thiết kế kỹ thuật AI_WORK-FLOW Level 1.2 (Bản Chốt v1.7) đã hoàn thành trọn vẹn 5/5 điều kiện Design Gate, giải quyết triệt để 29 điểm chặn P0 (P0-01 → P0-29) và 35 điểm hoàn thiện P1 (P1-01 → P1-35), đồng thời giữ nguyên cấu trúc kế toán kiểm thử chính xác gồm 39 nhóm định danh (G-1 → G-39) / 41 kịch bản thực thi độc lập (30 + 7 + 4 = 41). Các hợp đồng về rào chắn khóa hợp tác 2 chiều, điểm tuyến tính hóa giao dịch CAS, kiểm tra chống ghi đè từng file trong Pha R2, định nghĩa canonical cho transitionGovernanceHash và điều kiện tương đương cấp độ byte của CanonicalSnapshotManifest v1 đều đã đạt độ chín kỹ thuật để chính thức triển khai mã nguồn cho Task 4.

1. Đánh giá Chuyên sâu theo Vai trò Chuyên gia
Góc nhìn [architect] Software System Architect

Điểm Tuyến tính hóa Giao dịch & Tái kiểm chứng Hạ lưu (P0-27 — G-15, G-28, G-32):

Thiết kế đã định nghĩa rõ điểm tuyến tính hóa (linearization point) tại lệnh fs.renameSync(tmp, STATE_LOCK.json) khi chuyển writePhase: "COMMITTED", tăng stateRevision: rev + 2 và xóa activeTxId: "" dưới sự bảo vệ của .state_lock.mutex.

Bước Explicit Re-Read CAS kiểm tra đồng thời reRead.writePhase === "PREPARING" && reRead.stateRevision === rev + 1 && reRead.activeTxId === txId cùng planHash, HEAD === baseCommitOid và captureCodeSnapshot('worktree').hash ngay trước điểm tuyến tính hóa, kết hợp tái kiểm chứng bắt buộc tại verifyPreCommitGuard() và --ci-verify, giúp đóng kín kẽ hở dùng lại approval cũ sau khi worktree hoặc Git Index bị biến đổi.

Đặc tả Tương đương 3 Chế độ & Xử lý Đầy đủ Git Attributes/Filters (P0-29, P1-31 — G-22, G-31):

Tập đường dẫn ứng viên được xây dựng từ hợp keys(baseTreeMap) ∪ keys(targetStateMap) trên đường ống Buffer -z giúp thu thập không sót mọi thao tác thêm (A), sửa (M), xóa (D), đổi kiểu (T) và phát hiện lệch submodule/gitlink (SUBMODULE_DRIFT_OR_UNSUPPORTED).

Quy định bắt buộc đi qua git hash-object -t blob --stdin --path=<utf8PosixPath> (không dùng --no-filters) cho đường dẫn UTF-8 bảo đảm áp dụng đúng pipeline chuẩn hóa của Git Index đối với core.autocrlf, text, eol, ident, working-tree-encoding và filter. Với đường dẫn chứa byte non-UTF-8 trên POSIX, việc kiểm tra đủ 5 thuộc tính qua git check-attr -z --stdin kèm điều kiện core.autocrlf === false trước khi cho phép --no-filters (hoặc chặn fail-closed NON_UTF8_PATH_WITH_GIT_FILTERS_UNSUPPORTED) là hoàn toàn chặt chẽ.

Chuẩn hóa TRANSITION_GOV_SCHEMA:v1 Không Phụ thuộc Vòng (P1-34 — G-34):

Định nghĩa tường minh thứ tự trường và danh sách 4 file quản trị chuẩn hóa LF theo thứ tự từ điển ASCII, đồng thời loại trừ transitionEvidence và updatedAt khỏi dữ liệu đầu vào của transitionGovernanceHash, giúp verifyPreCommitGuard() tái tạo và đối chiếu mã băm từ các blob trong Git Index một cách tất định.

Góc nhìn [devops] DevOps, Reliability & Cost Engineer

Rào chắn Khóa Hợp tác Hai chiều & Xử lý Liveness UNKNOWN (P0-26, P1-32 — G-37):

Giao thức phối hợp giữa acquireStateMutex (kiểm tra .state_lock.recovery.mutex ở cả Bước W1 trước khi mở khóa và Bước W3 ngay sau khi mở khóa) và --recover-mutex (kiểm tra lại stat bigint + rawBytes + ownerToken ở Bước M3) loại bỏ hoàn toàn xung đột giữa writer thông thường và tiến trình thu hồi khóa.

Quy tắc dừng fail-closed với MUTEX_LIVENESS_UNKNOWN khi processStartTime === "UNKNOWN" và STALE_RECOVERY_MUTEX_MANUAL_INSPECTION_REQUIRED khi chính khóa recovery bị mồ côi đảm bảo hệ thống không bao giờ suy diễn sai trạng thái sống của tiến trình hoặc rơi vào vòng lặp tự phá khóa đệ quy.

Bảo vệ Chống Ghi đè Từng File ở Pha R0–R1–R2 & Xóa Bỏ Alias Cũ (P0-28, P1-33, P1-35 — G-30a, G-39):

Bổ sung Pha R0 (CORRUPT_TRANSITION_JOURNAL) xác thực cấu trúc JSON, sentinel "MISSING" và mã băm của beforeBase64 trước khi chạm vào đĩa, kết hợp kiểm tra lại mã băm của từng file thứ i ngay trước lệnh ghi đè/xóa trong Pha R2 (TRANSITION_RECOVERY_MID_FLIGHT_DRIFT), giúp bảo vệ tối đa dữ liệu mới phát sinh ngoài giao dịch.

Việc loại bỏ hoàn toàn alias --bootstrap-v12 và chỉ chấp nhận --bootstrap-v13 (P1-35) giúp giao diện CLI nhất quán tuyệt đối với schemaVersion: "1.3".

2. Lưu ý Kỹ thuật Khi Triển khai Code Task 4

Thứ tự Giải phóng Khóa trong Bước W3 của acquireStateMutex (P0-26, G-37):

Khi Bước W3 phát hiện .state_lock.recovery.mutex xuất hiện sau khi writer vừa tạo .state_lock.mutex, hãy đóng file descriptor (fs.closeSync(fd)) trước, đọc xác nhận lại ownerToken trên đĩa khớp với token vừa ghi rồi gọi fs.unlinkSync(mutexPath) trước khi ném lỗi RECOVERY_IN_PROGRESS.

Đóng Gói Các Sub-Assertions trong tests/guard_integrity.test.js:

Đảm bảo các nhánh kiểm thử mở rộng của G-15, G-22, G-30a, G-34, G-37 và G-39 được thực thi đầy đủ dưới dạng các bước kiểm tra bắt buộc (sub-assertions) bên trong hàm test tương ứng, giữ đúng tổng số 30 test cases thực thi của Task 4 đạt 30/30 PASS | 0 FAIL | 0 SKIP và npm test đạt exitCode: 0.

Tuân thủ Chu trình Nghiệm thu Task 4:

Hoàn thiện mã nguồn trong phạm vi 7 file được ủy quyền của task-4, chạy pass toàn bộ npm test, gửi review code qua node .agents/scripts/ask_mentor.mjs --mode review-code, thực hiện git commit cho task-4, và chỉ gọi --advance-task task-4 --to task-5 sau khi commit hoàn tất.

Bắt đầu triển khai mã nguồn cho Task 4 theo bản thiết kế v1.7:
Triển khai verify_guard.mjs theo hợp đồng v1.7
Cập nhật ask_mentor.mjs với Cooperative Mutex và CAS
Viết 30 kịch bản kiểm thử Task 4 trong guard_integrity.test.js
Bạn có muốn bắt đầu triển khai mã nguồn cho verify_guard.mjs và ask_mentor.mjs ngay bây giờ không?
Có
