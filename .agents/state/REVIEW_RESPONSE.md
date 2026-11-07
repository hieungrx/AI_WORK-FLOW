# REVIEW_RESPONSE — Phản hồi Khắc phục P0 cho Vòng 2 (`task-2-plan`)

- **`[P0-01]` (Race Condition trong cơ chế thu hồi stale lock có thể gây Lost Update)**:
  - **Đã khắc phục triệt để trong `CURRENT_PLAN.md` (Mục 2.1)**: Chuyển sang **Phương án A** theo đúng khuyến nghị của `@Software System Architect` — loại bỏ hoàn toàn việc tự động thu hồi/đổi tên khóa theo tuổi (`staleMs`) trong `withFileLock()`. Mọi tiến trình chờ (waiters B, C) chỉ lấy khóa qua `fs.openSync(lockPath, 'wx')` và không bao giờ gọi `renameSync`/`unlinkSync` lên `lockPath` đang tồn tại, triệt tiêu hoàn toàn cuộc đua giữa B và C.

- **`[P0-02]` (Khóa của tiến trình còn sống có thể bị thu hồi sau 10 giây)**:
  - **Đã khắc phục triệt để trong `CURRENT_PLAN.md` (Mục 2.1 & 2.3)**: Bỏ cơ chế hết hạn khóa theo thời gian (`staleMs`) trong `withFileLock()`. Một tiến trình đang giữ khóa dù thực thi lâu hay bị OS tạm dừng vẫn giữ nguyên quyền độc quyền cho tới khi kết thúc `fn()` và giải phóng khóa trong `finally`. Các waiter vượt quá `timeoutMs` sẽ dừng với `LOCK_TIMEOUT` mà không xâm phạm khóa của tiến trình đang chạy.

- **`[P0-03]` (Ownership-Verified Release vẫn có thể xóa khóa của tiến trình khác do TOCTOU)**:
  - **Đã khắc phục triệt để trong `CURRENT_PLAN.md` (Mục 2.1 & 2.3)**: Do không còn bất kỳ đường tự động cướp khóa nào trong khi chủ khóa đang thực thi `withFileLock()`, tệp `lockPath` tại thời điểm chủ khóa chạy khối `finally` được bảo đảm 100% vẫn là khóa của chính tiến trình đó, loại bỏ hoàn toàn khoảng hở TOCTOU khi giải phóng khóa. Ngoài ra, bổ sung hàm quản trị ngoại tuyến `recoverOrphanedLock(filePath)` có kiểm tra `isProcessAlive(pid)` (`process.kill(pid, 0) === ESRCH`) và chặn bằng lỗi `LOCK_OWNER_ALIVE` nếu tiến trình giữ khóa vẫn đang chạy.

- **Về các góp ý `P1/P2`**:
  - Đã cập nhật kế hoạch bao gồm: phân loại lỗi chỉ retry trên `EEXIST` (`[P1-01]`), startup barrier + `holdDelayMs` và đối chiếu từng fingerprint cho 2 giai đoạn 5 + 4 = 9 lượt tiến trình trong `TD-11` (`[P1-02]`, `[P2-01]`), kiểm thử chủ khóa chạy lâu trước nhiều waiter bị timeout + kiểm thử `recoverOrphanedLock` trong `TD-12` (`[P1-03]`), bổ sung `ingestMentorTechDebtReport` trong `src/tech_debt.mjs` cho `TD-13` (`[P1-04]`), hợp đồng `validateLockOptions` (`[P1-05]`), xóa tệp khóa ngay nếu lỗi ghi payload sau `openSync('wx')` (`[P1-06]`), và nêu rõ phạm vi bảo đảm trên hệ thống tệp cục bộ POSIX/NTFS (`[P1-07]`).
