STATUS: APPROVED

ISSUE STATUS

- [P0-01] RESOLVED — Đã loại bỏ cơ chế tự động thu hồi stale lock bằng renameSync/unlinkSync khi các Worker cạnh tranh. Chỉ một tiến trình có thể tạo khóa thành công qua fs.openSync(lockPath, 'wx') trên hệ thống tệp cục bộ thuộc phạm vi thiết kế.

- [P0-02] RESOLVED — Đã loại bỏ staleMs và mọi cơ chế cướp khóa dựa trên thời gian. Tiến trình giữ khóa lâu hoặc bị tạm dừng không bị các Worker khác thu hồi khóa. Waiter chỉ retry hoặc kết thúc bằng LOCK_TIMEOUT.

- [P0-03] RESOLVED — Trong giao thức Worker thông thường, không còn đường tự động thay thế khóa khi chủ sở hữu đang thực thi fn(). Vì vậy, thao tác unlinkSync(lockPath) trong finally không thể xóa nhầm khóa của Worker khác, miễn là cơ chế phục hồi ngoại tuyến tuân thủ đúng điều kiện bảo trì đã xác định.

BLOCKING (P0)

- Không có.

NON-BLOCKING (P1/P2)

- Không bổ sung P1/P2 mới trong vòng đánh giá này, tuân thủ Convergence Rule.

Đánh giá quyết định kiến trúc

Bản thiết kế v1.1 đã xử lý đúng nguyên nhân gốc của cả ba lỗi P0 ở vòng trước.

Thành phần

	

Kết quả

	

Nhận xét




Atomic lock acquisition

	

Đạt

	

Sử dụng 'wx' phù hợp với phạm vi local filesystem




Strict mutual exclusion

	

Đạt

	

Không cho phép Worker đang chờ cướp khóa




Ownership-safe release

	

Đạt

	

An toàn theo giao thức không thu hồi khóa trực tuyến




Timeout và retry

	

Đạt

	

Giới hạn thời gian, không retry vô hạn




Offline recovery

	

Đạt có điều kiện

	

Phụ thuộc vào việc duy trì trạng thái bảo trì độc quyền




Multi-process testing

	

Đạt về thiết kế

	

Có startup barrier và kiểm tra fingerprint




Review integration

	

Đạt về thiết kế

	

Chuyển logic tích hợp vào src/ để có thể nghiệm thu độc lập

Tài liệu Node.js xác nhận 'wx' từ chối tạo tệp đã tồn tại và process.kill(pid, 0) có thể được sử dụng để kiểm tra sự tồn tại của tiến trình. Những primitive này phù hợp với lựa chọn kiến trúc trong phạm vi đã giới hạn. 
GitHub
+1

Điều kiện cần bảo toàn khi triển khai

Đây là các ràng buộc thực hiện của thiết kế đã duyệt, không phải P0/P1/P2 mới.

1. Recovery thực sự ngoại tuyến: Trước khi gọi recoverOrphanedLock, phải dừng các Worker đang hoạt động và ngăn Worker mới khởi chạy cho đến khi phục hồi hoàn tất. Không được coi một lần kiểm tra PID là cơ chế thay thế cho điều kiện này. Thao tác recovery phải được tuần tự hóa ở cấp vận hành.

2. Khóa lỗi hoặc payload không hợp lệ: Nếu tiến trình crash ngay sau openSync('wx') nhưng trước khi ghi hoàn chỉnh JSON, khóa có thể còn tồn tại mà không chứa PID hợp lệ. Không được tự động xóa loại khóa này chỉ dựa vào tuổi tệp. Cần quy trình xử lý thủ công khi đã xác nhận toàn bộ Worker dừng hoạt động.

3. Không nới rộng phạm vi bảo đảm: Chỉ những thao tác ghi tham gia cùng giao thức withFileLock mới được bảo vệ khỏi Lost Update. Không tuyên bố bảo vệ các chương trình bên ngoài ghi trực tiếp vào TECH_DEBT.md.

4. Không suy diễn kết quả kiểm thử: 13/13 PASS và 12/12 PASS hiện là tiêu chí nghiệm thu, chưa phải kết quả đã được xác minh.

Quyết định cuối cùng

PLAN GATE: APPROVED — Task 2 v1.1

Cho phép chuyển sang Implementation Phase với kiến trúc đã duyệt:

Triển khai withFileLock theo phương án Strict Mutual Exclusion.

Tích hợp khóa vào toàn bộ Read–Modify–Write của appendTechDebt và resolveTechDebt.

Hoàn thiện recoverOrphanedLock cùng quy trình bảo trì ngoại tuyến.

Bổ sung TD-11, TD-12, TD-13 và chạy các bộ kiểm thử hiện có.

Chuyển sang review-code để QA kiểm tra mã nguồn, tính đúng đắn của các kịch bản concurrency và bằng chứng kiểm thử thực tế.

Phạm vi phê duyệt: Phê duyệt thiết kế kỹ thuật CURRENT_PLAN.md v1.1, chưa phải phê duyệt chất lượng code hoặc xác nhận Task 2 hoàn thành.
