STATUS: REJECTED

RPIR — Technical Design Review v1.1

Dự án: AI_WORK-FLOW — Level 1.2 Integrity & Security Hardening
Phạm vi: Task 4–Task 7
Chuyên gia: Software System Architect + DevOps, Reliability & Cost Engineer

Design Gate: REJECTED
Revision v1.1
Implementation: HOLD
1. Kết luận tổng quan

Bản v1.1 đã xử lý tốt phần lớn phản biện ở vòng 1. Đặc biệt, các thay đổi về Mandatory Footer, Strict Migration, FSM, Read-Only Git Snapshot và phân biệt hai tầng bảo mật là những cải tiến đúng hướng.

Tuy nhiên, chưa thể phê duyệt triển khai vì còn các vấn đề ảnh hưởng trực tiếp đến tính đúng đắn của quy trình Git, quyền phê duyệt và khả năng vận hành liên tục qua Task 4–7.

Hạng mục

	

Đánh giá




Mandatory Approval Footer

	

Đạt về nguyên tắc




Legacy Lock Migration

	

Đạt về định hướng




FSM & Task Binding

	

Cần sửa hợp đồng




TOCTOU Transaction

	

Chưa bảo đảm nhất quán đầy đủ




Deterministic Git Snapshot

	

Có lỗi logic chặn triển khai




Three-Zone Scope Policy

	

Cần thống nhất




Independent CI Verification

	

Chưa có ranh giới tin cậy thực chất




Rollback & Recovery

	

Cần bổ sung




21 Regression Tests

	

Tốt nhưng thiếu trường hợp quyết định

2. Các lỗi P0 bắt buộc sửa
P0-08 — Mâu thuẫn giữa Snapshot lúc pre-commit và Snapshot lúc CI
Critical — Architectural Blocker

Đây là lỗi nghiêm trọng nhất còn lại của bản v1.1.

Kế hoạch quy định:

Bash
git rev-parse --verify HEAD

để xác định baseCommitOid, rồi lấy các file thay đổi so với HEAD làm đầu vào cho codeSnapshotHash.

Cách này hợp lý khi thực hiện review trước commit, nhưng không thể tái sử dụng nguyên trạng sau commit.

Ví dụ:

Lúc Mentor review

HEAD = A

Snapshot được duyệt

Base A → Working Tree B

Hash = H(A, B)

Sau khi tạo commit B

HEAD = B

CI tính lại theo HEAD mới

Base B → Working Tree B

Hash = H(B, B) ≠ H(A, B)

Hậu quả: --ci-verify có thể từ chối chính commit hợp lệ vừa được Mentor duyệt.

Yêu cầu sửa:

Định nghĩa ba chế độ snapshot độc lập:

Mode

	

So sánh

	

Mục đích




worktree

	

baseCommitOid → Working Tree

	

Snapshot gửi Mentor




index

	

baseCommitOid → Git Index

	

Pre-commit




commit

	

baseCommitOid → Commit Tree

	

Independent CI

Bổ sung baseCommitOid vào dữ liệu phê duyệt và ràng buộc như sau:

Ở worktree: lấy base tại thời điểm Capture.

Ở index: bắt buộc HEAD === baseCommitOid; nếu HEAD đã đổi thì hủy quyền commit hoặc yêu cầu review lại.

Ở commit: dùng base đã khóa, không lấy HEAD mới làm base.

CI phải so sánh nội dung commit được kiểm tra với snapshot đã duyệt, không so với trạng thái Working Tree trên runner.

Đối với merge commit, squash merge hoặc rebase, phải quy định cách xử lý riêng. Khuyến nghị ở Level 1.2: xác minh commit ứng viên trước khi merge, yêu cầu base phù hợp và từ chối các trường hợp lịch sử thay đổi mà chưa xác minh lại.

Acceptance Criteria mới: Cùng một thay đổi hợp lệ phải tạo ra cùng codeSnapshotHash ở cả ba mode worktree, index và commit.

P0-09 — CI chưa độc lập nếu Worker có thể sửa chính bộ kiểm chứng
Critical — Trust Boundary

Kế hoạch đề xuất chạy:

Bash
node .agents/scripts/verify_guard.mjs --ci-verify

trên GitHub Actions.

Tuy nhiên, Task 4–6 đang trực tiếp thay đổi verify_guard.mjs. Nếu CI checkout mã nguồn PR rồi chạy phiên bản script nằm trong chính PR, Worker có thể sửa script để luôn trả về exit code 0.

Khi đó, CI chạy trên máy khác nhưng logic kiểm chứng vẫn do Worker kiểm soát.

Yêu cầu sửa:

Bộ CI verification đáng tin cậy phải được lấy từ protected baseline, workflow được bảo vệ hoặc nguồn riêng mà Worker không thể tự thay đổi.

Mã nguồn PR được coi là dữ liệu cần kiểm chứng, không phải nguồn chính sách đáng tin cậy.

Các thay đổi đối với chính verifier cần có cơ chế cập nhật, kiểm thử và phê duyệt riêng.

Required status checks và branch protection phải được cấu hình sao cho Worker không thể tự vô hiệu hóa. Có thể dùng required reviewer/CODEOWNERS và giới hạn quyền bypass phù hợp.

GitHub hỗ trợ required reviews và required status checks, nhưng việc bật chúng phải đi kèm cấu hình quyền thực tế. 
GitHub Docs
+1

Đặc biệt, CI không thể xem STATE_LOCK.json và footer trong cùng PR là bằng chứng độc lập về nguồn phê duyệt. Worker vẫn có thể sửa cả hai cho khớp nhau.

Phải có nguồn xác nhận approval nằm ngoài quyền tự ghi của Worker nếu muốn đạt Tier 2. Ví dụ: một approval record do hệ thống tin cậy quản lý, gắn với task, request và snapshot hash; hoặc một quy trình reviewer độc lập trên GitHub được kiểm soát quyền.

Nếu chưa triển khai được tầng này trong Task 4–7, phải ghi rõ Tier 2 là chưa được nghiệm thu, không tuyên bố hoàn thành Independent Verification.

P0-10 — Xác định activeTaskId có thể làm khóa toàn bộ Task 5–7
High — State Machine Deadlock

Trong mục 3.2.2, kế hoạch quy định xác định task hiện hành từ tiêu đề CURRENT_PLAN.md và task chưa hoàn thành đầu tiên trong ROADMAP.md.

Nhưng tài liệu hiện tại có tiêu đề chung:

Văn bản thuần túy
... (TASK 4 – TASK 7)

Sau khi Task 4 hoàn thành:

ROADMAP.md chuyển sang Task 5.

CURRENT_PLAN.md vẫn là kế hoạch Task 4–7.

STATE_LOCK.json có thể vẫn mang task-4.

verifyPlanGuard() phát hiện mâu thuẫn và trả về ok: false.

Ngoài ra, cơ chế cấp quyền hiện tại cho phép allowedPaths của Task 4 bao gồm cả file thuộc Task 5–7. Điều này làm mờ ranh giới phê duyệt theo từng task.

Yêu cầu sửa:

Quy định một nguồn xác định activeTaskId duy nhất, có thể là tham số CLI được điều phối kiểm soát, kết hợp metadata có cấu trúc.

Đề xuất hợp đồng:

Văn bản thuần túy
Phase Plan: Level 1.2
Active Task: task-4
Approved Scope: task-4 only
Approval Revision: v1.1

Mỗi lần chuyển task phải có quy trình chuyển trạng thái rõ ràng.

Nếu muốn phê duyệt một lần cho cả Task 4–7, cần thiết kế cơ chế phê duyệt đa task riêng.

Nếu tuân thủ RPIR theo từng task, mỗi task phải có plan approval và code review độc lập.

Khuyến nghị: Giữ RPIR per-task. Kế hoạch tổng thể Level 1.2 chỉ là tài liệu định hướng; CURRENT_PLAN.md dùng để xác định phạm vi thực thi của task hiện hành.

P0-11 — Symlink nằm bên trong repo vẫn có thể vượt qua chính sách Protected Infrastructure
High — Path Authorization Bypass

Mục 3.4.1 đã bổ sung realpathSync.native, nhưng quy tắc được mô tả chỉ chặn khi đường dẫn thực tế nằm ngoài repository.

Ví dụ:

Văn bản thuần túy
repo/
├── src/
│   └── internal-link -> ../.agents/scripts/
└── .agents/
    └── scripts/
        └── verify_guard.mjs

Worker yêu cầu ghi:

Văn bản thuần túy
src/internal-link/verify_guard.mjs

Đường dẫn theo tên nằm trong src/, nhưng đường dẫn thực tế trỏ vào .agents/scripts/.

Nếu chỉ kiểm tra realTarget vẫn thuộc repository, thao tác này có thể được cho phép dù đang sửa hạ tầng được bảo vệ.

Yêu cầu sửa:

Phải áp dụng authorization trên cả hai đường dẫn:

Đường dẫn logic ban đầu.

Đường dẫn đích thực tế sau khi giải quyết symlink.

Cả hai phải được cho phép. Nếu một trong hai thuộc vùng cấm thì từ chối thao tác.

Bổ sung xử lý đường dẫn chưa tồn tại, symlink bị hỏng, ghi qua đường dẫn cha và trường hợp thay thế file bằng rename. Chặn truy cập .git/ thông qua tool ghi file.

Lưu ý: kiểm tra bằng realpathSync vẫn có race condition nếu một tiến trình khác đổi symlink sau kiểm tra. Điều này phải nằm trong giới hạn Tier 1 đã tuyên bố.

P0-12 — Chưa có quy trình Bootstrap/Migration để nâng cấp chính Guard
High — Deployment Blocker

Task 4 trực tiếp thay đổi verify_guard.mjs, ask_mentor.mjs và init_project.mjs.

Trong khi đó, mã mới quy định:

Legacy lock bị từ chối.

Trạng thái PENDING không cho sửa protected infrastructure.

Việc migration có thể đưa approval về PENDING.

Điều này có thể tạo ra tình huống hệ thống tự khóa ngay giữa quá trình nâng cấp.

Yêu cầu sửa:

Bổ sung quy trình bootstrap có quyền kiểm soát riêng:

Kiểm tra backup và baseline của Level 1.1.

Chuẩn bị bản nâng cấp trong môi trường hoặc worktree cô lập.

Chạy kiểm thử migration và Guard mới.

Kích hoạt verifier/hook mới theo một bước chuyển đổi được kiểm soát.

Chỉ hoàn tất khi toàn bộ kiểm thử và kiểm tra trạng thái đạt yêu cầu.

Nếu bước nâng cấp thất bại, phải còn đường phục hồi bằng phiên bản Guard tin cậy trước đó.

Không dùng ngoại lệ tự đặt biến môi trường để giải quyết tình trạng này.

3. Các vấn đề P1 còn lại
P1-09 — Hai lần renameSync() không tạo thành một giao dịch nguyên tử

Kế hoạch gọi Phase 4 là Atomic Approval Write, nhưng đang thực hiện lần lượt:

Rename feedback.

Rename STATE_LOCK.json.

Mỗi rename có thể nguyên tử trên filesystem phù hợp, nhưng hai lần rename không tạo thành một transaction nguyên tử chung.

Nếu chương trình dừng giữa hai bước, feedback và lock có thể không đồng bộ.

Cần bổ sung transactionId, cơ chế phát hiện trạng thái ghi dở và recovery fail-closed. Nên xác định một bản ghi trạng thái có thẩm quyền, sử dụng temp file cùng filesystem và xác minh toàn bộ quan hệ feedback–lock trước khi coi approval hợp lệ.

P1-10 — git status --porcelain=v1 -z chưa đặc tả đầy đủ việc parse rename

Git documentation quy định bản ghi rename trong chế độ -z có hai đường dẫn, với thứ tự khác dạng hiển thị thông thường. 
git-status Documentation

Thuật toán hiện tại chưa chỉ rõ cách chuyển rename thành manifest.

Đề xuất chuẩn hóa rename thành cặp thay đổi đường dẫn tương đương Delete + Add khi so sánh cây cuối cùng, thay vì phụ thuộc vào ngưỡng phát hiện rename của Git.

Bổ sung kiểm thử rename, tên file chứa ký tự đặc biệt và trường hợp đường dẫn di chuyển ra/vào reviewScope.

P1-11 — git hash-object --path không bảo đảm mọi clean filter đều tất định

Việc sử dụng:

Bash
git hash-object --stdin --path="<relPath>"

là hướng đi đúng. Git xác nhận --path áp dụng các filter tương ứng, còn -w mới yêu cầu ghi đối tượng vào object database. 
git-hash-object Documentation

Tuy nhiên, một external clean filter có thể không tất định hoặc có tác dụng phụ. Vì vậy không nên tuyên bố lệnh này bảo đảm tuyệt đối cùng kết quả với git add trong mọi cấu hình.

Cần bổ sung:

Kiểm tra thất bại của filter và chính sách đối với filter không được hỗ trợ.

Chặn khi blob tính lại không bằng Git Index.

Xử lý Git SHA-1 và SHA-256 repository: Git blob OID không mặc nhiên là SHA-256, dù manifest cuối cùng được băm SHA-256.

Phân biệt đọc trạng thái Git với bảo đảm không có tác dụng phụ từ filter bên ngoài.

P1-12 — Code Review phải gắn với chính xác nội dung gửi Mentor

postTestSnapshot.hash đúng không đồng nghĩa nội dung mà Mentor nhận được là đầy đủ.

Hợp đồng cần quy định gói review tối thiểu có mã nguồn/diff tương ứng, đầy đủ file mới, file xóa, metadata, kết quả test và hash. Không được xem hash đơn lẻ là bằng chứng Mentor đã xem nội dung.

Nếu payload bị cắt bớt, có lỗi đọc file hoặc thiếu dữ liệu quan trọng thì không cấp CODE_APPROVED.

P1-13 — Rollback chưa bảo đảm khả năng phục hồi như mô tả

Bản v1.1 đã an toàn hơn đáng kể khi loại bỏ reset --hard mặc định.

Tuy nhiên, thư mục os.tmpdir() chưa phù hợp làm nơi lưu checkpoint cần tồn tại qua reboot hoặc cleanup.

Việc chỉ đọc lại SESSION_MAP.json và worktree.patch cũng chưa đủ chứng minh toàn bộ backup chính xác.

Cần bổ sung manifest SHA-256 cho các file backup, bảo vệ quyền truy cập, sao lưu Git Index/staged state khi cần và quy trình thử phục hồi. Không dùng cụm từ Non-Destructive Recovery như một bảo đảm tuyệt đối: git restore vẫn thay thế nội dung của file được chỉ định, còn git revert có thể xảy ra conflict.

P1-14 — Acceptance Criteria của npm test chưa nhất quán

Theo HANDOFF, bộ fs_fault.test.js trước đó có 7 PASS và 1 SKIP hợp lệ.

Vì vậy, yêu cầu 100% PASS cần được diễn đạt rõ:

0 FAIL.

exitCode === 0.

Các SKIP phải được thống kê và có lý do.

21 trường hợp Guard bắt buộc phải thực thi và PASS, không được tính SKIP là PASS.

4. Bộ kiểm thử cần bổ sung

21 test G-1 đến G-21 nên được giữ lại. Tôi đề xuất thêm các trường hợp tập trung vào những lỗi vừa phát hiện.

Test

	

Kịch bản

	

Kết quả




G-22

	

Snapshot worktree, index, commit cùng nội dung đã duyệt

	

Hash bằng nhau




G-23

	

HEAD thay đổi sau code review nhưng trước commit

	

REJECT




G-24

	

CI sử dụng base mới thay vì baseCommitOid đã khóa

	

REJECT




G-25

	

Worker thay verifier trong PR để trả exit 0

	

Trusted CI không chấp nhận




G-26

	

Hoàn thành Task 4, chuyển Task 5 trong RPIR

	

Task binding đúng, approval cũ không được tái sử dụng sai




G-27

	

Symlink trong src/ trỏ vào .agents/scripts/

	

REJECT




G-28

	

Process dừng giữa hai lần ghi feedback và lock

	

FAIL-CLOSED, recovery an toàn




G-29

	

Rename file và di chuyển file qua ranh giới scope

	

Manifest chính xác




G-30

	

Nâng cấp từ legacy Guard khi lock cũ chưa hợp lệ

	

Bootstrap và rollback hoạt động




G-31

	

Git clean filter tạo blob khác snapshot đã duyệt

	

REJECT

Với G-25, kiểm thử unit/mock chỉ xác minh thuật toán. Việc công nhận Tier 2 còn cần kiểm tra cấu hình CI, quyền truy cập và branch protection thực tế.

5. Hướng sửa đổi tối thiểu — Không cần thiết kế lại toàn bộ

Không cần mở rộng roadmap hoặc bổ sung framework mới. Chỉ cần hoàn thiện bốn hợp đồng cốt lõi:

Snapshot Contract v1.2

Bổ sung commit mode, cố định baseCommitOid, quy định canonical representation thống nhất và không phụ thuộc HEAD mới.

Independent CI Contract

Verifier và nguồn phê duyệt tin cậy nằm ngoài quyền sửa đổi của Worker; phân biệt CI simulation với enforcement thực tế.

Task & Authorization Contract

Xác định task hiện hành tất định, approval theo task, đường dẫn thực tế sau symlink và phạm vi bảo trì.

Migration & Recovery Contract

Bootstrap có kiểm soát, phát hiện ghi dở, backup có thể xác minh và rollback không phụ thuộc vào Guard đang lỗi.

6. Quyết định RPIR cuối cùng

Gate

	

Quyết định




Design Gate v1.1

	

REJECTED




Cho phép chỉnh sửa CURRENT_PLAN.md

	

YES




Cho phép triển khai Task 4

	

NO




Cho phép chuyển Task 5–7

	

NO




Yêu cầu vòng review tiếp theo

	

Bản v1.2

Chỉ đạo cho Worker Antigravity:

Giữ nguyên mã nguồn. Chỉnh sửa CURRENT_PLAN.md thành bản v1.2, tập trung khắc phục bốn lỗi P0-08 đến P0-11 và P0-12 về quy trình bootstrap, cùng các lỗi P1-09 đến P1-14. Bổ sung các kiểm thử G-22 đến G-31 vào acceptance criteria. Không cần thay đổi các phần v1.1 đã được đánh giá đạt yêu cầu.

Khi gửi lại, cần mô tả rõ cơ chế so sánh worktree → index → commit, cách xác thực nguồn approval trong CI và cách nâng cấp chính Guard mà không tự khóa hệ thống.

Kết luận: Bản v1.1 tiến bộ rõ rệt so với vòng 1, nhưng chỉ nên được thông qua khi chứng minh được rằng commit thực tế chính là snapshot đã review, CI không phụ thuộc vào verifier do Worker kiểm soát, và các task có thể chuyển tiếp mà không làm sai lệch quyền phê duyệt.
