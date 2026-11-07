# CURRENT_PLAN: Task 2 (v1.1) — Khóa Tệp Liên Tiến Trình (`withFileLock`) Chống Lost Update & Kiểm Thử Tích Hợp End-to-End (`[P1-01]`, `[P1-02]`)

## 1. Bối cảnh, Mục tiêu & Phạm vi Bảo đảm
Ở **Task 1**, cả hai chuyên gia Mentor (`@Software System Architect` và `@Independent QA & Gate Reviewer`) đã phê duyệt module `src/tech_debt.mjs` và ghi nhận 2 hạng mục kỹ thuật cần hoàn thiện ở **Task 2**:
1. **`[P1-02]` — Chống Lost Update khi nhiều tiến trình Worker ghi đồng thời vào `TECH_DEBT.md`**:
   - Bọc toàn bộ chu trình **Read → Modify → Write** của `appendTechDebt()` và `resolveTechDebt()` trong khóa độc quyền liên tiến trình `withFileLock(filePath, fn, options)`.
2. **`[P1-01]` — Xác minh tích hợp thực tế với luồng Review trong bộ bằng chứng `src/` & `tests/`**:
   - Đưa hàm điều phối tiếp nhận báo cáo Mentor và trích xuất nợ kỹ thuật (`ingestMentorTechDebtReport`) vào `src/tech_debt.mjs` (được `.agents/scripts/review_policy.mjs` gọi trực tiếp) để toàn bộ hợp đồng tích hợp nằm trong phạm vi `src/` và `tests/` mà `review_bundle` gửi cho QA Reviewer.

**Phạm vi hệ thống tệp (`[P1-07]`)**:
- `withFileLock` sử dụng cơ chế tạo tệp độc quyền nguyên tử của nhân hệ điều hành (`fs.openSync(lockPath, 'wx')` — `O_CREAT | O_EXCL`), được thiết kế và bảo đảm tính loại trừ tương hỗ (Mutual Exclusion) cho **hệ thống tệp cục bộ (Local POSIX / Windows NTFS)** nơi các Worker Agent chạy trên cùng máy trạm. Không áp dụng cho các hệ thống tệp mạng không hỗ trợ `O_EXCL` nguyên tử (như NFSv3/SMB cũ).

---

## 2. Thiết kế Giao thức Khóa Tệp Nhất quán (Giải quyết Triệt để `[P0-01]`, `[P0-02]`, `[P0-03]`)

### 2.1. Quyết định Kiến trúc: Chọn Phương án A (Strict Mutual Exclusion — Không Tự động Cướp Khóa theo Thời gian)
Theo phân tích của `@Software System Architect` ở Vòng 1:
- Mọi cơ chế tự động thu hồi/cướp khóa dựa trên tuổi tệp (`staleMs`) mà không có nguyên tử CAS (Compare-And-Swap) cấp hệ thống tệp đều dẫn đến 3 lỗi P0:
  - **`[P0-01]`**: Hai tiến trình B và C cùng phát hiện khóa của A quá hạn và cùng gọi `renameSync(lockPath, ...)`, khiến C di chuyển nhầm khóa mới vừa tạo của B -> cả B và C cùng vào vùng găng (Lost Update).
  - **`[P0-02]`**: Tiến trình A còn sống nhưng bị OS tạm dừng hoặc I/O chậm quá ngưỡng `staleMs` sẽ bị tiến trình khác thu hồi khóa ngay khi A đang ở trong vùng găng.
  - **`[P0-03]`**: Trong khối `finally`, việc đọc `token` rồi mới `unlinkSync`/`renameSync` vẫn có khoảng hở TOCTOU nếu tồn tại cơ chế cho phép tiến trình khác cướp khóa của chủ cũ.
- **Giải pháp Kiến trúc (Phương án A)**:
  1. **Loại bỏ hoàn toàn đường tự động cướp khóa theo thời gian (`staleMs`) khỏi `withFileLock()`**:
     - Trong `withFileLock()`, khóa `lockPath` **chỉ được tạo bằng `fs.openSync(lockPath, 'wx')`** và **chỉ được xóa bởi chính tiến trình đã tạo thành công tệp khóa đó** trong khối `finally` của nó.
     - Không có bất kỳ tiến trình chờ (waiter) nào được phép `unlinkSync` hoặc `renameSync` tệp `lockPath` đang tồn tại.
     - **Hệ quả chứng minh tính loại trừ tương hỗ (Mutual Exclusion Proof)**:
       - *Giải quyết `[P0-01]`*: Không tồn tại thao tác `renameSync`/`unlinkSync` cạnh tranh từ các waiter B, C lên `lockPath`. Chỉ duy nhất 1 tiến trình thắng `openSync(lockPath, 'wx')` mới sở hữu khóa tại một thời điểm.
       - *Giải quyết `[P0-02]`*: Tiến trình A đang giữ khóa dù chạy lâu hay bị OS tạm dừng cũng **không bao giờ bị tước khóa** khi chưa kết thúc `fn()` và `finally`. Các tiến trình chờ nếu vượt quá `timeoutMs` sẽ thất bại an toàn (`LOCK_TIMEOUT`) mà không chạm vào khóa hay dữ liệu của A.
       - *Giải quyết `[P0-03]`*: Vì không có tiến trình nào khác được phép thay thế `lockPath` trong suốt thời gian A giữ khóa, tệp `lockPath` tại thời điểm A chạy khối `finally` **chắc chắn 100% vẫn là tệp khóa do chính A tạo ra**. Không tồn tại kịch bản A xóa nhầm khóa của B.
  2. **Cơ chế Khôi phục Ngoại tuyến An toàn khi Tiến trình Crash (`recoverOrphanedLock`)**:
     - Trường hợp hiếm gặp khi tiến trình giữ khóa bị dừng cưỡng bức (`SIGKILL` / mất điện) để lại tệp `.lock` mồ côi được xử lý qua hàm quản trị ngoại tuyến tường minh `recoverOrphanedLock(filePath)`:
     - Hàm này đọc `{ pid, token, createdAt }` từ `lockPath` và kiểm tra trạng thái sống của tiến trình `pid` qua `isProcessAlive(pid)` (`process.kill(pid, 0)`):
       - Nếu `process.kill(pid, 0)` thành công hoặc ném `EPERM` -> tiến trình giữ khóa **vẫn còn sống** -> từ chối thu hồi và ném lỗi `LOCK_OWNER_ALIVE` (bảo vệ tuyệt đối tiến trình đang chạy).
       - Chỉ khi `process.kill(pid, 0)` ném `ESRCH` (*No such process* — tiến trình giữ khóa chắc chắn đã chết) và được gọi ngoại tuyến khi không có Worker đang chạy, hàm mới dọn tệp `.lock` mồ côi.

### 2.2. Hợp đồng Validate Tham số Khóa (`validateLockOptions` — `[P1-05]`)
```js
export const DEFAULT_LOCK_OPTIONS = Object.freeze({
  timeoutMs: 5000,   // Thời gian chờ tối đa để lấy khóa (số nguyên >= 0)
  retryMinMs: 10,    // Khoảng chờ tối thiểu giữa các lần thử lại (số nguyên >= 1)
  retryMaxMs: 30,    // Khoảng chờ tối đa (số nguyên >= retryMinMs)
  holdDelayMs: 0,    // Chỉ dùng cho kiểm thử tranh chấp có kiểm soát (số nguyên >= 0)
});
```
- Hàm `validateLockOptions(options = {})`:
  - Kiểm tra `timeoutMs`, `retryMinMs`, `retryMaxMs`, `holdDelayMs` phải là các số nguyên hữu hạn (`Number.isInteger`), thỏa mãn:
    - `timeoutMs >= 0 && timeoutMs <= 300_000`
    - `retryMinMs >= 1 && retryMinMs <= 10_000`
    - `retryMaxMs >= retryMinMs && retryMaxMs <= 10_000`
    - `holdDelayMs >= 0 && holdDelayMs <= 60_000`
  - Nếu vi phạm bất kỳ điều kiện nào -> ném lỗi ngay lập tức: `new Error('INVALID_LOCK_OPTIONS: ...')`.

### 2.3. Chi tiết Vòng đời `withFileLock(filePath, fn, options = {})` (`[P1-01]`, `[P1-06]`)
1. **Validate đầu vào**:
   - Kiểm tra `filePath` không rỗng, `typeof fn === 'function'`, và gọi `validateLockOptions(options)`.
2. **Khởi tạo khóa nguyên tử & Cleanup khi lỗi ghi Payload (`[P1-06]`)**:
   - `const resolvedTarget = path.resolve(String(filePath));`
   - `fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });`
   - `const lockPath = `${resolvedTarget}.lock`;`
   - Vòng lặp lấy khóa:
     - Thử gọi `const fd = fs.openSync(lockPath, 'wx');`
     - Ngay khi `openSync` thành công, tiến trình hiện tại là **chủ sở hữu duy nhất** của `lockPath`.
     - Thực hiện ghi JSON payload `{ pid: process.pid, token, createdAt: Date.now() }` vào `fd` trong khối `try`:
       - Nếu `fs.writeFileSync(fd, payload, 'utf8')` (hoặc `fs.closeSync(fd)`) bị lỗi đĩa đầy / I/O error: đóng `fd` (nếu còn mở), **xóa ngay `fs.unlinkSync(lockPath)`** trong `catch` trước khi ném lại lỗi để không bao giờ để lại tệp `.lock` rỗng/hỏng (`[P1-06]`).
3. **Phân loại lỗi chính xác khi mở khóa (`[P1-01]`)**:
   - Chỉ coi **`err.code === 'EEXIST'`** là trạng thái khóa đang bận (contention) để chờ và thử lại.
   - Nếu `openSync` ném các lỗi hệ thống/quyền truy cập thực sự (`EACCES`, `EPERM`, `ENOENT`, `EISDIR`, `EROFS`...), **ném thẳng lỗi gốc ngay lập tức** chứ tuyệt đối không retry và không biến thành `LOCK_TIMEOUT`.
4. **Chờ có Jitter & Hết thời gian chờ (`LOCK_TIMEOUT`)**:
   - Khi gặp `EEXIST`:
     - Nếu `Date.now() - startMs >= timeoutMs`: ném lỗi `new Error(\`LOCK_TIMEOUT: Không thể lấy khóa tệp "${lockPath}" sau ${timeoutMs}ms.\`)`.
     - Tính `delayMs = Math.min( rawJitter, Math.max(1, deadlineMs - Date.now()) )` và ngủ đồng bộ qua `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)`.
5. **Thực thi vùng găng & Giải phóng khóa an toàn trong `finally`**:
   - Khi đã giữ khóa: nếu `holdDelayMs > 0` (chế độ test tranh chấp), ngủ `holdDelayMs` trước khi gọi `fn()`.
   - Trong `finally`:
     - Vì chỉ chủ khóa duy nhất mới có quyền xóa `lockPath` (không có cơ chế cướp khóa tự động), gọi `fs.unlinkSync(lockPath)` để giải phóng khóa nguyên tử.

### 2.4. Tích hợp End-to-End với Luồng Review (`ingestMentorTechDebtReport` — `[P1-04]`)
- Bổ sung hàm `ingestMentorTechDebtReport(filePath, report, meta = {}, now = new Date())` ngay trong `src/tech_debt.mjs`:
  - Nhận đối tượng báo cáo mức độ (`{ p1: [...], p2: [...] }`) từ bộ phân tích phản hồi Mentor, tự động gắn nhãn `level: 'P1' | 'P2'`, hợp nhất danh sách và gọi `appendTechDebt(filePath, combined, meta, now)` dưới sự bảo vệ của `withFileLock`.
  - Cập nhật `.agents/scripts/review_policy.mjs` để re-export `withFileLock`, `recoverOrphanedLock`, `ingestMentorTechDebtReport` từ `src/tech_debt.mjs`. Nhờ đó, toàn bộ logic tích hợp nằm trong `src/tech_debt.mjs` và được kiểm증 đầy đủ trong `review_bundle` gửi cho QA Reviewer.

---

## 3. Kế hoạch Kiểm thử Chi tiết (`tests/tech_debt.test.mjs`)

Giữ nguyên 10 bài kiểm thử `TD-1`..`TD-10` và bổ sung **3 bài kiểm thử mới** (`TD-11`, `TD-12`, `TD-13`):
1. **`TD-11 [P1-02] & [P2-01]`: Kiểm thử tranh chấp thực tế đa tiến trình qua 2 giai đoạn (Tổng cộng 9 lượt tiến trình Worker độc lập)**:
   - **Giai đoạn 1 (5 tiến trình `appendTechDebt` song song)**:
     - Dùng `child_process.spawn` khởi chạy đồng thời **5 tiến trình Node.js** cùng chờ tại một rào cản khởi động (startup barrier file) rồi đồng loạt gọi `appendTechDebt()` vào cùng tệp `TECH_DEBT.md` với `lockOptions: { timeoutMs: 10000, holdDelayMs: 40 }` để **ép buộc xảy ra tranh chấp khóa thực sự (`EEXIST` retry)** giữa các tiến trình.
     - Mỗi tiến trình ghi 3 mục riêng (`worker-i-item-1..3`) + 1 mục dùng chung (`shared-item`).
     - Xác minh: cả 5 tiến trình đều thoát với `exitCode === 0`, tổng số bản ghi đúng bằng `5 * 3 + 1 = 16` mục, và **kiểm tra khớp chính xác từng fingerprint SHA-256 của cả 16 bản ghi** (không mất bất kỳ bản ghi nào).
   - **Giai đoạn 2 (4 tiến trình `resolveTechDebt` song song)**:
     - Khởi chạy đồng thời **4 tiến trình Node.js** (cùng dùng startup barrier và `holdDelayMs: 30`) để đóng 4 bản ghi cụ thể theo fingerprint trên cùng tệp `TECH_DEBT.md`.
     - Xác minh: `summarizeTechDebt()` trả về chính xác `total = 16, resolved = 4, open = 12`, đúng 4 fingerprint mục tiêu chuyển sang `checked === true`, và không còn tệp `.lock` hay `.tmp.*`.
2. **`TD-12 [P0-01/P0-02/P0-03/P1-03/P1-05/P1-06]`: Kiểm thử tính toàn vẹn của `withFileLock`, bảo vệ chủ khóa đang chạy lâu, phân loại lỗi và `recoverOrphanedLock`**:
   - **Kịch bản 1 (Tái hiện và chống `[P0-01]`, `[P0-02]`, `[P0-03]`)**: Tiến trình chủ A giữ khóa lâu (`holdDelayMs: 250ms`) trong khi hai waiter B và C cùng cạnh tranh với `timeoutMs: 80ms`:
     - B và C đều ném `LOCK_TIMEOUT` mà **không được đánh cắp hay làm hỏng khóa của A**.
     - Tiến trình A tiếp tục hoàn tất việc ghi vào `TECH_DEBT.md` và giải phóng `.lock` an toàn khi kết thúc.
   - **Kịch bản 2 (`[P1-05]` Validate `LockOptions`)**: Truyền `timeoutMs: -1` hoặc `retryMinMs > retryMaxMs` -> ném lỗi `INVALID_LOCK_OPTIONS`.
   - **Kịch bản 3 (`[P1-03]` Offline Recovery `recoverOrphanedLock`)**:
     - Khi `.lock` chứa `pid: process.pid` (tiến trình còn sống) -> `recoverOrphanedLock` từ chối thu hồi và ném `LOCK_OWNER_ALIVE`, giữ nguyên `.lock`.
     - Khi `.lock` chứa `pid: 999999` (tiến trình đã chết — `ESRCH`) -> `recoverOrphanedLock` trả về `{ recovered: true, deadPid: 999999 }` và dọn sạch `.lock`, cho phép lượt `appendTechDebt` tiếp theo chạy thành công.
3. **`TD-13 [P1-01/P1-04]`: Kiểm thử tích hợp luồng tiếp nhận báo cáo Mentor (`ingestMentorTechDebtReport` -> `appendTechDebt` -> `resolveTechDebt` -> `summarizeTechDebt`)**:
   - Kiểm thử luồng tiếp nhận báo cáo `P1/P2` qua `ingestMentorTechDebtReport` xuyên qua nhiều vòng review, xác minh tính năng lọc nhiễu, nâng mức `P2 -> P1`, khử trùng lặp trước `maxItems`, đóng nợ kỹ thuật và tổng hợp thống kê.

---

## 4. Tiêu chí Nghiệm thu (Acceptance Criteria)
1. `npm test` chạy qua `node:test` đạt **13/13 PASS** (`exitCode === 0`).
2. `npm run test:workflow` đạt **12/12 PASS** (`exitCode === 0`).
3. Đóng toàn bộ các mục P1/P2 đã hoàn thành trong `.agents/state/TECH_DEBT.md` bằng `resolveTechDebt()`.
4. Đạt `CODE_STATUS: APPROVED` ở bước `--mode review-code --task task-2`.
