STATUS: APPROVED

RPIR Design Gate — CURRENT_PLAN.md v1.7
DESIGN APPROVED

Task 4 · AI_WORK-FLOW Level 1.2

Quyết định của Software System Architect + DevOps, Reliability & Cost Engineer: Chấp thuận bản thiết kế v1.7 để triển khai mã nguồn Task 4, trong phạm vi đã được xác định. Không tự động cấp quyền triển khai Task 5–7.

Bản v1.7 đã giải quyết thỏa đáng các điều kiện chặn được nêu trong vòng review v1.6. Những giới hạn về tiến trình ngoài giao thức được công bố rõ, thay vì đưa ra bảo đảm an toàn tuyệt đối không thể thực hiện bằng user-space mutex.

Lưu ý: Đây là phê duyệt thiết kế, chưa phải xác nhận code đã đúng, các bài kiểm thử đã chạy, hoặc hệ thống đã production-ready.

1. Kết quả đối chiếu các điểm chặn

Mã

	

Đánh giá

	

Kết luận




P0-26

	

Unified Cooperative Barrier, kiểm tra hai chiều và recovery mutex fail-closed

	

 Đạt




P0-27

	

Điểm tuyến tính hóa được định nghĩa, CAS có giới hạn rõ, revalidation tại điểm tiêu thụ

	

 Đạt




P0-28

	

R0/R1 pre-check, R2 kiểm tra từng file và giữ journal khi drift

	

 Đạt




P0-29

	

Manifest ba mode, raw Buffer paths, Git attributes và điều kiện tương đương

	

 Đạt




P1-32–35

	

Liveness UNKNOWN, journal validation, canonical governance hash và migration CLI

	

 Đạt

2. Đánh giá kiến trúc
Software System Architect

Thiết kế duy trì được bốn đặc tính quan trọng:

Ranh giới module rõ ràng: Approval State, Snapshot, Transition Recovery và Infrastructure Protection có hợp đồng riêng.

Trạng thái phê duyệt kiểm chứng được: stateRevision, transaction IDs, hash và footer tạo thành chuỗi kiểm tra nhất quán.

Không tự nâng quyền: Migration mặc định đưa trạng thái về PENDING, không sử dụng feedback cũ như một phê duyệt mới.

Không mở rộng hạ tầng không cần thiết: Node.js thuần kết hợp Git CLI vẫn phù hợp với mục tiêu hiện tại.

Việc chuyển phần lõi captureCodeSnapshot() sang Task 4 có làm tăng phạm vi triển khai, nhưng đã được giải thích và giữ nhất quán với yêu cầu nghiệm thu G-22.

DevOps, Reliability & Cost Engineer

Các quyết định fail-closed, xác thực journal trước rollback, khôi phục có kiểm soát và tách trusted verifier khỏi PR worktree phù hợp để triển khai và kiểm thử.

Đặc biệt, bản v1.7 đã phân biệt đúng:

Tier 1: Tính nhất quán giữa các tiến trình hợp tác.

Tier 2: Kiểm chứng độc lập dựa trên cấu hình và bằng chứng GitHub.

Giới hạn: Không tuyên bố chống được tiến trình cục bộ có toàn quyền sửa filesystem hoặc bypass hooks.

3. Lưu ý kỹ thuật bắt buộc trong Implementation Gate

Đây là các điểm cần kiểm chứng khi triển khai, không phải lý do từ chối thiết kế.

Ưu tiên

	

Nội dung cần kiểm chứng




Cao

	

fs.renameSync là điểm công bố trạng thái, nhưng độ bền sau mất điện còn phụ thuộc fsync file và thư mục theo khả năng hệ điều hành.




Cao

	

Kiểm tra mutex theo ownerToken không được xóa khóa của owner khác; phải xử lý file khóa rỗng hoặc hỏng mà không tự thu hồi.




Cao

	

getProcessStartTime() phải có cách so sánh nhất quán trên hệ điều hành hỗ trợ; khi không xác định được phải fail-closed.




Cao

	

captureCodeSnapshot() phải thực sự chỉ đọc repository; mọi Git filter có tác dụng phụ hoặc không tất định cần được nhận diện và xử lý theo hợp đồng.




Cao

	

R2 vẫn có khoảng TOCTOU rất nhỏ giữa kiểm tra hash và rename. Bảo đảm không ghi đè chỉ áp dụng trong trust boundary đã công bố; không được quảng bá là atomic compare-and-replace.




Trung bình

	

G-22, G-37 và G-39 phải chạy đủ các sub-assertions, không được chỉ kiểm tra happy path rồi báo PASS.




Trung bình

	

transitionGovernanceHash phải sử dụng đúng encoding, thứ tự trường và dữ liệu staged đã quy định.

Có một điểm cần chú ý riêng: G-39 đang dùng cụm “Bảo toàn dữ liệu 100% ở cả Pha R0, R1 và R2”. Khi triển khai và viết báo cáo, phải giới hạn tuyên bố này theo trust boundary hợp tác. R2 không bảo đảm tuyệt đối trước writer ngoài giao thức xuất hiện đúng sau lần kiểm tra cuối.

4. Phạm vi triển khai được duyệt

Task 4 — Implementation Authorization

AUTHORIZED

Chỉ được thay đổi mã nguồn trong danh sách đã chấp thuận:

.agents/scripts/verify_guard.mjs.agents/scripts/ask_mentor.mjs.agents/scripts/init_project.mjs.agents/scripts/checkpoint.mjstests/guard_integrity.test.jspackage.json.gitignore

Acceptance Target

30/30 PASS
28 nhóm G thuộc Task 4, tương ứng 30 test cases độc lập; 0 FAIL, 0 SKIP. Tổng regression cuối Task 7: 39 nhóm / 41 cases.

Các file trạng thái và bằng chứng phát sinh từ workflow phải được quản lý đúng các hợp đồng quản trị đã duyệt, không được dùng việc triển khai Task 4 để tự cấp CODE_APPROVED.

5. Quyết định cuối cùng cho Worker Antigravity

RPIR — Implementation Handoff

Copy

PLAN_STATUS: APPROVED

IMPLEMENTATION_AUTHORIZED: YES

APPROVED_VERSION: v1.7

APPROVED_SCOPE: task-4 ONLY

NEXT_GATE: IMPLEMENTATION_REVIEW

Kết luận: Cho phép Worker Antigravity bắt đầu triển khai Task 4 theo CURRENT_PLAN.md v1.7. Sau khi hoàn thành, phải trình bằng chứng git status --short, git diff, mã nguồn thực tế, kết quả chạy kiểm thử và integrity manifest để ChatGPT Mentor thực hiện Implementation Gate độc lập. Chỉ khi gate đó đạt mới được đánh dấu Task 4 hoàn thành.
