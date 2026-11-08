# CURRENT_PLAN: Task 3 (v1.2) — Hoàn Thiện Bảo Vệ `withFileLock` (Fail-Closed Quarantine Tuyệt Đối `[P0-01]`, `[NEW-P0-01]` & Xử Lý Lỗi Giải Phóng Khóa `[P1-01]`) + Kiểm Thử Crash & Concurrency Xen Kẽ

## 1. Bối cảnh, Mục tiêu & Giới hạn Hợp đồng
Sau khi hoàn thành **Task 1** và **Task 2**, **Task 3 (v1.2)** giải quyết toàn bộ các hạng mục kỹ thuật còn lại của `src/tech_debt.mjs` và `tests/tech_debt.test.mjs`, đặc biệt khắc phục triệt để 2 điểm chặn `[P0-01]` và `[NEW-P0-01]` theo phản hồi Vòng 2 của `@Software System Architect`:
1. **`[P0-01]` — Nhận diện `Promise` / `thenable` trong vùng kiểm soát ngoại lệ riêng (Đặt `quarantineLock = true` TRƯỚC mọi thao tác có thể ném lỗi)**:
   - Tách hoàn toàn bước thực thi `fn()` và bước kiểm tra kết quả `callbackResult` thành 2 khối `try/catch` độc lập.
   - Khi kiểm tra `callbackResult`:
     - Nếu `callbackResult instanceof Promise`: **đặt `quarantineLock = true` ngay lập tức**, sau đó mới thực hiện gắn handler chống unhandled rejection theo cơ chế best-effort (`try { Promise.prototype.catch.call(callbackResult, () => {}); } catch (_ignore) {}`). Kể cả khi `.catch` bị ghi đè và ném lỗi đồng bộ, `quarantineLock` đã là `true` nên khóa không bao giờ bị giải phóng sớm.
     - Nếu `callbackResult` là object/function khác: đọc thuộc tính `callbackResult.then` trong một khối `try/catch` riêng. Nếu `typeof thenProp === 'function'` **HOẶC nếu chính getter `callbackResult.then` ném ngoại lệ đồng bộ**, lập tức đặt **`quarantineLock = true`** và chuyển sang trạng thái cách ly khóa.
2. **`[NEW-P0-01]` — Loại bỏ hoàn toàn `forceCompromised`, cấm thu hồi khóa `compromised` khi PID sở hữu còn sống**:
   - Không cung cấp bất kỳ cờ boolean nào (như `forceCompromised`) cho phép xóa khóa khi tiến trình giữ khóa vẫn còn sống.
   - `recoverOrphanedLock(filePath)` áp dụng bất biến an toàn tuyệt đối: **Nếu `isProcessAlive(pid) === true`, luôn luôn ném `LOCK_OWNER_ALIVE` và giữ nguyên tệp khóa** (bất kể khóa thường hay khóa `compromised: true`). Khóa cách ly chỉ được thu hồi sau khi xác minh tiến trình `pid` đã kết thúc (`ESRCH`).
3. **Giới hạn hợp đồng cần ghi rõ**:
   - Cơ chế `AsyncFunction` pre-check và Fail-Closed Quarantine bảo vệ mọi trường hợp vi phạm hợp đồng có thể phát hiện được qua chữ ký hàm hoặc giá trị trả về (`AsyncFunction`, `Promise`, `thenable`, hoặc getter `.then` ném lỗi). Cơ chế này không thể tự động phát hiện một hàm đồng bộ khởi chạy tác vụ nền ngầm nhưng cố tình trả về giá trị nguyên thủy (`undefined`/`number`/`string`); do đó không tuyên bố loại bỏ tuyệt đối 100% mọi nguy cơ từ mã nguồn cố tình lách hợp đồng.

---

## 2. Thiết kế Kỹ thuật Chi tiết (`src/tech_debt.mjs`)

### 2.1. Giao thức Fail-Closed Quarantine cho `AsyncFunction` & `Thenable` (`[P0-01]`, `[NEW-P0-01]`, `[P1-03]`)
1. **Kiểm tra `AsyncFunction` trước khi lấy khóa (Pre-Acquisition Check)**:
   - Trước khi gọi `fs.openSync(lockPath, 'wx')`:
     ```js
     if (
       fn.constructor?.name === 'AsyncFunction' ||
       Object.prototype.toString.call(fn) === '[object AsyncFunction]'
     ) {
       const asyncErr = new Error(
         'ASYNC_LOCK_CALLBACK: withFileLock chỉ hỗ trợ hàm đồng bộ; không được truyền AsyncFunction.'
       );
       asyncErr.code = 'ASYNC_LOCK_CALLBACK';
       throw asyncErr;
     }
     ```
2. **Tách biệt vùng thực thi `fn()` và vùng kiểm tra `callbackResult` (`[P0-01]`)**:
   ```js
   let callbackResult;
   let callbackError = null;
   let hasCallbackError = false;
   let quarantineLock = false;

   // Bước A: Thực thi fn()
   try {
     if (cfg.holdDelayMs > 0) {
       sleepSync(cfg.holdDelayMs);
     }
     callbackResult = fn();
   } catch (err) {
     hasCallbackError = true;
     callbackError = err;
   }

   // Bước B: Kiểm tra kết quả trả về trong vùng kiểm soát ngoại lệ riêng (chỉ khi fn() đã trả về)
   if (!hasCallbackError && callbackResult !== null && (typeof callbackResult === 'object' || typeof callbackResult === 'function')) {
     let isAsyncOrSuspect = false;
     try {
       if (callbackResult instanceof Promise) {
         isAsyncOrSuspect = true;
         quarantineLock = true;
         try {
           Promise.prototype.catch.call(callbackResult, () => {});
         } catch (_ignore) {}
         try {
           callbackResult.catch(() => {});
         } catch (_ignore) {}
       } else {
         const thenProp = callbackResult.then;
         if (typeof thenProp === 'function') {
           isAsyncOrSuspect = true;
           quarantineLock = true;
         }
       }
     } catch (_classifyErr) {
       // Bắt cả ngoại lệ từ Proxy getPrototypeOf trap (khi chạy instanceof Promise) lẫn getter .then ([P0-01])
       isAsyncOrSuspect = true;
       quarantineLock = true;
     }

     if (isAsyncOrSuspect) {
       quarantineLock = true;
       try {
         fs.writeFileSync(
           lockPath,
           JSON.stringify({
             pid: process.pid,
             token,
             createdAt: Date.now(),
             compromised: true,
             reason: 'ASYNC_LOCK_CALLBACK',
           }),
           'utf8'
         );
       } catch (_writeQuarantineErr) {
         // Best-effort: kể cả ghi metadata lỗi thì tệp lockPath gốc vẫn còn trên đĩa và quarantineLock vẫn = true
       }
       const asyncErr = new Error(
         'ASYNC_LOCK_CALLBACK: Callback của withFileLock trả về Promise/thenable (hoặc getter .then không an toàn); tệp khóa đã được chuyển sang trạng thái cách ly (quarantine) để ngăn Lost Update.'
       );
       asyncErr.code = 'ASYNC_LOCK_CALLBACK';
       asyncErr.quarantinedLockPath = lockPath;
       hasCallbackError = true;
       callbackError = asyncErr;
     }
   }
   ```
   - **Đảm bảo `[P0-01]`**:
     - Khi `quarantineLock === true`, bước giải phóng khóa `releaseLockFile(lockPath)` bị **bỏ qua hoàn toàn**.
     - Dù `.catch` của Promise bị ghi đè và ném lỗi đồng bộ, hay getter `.then` của đối tượng trả về ném lỗi đồng bộ, `quarantineLock` luôn được gán `= true` trước và tệp `.lock` tuyệt đối không bị xóa.
3. **Bảo vệ khóa cách ly trong `recoverOrphanedLock(filePath)` (`[NEW-P0-01]`)**:
   - Không có bất kỳ tham số `forceCompromised` nào.
   - Quy trình `recoverOrphanedLock(filePath)`:
     1. Đọc và kiểm tra JSON `{ pid, token, createdAt, compromised }` từ `lockPath` (nếu JSON hỏng hoặc `pid` không phải số nguyên dương -> ném `CORRUPT_LOCK_PAYLOAD`).
     2. Kiểm tra `if (isProcessAlive(pid))`:
        - **Luôn luôn ném lỗi `LOCK_OWNER_ALIVE`** (kể cả khi `compromised === true`), giữ nguyên tệp `.lock` trên đĩa.
     3. Chỉ khi `isProcessAlive(pid) === false` (`ESRCH` — tiến trình giữ khóa đã thực sự kết thúc), mới gọi `fs.unlinkSync(lockPath)` và trả về `{ recovered: true, deadPid: pid, token, compromised: Boolean(parsed.compromised) }`.

### 2.2. Xử lý Lỗi Giải phóng Khóa & Bảo toàn Tuyệt đối `callbackError` (`[P1-01]`, `[P1-02]`, `[P2-02]`)
1. **Hỗ trợ `_unlinkSync` và `onReleaseError` trong `validateLockOptions`**:
   - Cho phép truyền `options._unlinkSync` (mặc định `fs.unlinkSync`) và `options.onReleaseError` (mặc định `null`). Nếu truyền giá trị khác `undefined`/`null` mà không phải `function`, ném `INVALID_LOCK_OPTIONS`.
2. **Hàm `releaseLockFile(lockPath, unlinkFn)`**:
   - Chỉ được gọi khi `quarantineLock === false`.
   - Thử gọi `unlinkFn(lockPath)` tối đa **3 lần**:
     - Chỉ retry khi lỗi có `code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'` (chờ `10ms` giữa các lần thử).
     - Với lỗi không tạm thời (`EIO`, `ENOENT`, ...) hoặc khi hết 3 lần thử -> ném `releaseErr` (`code: 'LOCK_RELEASE_FAILED'`, `lockPath`, `attempts`, `cause`).
3. **Bảo toàn `callbackError` ngay cả khi bị `Object.freeze()`**:
   - Nếu xảy ra `releaseError`:
     - Luôn thông báo qua `try { cfg.onReleaseError?.(releaseError, callbackError); } catch (_e) {}`.
     - Nếu `hasCallbackError === true`: thử gán `callbackError.releaseError = releaseError` bên trong `try/catch` riêng (bỏ qua nếu `callbackError` bị `Object.freeze()`), rồi **luôn ném lại chính `callbackError`**.
     - Nếu `hasCallbackError === false`: **ném trực tiếp `releaseError`**.

---

## 3. Kế hoạch Kiểm thử Chi tiết (`tests/tech_debt.test.mjs`)

Giữ nguyên 13 bài kiểm thử (`TD-1`..`TD-13`) và bổ sung **3 bài kiểm thử mới** (`TD-14`, `TD-15`, `TD-16`):
1. **`TD-14 [P0-01, NEW-P0-01, P1-01, P1-02, P1-03, P2-02]`: Kiểm thử vòng đời Fail-Closed Quarantine bằng tiến trình con, ngoại lệ khi kiểm tra `.catch`/getter `.then`, bảo toàn `Object.freeze(callbackError)` và retry giải phóng khóa**:
   - **Kịch bản 1 (`AsyncFunction` pre-check)**: Truyền `async () => {}` -> ném `ASYNC_LOCK_CALLBACK` trước khi lấy khóa, không tạo `.lock`.
   - **Kịch bản 2 (`[P0-01]` Ngoại lệ khi kiểm tra `.catch`, getter `.then` và `Proxy` có trap `getPrototypeOf` ném lỗi)**:
     - Tạo một `Promise` có phương thức `.catch` bị ghi đè ném `new Error('CATCH_THREW')` -> `withFileLock` vẫn đặt `quarantineLock = true`, ném `ASYNC_LOCK_CALLBACK` và **giữ nguyên `.lock` trên đĩa**.
     - Tạo một object có `get then() { throw new Error('THEN_GETTER_THREW'); }` -> `withFileLock` vẫn đặt `quarantineLock = true`, ném `ASYNC_LOCK_CALLBACK` và **giữ nguyên `.lock` trên đĩa**.
     - Tạo một `new Proxy(pendingPromise, { getPrototypeOf() { throw new Error('PROTOTYPE_TRAP'); } })` -> khi `withFileLock` chạy `callbackResult instanceof Promise`, ngoại lệ `PROTOTYPE_TRAP` bị bắt trong `catch (_classifyErr)`, đặt `quarantineLock = true`, ném `ASYNC_LOCK_CALLBACK`, giữ nguyên `.lock` trên đĩa và xác minh Worker B không thể lấy khóa (`LOCK_TIMEOUT`).
   - **Kịch bản 3 (`[P0-01]` & `[NEW-P0-01]` Vòng đời khóa cách ly với tiến trình con Worker A và Worker B)**:
     - Khởi chạy tiến trình con Worker A: bên trong `withFileLock`, callback trả về một `Promise` trì hoãn 250ms (trong đó sau 120ms mới ghi dữ liệu). Ngay khi `withFileLock` của A ném `ASYNC_LOCK_CALLBACK`, tệp `.lock` được giữ ở trạng thái `compromised: true` và tiến trình A vẫn đang sống chờ Promise hoàn tất.
     - Trong lúc tiến trình A còn sống:
       1. Gọi `recoverOrphanedLock(tdFile)` -> xác nhận bị chặn với **`LOCK_OWNER_ALIVE`** (`[NEW-P0-01]`).
       2. Worker B gọi `appendTechDebt(tdFile, ..., { lockOptions: { timeoutMs: 50 } })` -> xác nhận bị chặn với **`LOCK_TIMEOUT`** (`[P0-01]`).
     - Chờ tiến trình con A kết thúc hoàn toàn (`close` event):
       1. Gọi `recoverOrphanedLock(tdFile)` -> xác nhận thu hồi thành công (`recovered: true, deadPid: childA.pid, compromised: true`).
       2. Worker B gọi lại `appendTechDebt(tdFile, ...)` -> ghi thành công mà không xảy ra Lost Update.
   - **Kịch bản 4 (`[P1-01]` & `[P2-02]` Kiểm thử `releaseLockFile` qua `_unlinkSync`)**:
     - *4a (Transient `EPERM`)*: `_unlinkSync` ném `EPERM` 2 lần đầu, thành công ở lần 3 -> `attempts === 3`.
     - *4b (Persistent `EPERM`)*: `_unlinkSync` ném `EPERM` cả 3 lần -> ném `LOCK_RELEASE_FAILED` với `err.attempts === 3` và `err.lockPath === lockFile`.
     - *4c (Non-transient `EIO`)*: `_unlinkSync` ném `EIO` -> dừng ngay ở lần 1 (`err.attempts === 1`) và ném `LOCK_RELEASE_FAILED`.
     - *4d (`Object.freeze(callbackError)` + release failure)*: `fn()` ném `Object.freeze(new Error('FROZEN_ERR'))` và `_unlinkSync` ném `EIO` -> `withFileLock` vẫn ném đúng `'FROZEN_ERR'` và `onReleaseError` nhận được `LOCK_RELEASE_FAILED`.
2. **`TD-15 [P1-02 & P2-01]`: Kiểm thử tiến trình con giữ khóa bị kill thực tế (`child.kill('SIGKILL')`) và khôi phục ngoại tuyến trên Windows/POSIX**:
   - Khởi chạy tiến trình con giữ khóa, chờ tín hiệu `child.locked` có timeout, kiểm tra `recoverOrphanedLock` ném `LOCK_OWNER_ALIVE` khi tiến trình con còn sống, gọi `child.kill('SIGKILL')`, chờ `close` và xác nhận `ESRCH`, sau đó `recoverOrphanedLock` khôi phục thành công.
3. **`TD-16 [P1-03 & P2-01]`: Kiểm thử tranh chấp hỗn hợp `appendTechDebt` và `resolveTechDebt` chạy xen kẽ qua 2 vòng độc lập**:
   - Tạo 6 bản ghi mở (`seed-1`..`seed-6`), chạy 2 vòng liên tiếp (mỗi vòng 3 Worker `append` + 3 Worker `resolve` cùng xuất phát qua startup barrier) và xác minh từng bản ghi trong toàn bộ 18 bản ghi cuối cùng theo `fingerprint`, `summary` và `checked`.

---

## 4. Tiêu chí Nghiệm thu (Acceptance Criteria)
1. `npm test` chạy qua `node:test` đạt **16/16 PASS** (`exitCode === 0`).
2. `npm run test:workflow` đạt **12/12 PASS** (`exitCode === 0`).
3. Đóng toàn bộ các mục nợ kỹ thuật còn mở trong `.agents/state/TECH_DEBT.md` bằng `resolveTechDebt()`.
4. Đạt `CODE_STATUS: APPROVED` ở bước `--mode review-code --task task-3`.
