STATUS: REJECTED

RPIR — Technical Design Review v1.2
Design Gate: REJECTED
Task 4 / 7
Architect + DevOps

Quyết định: Chưa cấp quyền triển khai Task 4. Bản v1.2 đã giải quyết đáng kể các vấn đề từ hai vòng review trước, nhưng vẫn còn những mâu thuẫn ảnh hưởng trực tiếp đến tính hợp lệ của phê duyệt và quá trình nâng cấp Guard.

Đánh giá này dựa trên nội dung CURRENT_PLAN.md v1.2 được cung cấp, chưa bao gồm kiểm chứng mã nguồn thực tế.

1. Kết quả đánh giá tổng quan

Hạng mục

	

Đánh giá




Per-task RPIR & Active Task

	

Đạt về kiến trúc




Mandatory Approval Footer

	

Đạt về nguyên tắc




Legacy Migration

	

Còn rủi ro tái cấp phê duyệt




Transaction Journal

	

Mâu thuẫn trạng thái




3-Mode Git Snapshot

	

Cần bổ sung hợp đồng




Trusted CI & Tier 2

	

Đã giới hạn phạm vi phù hợp




Dual-Path Protection

	

Đúng hướng




Bootstrap v1.1 → v1.2

	

Chưa an toàn




31 Adversarial Tests

	

Thiếu kiểm thử vòng đời

2. Các lỗi P0 bắt buộc khắc phục
P0-13 — transactionId dùng chung làm mất hiệu lực Plan Approval sau Code Review
Critical

Đây là lỗi logic rõ nhất trong bản v1.2.

Theo mục 3.1.3, STATE_LOCK.json chỉ có một transactionId, trong khi cả hai footer đều phải khớp với lock.transactionId.

Giả sử Task 4 được duyệt kế hoạch và sau đó được duyệt mã nguồn:

Bước 1 — Plan Approved

STATE_LOCK.transactionId = tx-A

PLAN_SHA256 footer TX = tx-A

verifyPlanGuard() PASS

Bước 2 — Code Approved

STATE_LOCK.transactionId = tx-B

CODE_SHA256 footer TX = tx-B

PLAN_SHA256 footer TX vẫn là tx-A

verifyPlanGuard() FAIL

Nếu verifyPreCommitGuard() yêu cầu Plan Approval vẫn hợp lệ, hệ thống có nguy cơ tự chặn commit ngay sau khi duyệt code.

Yêu cầu sửa: Tách biệt transaction identifier của từng loại phê duyệt:

JSON
{
  "planApprovalTxId": "tx-plan-...",
  "codeApprovalTxId": "tx-code-..."
}

verifyPlanGuard() chỉ so sánh footer kế hoạch với planApprovalTxId. verifyPreCommitGuard() kiểm tra cả hai giao dịch tương ứng.

Không được dùng một transaction ID toàn cục thay thế cả lịch sử phê duyệt kế hoạch lẫn mã nguồn.

Ngoài ra, phải quy định rõ việc bắt đầu Code Review không làm mất quyền PLAN_APPROVED, còn việc sửa kế hoạch phải vô hiệu hóa cả hai phê duyệt.

P0-14 — Bootstrap có thể tự tạo lại bằng chứng phê duyệt không được Mentor xác nhận
Critical — Approval Integrity

Trong mục 3.4.1, lệnh --bootstrap-v12 được phép:

Đọc MENTOR_FEEDBACK.md và thấy STATUS: APPROVED.

Tính hash từ CURRENT_PLAN.md hiện tại.

Sinh planReviewRequestId và transactionId mới.

Ghi footer mới và chuyển lock sang PLAN_APPROVED.

Điều này không chứng minh nội dung CURRENT_PLAN.md hiện tại chính là nội dung được Mentor duyệt.

Ví dụ: kế hoạch A được duyệt dưới Guard v1.1. Sau đó Worker sửa kế hoạch thành B rồi chạy bootstrap. Nếu bootstrap chỉ kiểm tra dòng STATUS: APPROVED, nó có thể tạo footer cho B dù Mentor chưa từng duyệt B.

Đó chính là dạng sai lệch approval mà Level 1.2 cần loại bỏ.

Yêu cầu sửa:

Bootstrap phải xác minh hash, task ID và bằng chứng phê duyệt v1.1 đã tồn tại trước migration.

Nếu không có bằng chứng ràng buộc nội dung kế hoạch với lần phê duyệt trước, chỉ được chuyển sang PENDING.

Không được tự tạo planReviewRequestId rồi coi đó là ID của một yêu cầu đã được Mentor duyệt.

Phải giữ provenance của approval cũ; không được tái tạo bằng chứng lịch sử bằng cách ký lại nội dung hiện tại.

Nếu muốn nâng lên PLAN_APPROVED sau migration, phải có một lần xác nhận phê duyệt thực sự theo hợp đồng mới.

Quy tắc bắt buộc: Migration có thể chuyển đổi dữ liệu, nhưng không được tự nâng mức độ tin cậy của dữ liệu.

P0-15 — Chuyển Task 4 → Task 5 có nguy cơ chặn chính commit hoàn thành Task 4
High — Workflow Deadlock

Mục 3.1.2 quy định activeTaskId phải trùng với task [ ] đầu tiên trong ROADMAP.md.

Giả sử Worker hoàn thành Task 4 và chuẩn bị commit:

CURRENT_PLAN.md vẫn ghi Active Task: task-4.

STATE_LOCK.json vẫn ghi taskId: task-4.

Worker đánh dấu [x] Task 4 trong ROADMAP.md.

Task chưa hoàn thành đầu tiên trở thành task-5.

Khi pre-commit đọc trạng thái Working Tree, nó có thể phát hiện TASK_ID_MISMATCH và chặn commit Task 4 đã được phê duyệt.

Yêu cầu sửa: Tách biệt hai thao tác:

Hoàn tất Task 4: Code Review Gate kiểm chứng và commit snapshot của Task 4 trong khi activeTaskId vẫn là task-4.

Chuyển sang Task 5: Sau khi commit thành công, thực hiện một governance transition riêng để cập nhật ROADMAP.md, CURRENT_PLAN.md và reset approval cho task mới.

Governance transition phải có hợp đồng riêng, không được tái sử dụng Plan Approval của Task 4 để cấp quyền sửa mã nguồn Task 5.

Bổ sung kiểm thử cho cả pre-commit hợp lệ của Task 4 và chuyển task sau commit, thay vì chỉ kiểm thử từ chối sử dụng lock cũ như G-26 hiện tại.

P0-16 — Task 4 phụ thuộc vào thuật toán Code Snapshot dự kiến chỉ triển khai ở Task 5
Critical — Task Dependency

Theo kế hoạch:

Task 4 triển khai schema v1.2, codeSnapshotHash, baseCommitOid, Code Review Footer và FSM.

Task 5 mới triển khai đầy đủ captureCodeSnapshot() với ba mode.

Tuy nhiên, Task 4 vẫn phải vượt qua Code Review và pre-commit trước khi được đánh dấu hoàn thành.

Câu hỏi kiến trúc chưa được giải quyết trong kế hoạch là:

Task 4 sẽ dùng thuật toán nào để chứng minh mã nguồn được commit chính là mã nguồn đã được review, khi thuật toán snapshot v1.2 chưa tồn tại đầy đủ?

Đặc biệt, Task 4 đang sửa các file bảo mật quan trọng:

Văn bản thuần túy
.agents/scripts/verify_guard.mjs
.agents/scripts/ask_mentor.mjs
.agents/scripts/init_project.mjs
.agents/scripts/checkpoint.mjs

Những file này phải được đưa vào snapshot được review, không chỉ xuất hiện trong allowedPaths.

Yêu cầu sửa: Chọn một trong hai phương án nhất quán:

Phương án A — Khuyến nghị: Task 4 triển khai lõi snapshot tối thiểu đủ hỗ trợ worktree và index, bao gồm file hạ tầng được ủy quyền. Task 5 mở rộng và hoàn thiện commit mode cùng các trường hợp Git phức tạp.

Phương án B: Xây dựng một quy trình bootstrap commit riêng, được phê duyệt tường minh cho giai đoạn chuyển tiếp, trong đó phiên bản Guard tin cậy hiện hữu kiểm chứng mã nguồn Task 4 trước khi kích hoạt cơ chế mới.

Không được ghi CODE_APPROVED với hash kiểu cũ nhưng đặt tên là codeSnapshotHash, cũng không được bỏ kiểm tra snapshot vì Task 4 là maintenance task.

3. Các vấn đề P1 cần bổ sung

ID

	

Vấn đề

	

Yêu cầu chỉnh sửa




P1-15

	

Footer có thể có một dòng hợp lệ và một dòng sai cú pháp không khớp regex

	

Quét mọi footer mang nhãn PLAN_SHA256 hoặc CODE_SHA256; chỉ chấp nhận đúng một footer, đúng cú pháp và đúng vị trí




P1-16

	

allowedPaths và reviewScope chưa có quy tắc hợp nhất đầy đủ cho maintenance task

	

Mọi file hạ tầng được phép sửa phải nằm trong snapshot, review bundle và commit verification




P1-17

	

--trusted-verifier là cờ CLI, không tự tạo trust boundary

	

Xác minh nguồn verifier tại CI bằng cấu hình độc lập; không xem việc truyền cờ là bằng chứng đáng tin cậy




P1-18

	

Backup .agents/backups/ vẫn nằm trong repository

	

Cần làm rõ phạm vi chịu lỗi; nếu yêu cầu phục hồi sau mất hoặc hỏng repo, cần thêm backup ngoài repository




P1-19

	

git write-tree không sao lưu toàn bộ trạng thái Git Index

	

Bổ sung cách bảo toàn staging, untracked files và các metadata cần thiết




P1-20

	

reviewBundleHash được khai báo nhưng chưa quy định đầy đủ cách xác minh

	

Ràng buộc đúng bytes của bundle đã gửi Mentor, phát hiện thiếu file, truncation và hash lệch




P1-21

	

Kiểm tra tất định của clean filters chưa đầy đủ

	

Khóa policy/config liên quan hoặc từ chối khi không thể bảo đảm snapshot và Index tương đương

Lưu ý về Git Index Backup

git write-tree tạo tree object từ Git Index và yêu cầu Index ở trạng thái đã merge hoàn chỉnh. Nó không phải bản sao tuần tự hóa đầy đủ của .git/index. 
git-write-tree Documentation

Do đó, index.tree chỉ nên được xem là một thành phần của backup. Nó không đủ để phục hồi chính xác mọi trạng thái staging, intent-to-add hay untracked files.

Tương tự, git hash-object --stdin --path là lựa chọn hợp lý để áp dụng Git filters trước khi tính blob OID, nhưng cần kiểm tra exit code và xác minh kết quả với Index. 
git-hash-object Documentation

4. Kiểm thử bổ sung bắt buộc

Giữ nguyên G-1 đến G-31. Bổ sung năm kiểm thử tập trung vào lỗi mới thay vì mở rộng không cần thiết sang các subsystem khác.

Test

	

Task

	

Nội dung

	

Kỳ vọng




G-32

	

4

	

Plan Approval tx-A, sau đó Code Approval tx-B

	

Cả hai footer vẫn hợp lệ và pre-commit PASS




G-33

	

4

	

Sửa kế hoạch A thành B trước bootstrap, feedback cũ vẫn APPROVED

	

Không cấp PLAN_APPROVED cho B




G-34

	

4

	

Đánh dấu Task 4 hoàn thành và chuyển sang Task 5

	

Commit Task 4 hợp lệ, transition riêng thành công, approval Task 4 không dùng lại được




G-35

	

4

	

Task 4 sửa verify_guard.mjs, ask_mentor.mjs và test được ủy quyền

	

Mọi file xuất hiện trong snapshot và bundle, staged mismatch bị chặn




G-36

	

4

	

Bootstrap có legacy approval thiếu chứng cứ hash tương ứng với plan hiện hành

	

Chỉ được migration sang PENDING, không tự cấp approval

Bên cạnh các test trên, G-30 cần phân biệt hai tình huống: migration có bằng chứng phê duyệt hợp lệ và migration không đủ bằng chứng. Không được đặt kỳ vọng thành công nâng lên PLAN_APPROVED cho cả hai.

5. Phương án sửa v1.3 tối thiểu

Không cần thiết kế lại toàn bộ kiến trúc hoặc mở thêm task. Để tránh kéo dài vòng review, tôi khuyến nghị sửa đúng bốn hợp đồng trước khi triển khai:

Approval Transaction Contract

Tách planApprovalTxId và codeApprovalTxId; giữ quan hệ hash, request ID và trạng thái độc lập cho từng phê duyệt.

Verified Migration Contract

Bootstrap không tự sinh bằng chứng Mentor approval. Legacy approval thiếu căn cứ phải được chuyển về PENDING.

Per-Task Lifecycle Contract

Phân biệt commit hoàn thành Task 4 với governance transition sang Task 5.

Transitional Snapshot Contract

Task 4 có cơ chế review và khóa đầy đủ các file đã sửa trước khi Task 5 hoàn thiện thuật toán ba mode.

Các điểm P1 còn lại cần được bổ sung thành quy tắc triển khai hoặc acceptance criteria rõ ràng. Không cần thay đổi những thiết kế đã đúng như UTF-8 byte ordering, immutable state file protection, fixed baseCommitOid, hay giới hạn Tier 1/Tier 2.

6. Quyết định cuối cùng của ChatGPT Mentor

Design Gate v1.2

REJECTED

Task 4 Implementation

NOT AUTHORIZED

Task 5–7

HOLD

Bước tiếp theo

CURRENT_PLAN.md v1.3

Chỉ đạo gửi lại Worker Antigravity

Mentor Review Handoff

Sao chép

Giữ nguyên mã nguồn. Chỉ sửa CURRENT_PLAN.md để giải quyết P0-13 đến P0-16, bổ sung các điều kiện P1-15 đến P1-21 và kiểm thử G-32 đến G-36. Sau đó trình lại Design Gate. Không tự chuyển sang Implement.

Kết luận kiến trúc: Bản v1.2 đã tiến gần đến mức có thể triển khai. Bốn điểm chặn hiện tại tập trung vào một vấn đề chung: quyền phê duyệt phải tồn tại nhất quán từ khi lập kế hoạch, qua migration, review code, commit và chuyển sang task tiếp theo. Khi các vòng đời này không còn mâu thuẫn, Task 4 có thể được phê duyệt mà không cần mở rộng thêm kiến trúc.
