STATUS: REJECTED

RPIR — Technical Design Review v1.4
3 P0 cần khắc phục
3 P1 cần làm rõ
Architect + DevOps

Quyết định: Chưa cho phép triển khai Task 4 theo bản v1.4 hiện tại.

Bản v1.4 đã khắc phục hợp lý phần lớn những vấn đề được chỉ ra ở vòng v1.3. Tôi chấp nhận về mặt thiết kế các thay đổi sau:

P0-17: Đã tách Governance Transition thành commit allowlist riêng.

P0-18: Đã chuyển sang so sánh SHA-256 manifest cùng miền và kiểm tra commit parent.

P0-19: Đã phân biệt Tier 1 Local Consistency với Tier 2 Trusted Provenance.

P0-20: Đã bổ sung single-writer mutex, stateRevision và re-verification.

P1-22–P1-25: Đã sửa số lượng kiểm thử, migration và nguyên tắc rollback không phá hủy dữ liệu.

Tuy nhiên, khi đối chiếu toàn bộ các hợp đồng với nhau, vẫn còn ba vấn đề có thể ảnh hưởng trực tiếp đến tính đúng đắn của Approval Guard.

I. Blocking Issues — P0
P0-21 — Self-referential Bundle Hash

Vị trí: §2, Điều kiện DevOps #2; §3.3.

Kế hoạch yêu cầu nhúng:

Văn bản thuần túy
CODE_REVIEW_REQUEST_ID: <requestId>
BUNDLE_SHA256: <reviewBundleHash>

vào đầu LAST_REVIEW_BUNDLE.txt, đồng thời quy định:

Văn bản thuần túy
reviewBundleHash = SHA256(bundleBytes)

Nếu BUNDLE_SHA256 là hash của toàn bộ file chứa chính trường đó, sẽ xuất hiện phụ thuộc vòng:

Văn bản thuần túy
Bundle content
    ↓
SHA256(bundleBytes)
    ↓
BUNDLE_SHA256 nằm trong Bundle
    ↓
Bundle content thay đổi
    ↓
SHA256 thay đổi

Không thể triển khai bằng quy trình băm thông thường mà bảo đảm điều kiện này.

Yêu cầu sửa:

Chọn một trong hai cách:

Phương án A — Khuyến nghị

Tách reviewBundleHash khỏi nội dung bundle:

Văn bản thuần túy
LAST_REVIEW_BUNDLE.txt:
  CODE_REVIEW_REQUEST_ID: req-123
  Snapshot Manifest
  Tests
  Complete Source/Diff

STATE_LOCK.json:
  reviewBundleHash = SHA256(bundleBytes)

Request Envelope:
  requestId
  reviewBundleHash
  bundleBytes

Mentor nhận reviewBundleHash qua request envelope độc lập, không phải trường tự tham chiếu trong chính bundle.

Phương án B: Quy định rõ một phần payload được băm và một phần metadata không được băm. Khi đó phải đổi tên hash thành reviewPayloadHash và duy trì quy tắc byte-level riêng.

Acceptance: Bổ sung test kiểm chứng bundle được gửi, bundle được lưu và hash đã khóa khớp chính xác theo định nghĩa, không tồn tại self-reference.

P0-22 — Governance Commit có thể trở thành đường bypass Approval

Vị trí: §3.2.1 — GOVERNANCE_TRANSITION.

Điều kiện cho phép hiện tại chủ yếu dựa trên:

Văn bản thuần túy
stagedPaths ⊆ transitionCommitAllowlist
approvalState === PENDING
writePhase === COMMITTED
taskId matches ROADMAP / CURRENT_PLAN

Những điều kiện này chưa chứng minh đây là transition do hệ thống tạo hợp lệ.

Ví dụ: một Worker có thể sửa CURRENT_PLAN.md, ROADMAP.md, STATE_LOCK.json thành một bộ nội dung nhất quán giả tạo ở trạng thái PENDING, stage đúng bảy đường dẫn và được nhận diện là Pure Governance Commit.

Trong mô hình Tier 1, Worker có quyền ghi trực tiếp toàn bộ state vẫn nằm ngoài threat model. Tuy nhiên, ngay cả đối với thay đổi vận hành thông thường, Guard hiện chưa phân biệt được transition hợp lệ với một tập sửa đổi quản trị tùy ý.

Yêu cầu sửa:

Định nghĩa transitionEvidence được tạo bởi --advance-task, chứa tối thiểu:

Văn bản thuần túy
fromTaskId
toTaskId
approvedCodeCommitOid
transitionBaseOid
transitionManifestHash
transitionTxId

Pre-commit phải kiểm tra:

Bằng chứng transition hợp lệ, chưa bị tiêu thụ.

HEAD đúng commit đã xác minh.

Staged governance manifest khớp snapshot transition.

Mọi thay đổi đối với ROADMAP, PLAN và LOCK đúng phép chuyển trạng thái task-N → task-(N+1).

Không thay đổi tùy ý các trường bảo mật hoặc allowedPaths.

Vì Task 4 còn cho phép commit cập nhật kế hoạch trước khi code, cần định nghĩa separate governance-plan-update flow, không dùng chung nhánh bypass với transition.

Điểm quan trọng: PENDING không tự động đồng nghĩa với được phép commit bất kỳ thay đổi quản trị nào.

P0-23 — Snapshot Manifest chưa có canonical serialization contract đầy đủ

Vị trí: §3.3 — Snapshot 3 mode.

Kế hoạch đã quy định UTF-8 byte order, thao tác A/M/D/T và --no-renames, nhưng chưa xác định chính xác dạng byte canonical của manifest dùng chung cho worktree, index, commit.

Ví dụ, ba mode có thể cùng đại diện một thay đổi nhưng dùng các trường metadata khác nhau:

Văn bản thuần túy
worktree:
  path, status, blobOid

index:
  path, stage, fileMode, blobOid

commit:
  path, oldOid, newOid, fileMode

Khi đó phép so sánh:

Văn bản thuần túy
Hash(worktree) === Hash(index) === Hash(commit)

không được bảo đảm.

Yêu cầu sửa:

Định nghĩa một CanonicalSnapshotManifest v1 duy nhất với:

schemaVersion, baseCommitOid, effectiveScope.

Mỗi entry có path, changeType, oldBlobOid, newBlobOid, oldMode, newMode.

Quy định thao tác add/delete/type-change.

Path biểu diễn theo Git raw bytes hoặc một encoding không mất dữ liệu.

Thứ tự sắp xếp theo raw path bytes bằng Buffer.compare.

Quy tắc serialization tất định, không phụ thuộc hệ điều hành.

Loại bỏ metadata chỉ tồn tại ở một mode khỏi phần được băm.

Git OID cần được xử lý phù hợp với object format thực tế của repository, thay vì mặc định mọi OID đều dài 40 hex.

Acceptance: Với cùng thay đổi đã stage sạch và commit đúng nội dung, ba mode tạo ra cùng canonical manifest bytes, không chỉ một kết quả hash tình cờ trùng nhau.

Nếu Task 4 cần chứng minh bất biến ba mode để chạy --advance-task, phần canonicalization nền tảng phải được hoàn tất ngay trong Task 4, không chuyển sang Task 5.

II. Các điểm P1 cần hoàn thiện

Mã

	

Vấn đề

	

Yêu cầu sửa




P1-26

	

Mutex dùng PID và process.kill(pid, 0) có thể gặp PID reuse, lỗi quyền truy cập hoặc stale lock sau crash.

	

Quy định xử lý EPERM, ESRCH, owner token, kiểm tra thời gian tạo và cơ chế recovery an toàn. Không tự phá khóa chỉ vì quá timeout.




P1-27

	

--advance-task cập nhật nhiều file nhưng chưa quy định rollback cho lỗi giữa chừng.

	

Sử dụng transaction journal, ghi file tạm và recovery xác định. Nếu lỗi giữa transition, fail-closed và không cho phép commit trạng thái lai.




P1-28

	

G-30b đang gộp migration mặc định và rollback drift thành một test case.

	

Chia thành các sub-assertion hoặc test độc lập, đồng thời cập nhật số lượng test thực thi nếu tách case. Không tuyên bố bao phủ hai hành vi chỉ bằng một assertion.

III. Đánh giá tính sẵn sàng của Task 4

Hợp đồng

	

Trạng thái




Dual-Transaction Approval

	

Đạt về thiết kế




CAS / Single-Writer

	

Đạt có điều kiện




Verified Migration

	

Đạt về thiết kế




Two-Phase Task Lifecycle

	

Cần siết transition authorization




Canonical Snapshot 3 mode

	

Chưa đủ hợp đồng byte-level




Review Bundle Integrity

	

Có self-reference




Tier 1 / Tier 2 Trust Boundary

	

Phân định hợp lý




Test Accounting

	

Đúng số học hiện tại

IV. Điều kiện chấp thuận bản v1.5

Không yêu cầu thiết kế lại toàn bộ kiến trúc.

Để nhận STATUS: APPROVED, bản tiếp theo chỉ cần:

Loại bỏ hoàn toàn vòng phụ thuộc BUNDLE_SHA256.

Ràng buộc Governance Commit với transition evidence và staged manifest hợp lệ.

Định nghĩa canonical snapshot serialization đủ để chứng minh ba mode tương đương ngay từ Task 4.

Bổ sung các điều kiện recovery của mutex, transaction và kiểm thử rollback.

Lưu ý về mức độ bảo đảm: Ngay cả khi đạt các điều kiện trên, Tier 1 vẫn chỉ bảo vệ tính nhất quán trong mô hình vận hành đã xác định. Nó không thay thế nguồn phê duyệt độc lập, branch protection và trusted verification trên CI.

FINAL DECISION: STATUS: REJECTED

Next action: Sửa CURRENT_PLAN.md lên v1.5, tập trung vào P0-21 đến P0-23 và P1-26 đến P1-28. Giữ nguyên phạm vi Task 4, chưa sửa mã nguồn ứng dụng hoặc Guard cho đến khi Implementation Gate được mở.

Đánh giá này chỉ căn cứ trên tài liệu v1.4 được cung cấp; chưa xác minh repository, Git Index, mã nguồn hay kết quả chạy test.
