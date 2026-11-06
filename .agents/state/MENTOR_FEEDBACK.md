STATUS: APPROVED

DESIGN GATE — TASK 3 | CURRENT_PLAN.md v1.4
DESIGN APPROVED

Phán quyết: ChatGPT Mentor chính thức phê duyệt bản thiết kế kỹ thuật v1.4 của Task 3, cho phép Worker Antigravity chuyển sang giai đoạn Implementation trong quy trình RPIR.

Sau khi đối chiếu với các lần review v1.1, v1.2 và v1.3, hai BLOCKER cuối cùng về Git Index Integrity và Repository Scope Verification đã được giải quyết ở mức thiết kế.

Không phát hiện thêm vấn đề kiến trúc nghiêm trọng cần chặn Design Gate.

1. Kết quả đánh giá tổng thể

Hạng mục

	

Kết quả




T1.5 — Path Containment

	

 APPROVED




T9.1 — Runner Self-Verification

	

 APPROVED




FS-1 — Rename Failure

	

 APPROVED




FS-2 — Pre-write Failure

	

 APPROVED




FS-3 — Temp Creation Failure

	

 APPROVED




FS-4 — Read-only Capability Probe

	

 APPROVED




FS-5 — End-to-End CRUD

	

 APPROVED




PASS / FAIL / SKIP Metrics

	

 APPROVED




Single-Gate Commit Policy

	

 APPROVED




SHA-256 Manifest Determinism

	

 APPROVED




Git Index Integrity

	

 APPROVED




Repository Scope Verification

	

 APPROVED

Kết quả: 12/12 hạng mục đạt Design Gate.

2. Xác nhận hai BLOCKER cuối cùng
BLOCKER 01 — Git Index Integrity
RESOLVED

Bản v1.4 bổ sung đầy đủ cơ chế đối chiếu ba lớp:

Approved Manifest

Nội dung Mentor đã phê duyệt

Git Index

Nội dung thực tế được staging

Expected Commit Content

Nội dung Git chuẩn bị commit

Việc sử dụng git show :<path> để xác minh nội dung trong Git Index, kết hợp kiểm tra các file staged thừa hoặc thiếu, là cách tiếp cận phù hợp.

BLOCKER 02 — Repository Scope Verification
RESOLVED

Bản v1.4 đã xác định:

Kiểm tra toàn bộ repository thay vì chỉ src/ và tests/.

Ghi nhận thao tác thêm, sửa, xóa và đổi tên file.

Chặn thay đổi ngoài phạm vi chưa được phê duyệt.

Đưa package.json và .agents/scripts/ vào phạm vi kiểm soát.

Quản lý riêng các state files để tránh vòng lặp SHA-256.

Không commit trước khi có CODE_STATUS: APPROVED.

Như vậy, hai vấn đề governance từng khiến v1.3 bị từ chối đã được xử lý ở mức thiết kế.

3. Technical Notes — Lưu ý khi triển khai, không chặn phê duyệt

Có ba điểm Worker cần đặc biệt chú ý trong Implementation.

NOTE 01 — Hash nội dung Git phải dựa trên byte thực tế.

Trong bản v1.4, bước Manifest có nhắc tới chuẩn hóa \r\n thành \n.

Đối với integrity hash, nên tính SHA-256 trực tiếp trên dữ liệu Buffer của Git blob, không chuyển đổi line endings trước khi hash. Git có thể tự chuẩn hóa line endings khi đưa file vào Index tùy thuộc .gitattributes và core.autocrlf. 
gitattributes Documentation

Có thể chuẩn hóa văn bản để hiển thị cho Mentor, nhưng hash dùng để khóa commit phải phản ánh byte thực tế đã được phê duyệt.

NOTE 02 — Sử dụng Git Porcelain định dạng an toàn cho script.

Nên sử dụng:

Bash
git status --porcelain=v1 -z -uall

Thay cho cách phân tích output theo dòng thông thường. Tham số -z giúp xử lý đúng tên file chứa dấu cách, ký tự đặc biệt hoặc xuống dòng; -uall giúp liệt kê riêng từng file untracked. Git cũng quy định thứ tự đường dẫn đặc biệt cho rename trong chế độ -z. 
git-status Documentation

Khi xây dựng Manifest, cần chuẩn hóa trạng thái thay đổi so với baseline đã duyệt để việc chuyển file từ unstaged sang staged không tự tạo sai lệch giả.

NOTE 03 — Bổ sung self-test cho Integrity Guard.

Khuyến nghị thực hiện ít nhất bốn kiểm tra âm tính:

Thay đổi file sau khi Mentor APPROVED → Guard từ chối.

Working Tree hợp lệ nhưng Git Index chứa nội dung khác → Guard từ chối.

Staging thêm file ngoài Approved Manifest → Guard từ chối.

Commit đúng manifest và trạng thái lock hợp lệ → Guard cho phép.

Các kiểm tra này không đòi hỏi sửa đổi kiến trúc, nhưng rất quan trọng để xác minh cơ chế guard đã được triển khai đúng.

4. Quy trình triển khai được phê duyệt

Bước 1 — Design Gate

APPROVED

Ghi nhận phê duyệt v1.4 và khóa planSha256 sau khi xác minh đúng nội dung kế hoạch.

Bước 2 — Implementation

Cho phép thực hiện

Triển khai T1.5, T9.1, FS-1 đến FS-5, cập nhật test scripts và Integrity Guard theo bản thiết kế.

Bước 3 — Verification

Bắt buộc trước Review Code

Chạy npm test, kiểm tra PASS/FAIL/SKIP và thực thi các kiểm thử âm tính của Guard.

Bước 4 — Implementation Gate

Chưa phê duyệt

Mentor kiểm tra mã nguồn thực tế, Git diff, snapshot đầy đủ, test evidence và SHA-256 Manifest.

Bước 5 — Commit & Close Task

Chỉ sau CODE_STATUS: APPROVED

Xác minh Git Pre-commit Guard, thực hiện commit và cập nhật ROADMAP/HANDOFF.

5. Phán quyết cuối cùng của ChatGPT Mentor

DESIGN GATE: APPROVED

Kế hoạch v1.4 được chấp thuận để triển khai.

Không yêu cầu sửa sang v1.5 trước khi bắt đầu.

Cho phép ghi nhận STATUS: APPROVED trong MENTOR_FEEDBACK.md.

Cho phép tính và khóa planSha256 theo quy trình hiện hữu.

Chưa cho phép Git commit hoặc đánh dấu Task 3 hoàn thành.

Worker có thể tiếp tục bằng lệnh:

Bash
bash ./.agents/scripts/check_plan_approved.sh

Sau khi triển khai và kiểm thử xong, gửi Implementation Gate bằng:

Bash
node .agents/scripts/ask_mentor.mjs --mode review-code --task task-3

Lưu ý về phạm vi: Đây là phê duyệt thiết kế, không phải nghiệm thu mã nguồn. Tính đúng đắn của 13 exports, các kịch bản lỗi filesystem và cơ chế SHA-256 sẽ được xác nhận bằng bằng chứng thực thi ở vòng Review Code.

Kết luận chính thức: Task 3 — Design Approved, Implementation Authorized.

<!-- PLAN_SHA256: 6dee018e9ed93d320c43e998688f6f33e2eae2df230451882c2d785f31dd41e4 | TASK: task-3 -->