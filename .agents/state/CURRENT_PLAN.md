# KẾ HOẠCH THIẾT KẾ CHI TIẾT (BẢN SỬA ĐỔI v1.1) — TASK 2: Bộ Kiểm thử Tự động `todo.test.js`

> **Trạng thái tài liệu**: Bản thiết kế kỹ thuật v1.1 cho Task 2 (`todo.test.js` trong thư mục mã nguồn), đã khắc phục triệt để **5 BLOCKER (01 -> 05)** và tích hợp toàn bộ **7 cải tiến kỹ thuật** từ đánh giá v1.0 của ChatGPT Mentor.
> **Phạm vi**: Sử dụng 100% Node.js thuần (CommonJS: `assert/strict`, `fs`, `path`, `os`, `child_process`), không cài đặt bất kỳ thư viện kiểm thử bên ngoài nào, giữ nguyên 8 nhóm nghiệm thu, 13 thành phần export và không mở rộng phạm vi sang refactor `todo.js`.

---

## 1. Mục tiêu & Phạm vi

Xây dựng script kiểm thử tự động độc lập `todo.test.js` nhằm xác minh toàn diện tính đúng đắn, độ tin cậy và khả năng chống lỗi của module `todo.js` theo đúng hợp đồng kiến trúc v2.1:
1. Kiểm tra đầy đủ **13 thành phần export** của `todo.js`:
   `VALID_FILTERS`, `resolveStoragePath`, `isValidIsoTimestamp`, `parseTaskId`, `validateTaskList`, `loadTasks`, `saveTasks`, `addTask`, `listTasks`, `completeTask`, `removeTask`, `deleteTask`, `runCli`.
2. Đảm bảo bao phủ trọn vẹn **8 nhóm kịch bản nghiệm thu bắt buộc** (Core CRUD & Filter, ID Reuse Contract, Corrupted JSON/Schema/Calendar Preservation, Idempotency, Clock-Rollback Consistency, Strict ID Validation, Storage & CLI Isolation, Safe Write Failure & Temp Cleanup).
3. Tự kiểm chứng chính bộ điều phối kiểm thử (**Test Runner Self-Verification**) trên cả luồng thành công (`PASS`), luồng thất bại có chủ đích (`FAIL`), khôi phục mock khi test lỗi, và xử lý lỗi dọn dẹp (`Cleanup Failure`).

---

## 2. Kiến trúc Bộ Kiểm thử & Giải quyết Các Blocker Kiến trúc

### 2.1. Chính sách Dọn dẹp An toàn & Bảo toàn Lỗi Gốc (`withTempWorkspace` — Khắc phục BLOCKER 04)
- Tạo thư mục tạm riêng biệt cho từng test case bằng `fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'))` và `filePath = path.join(tempDir, 'tasks.json')`.
- **Không** gọi `fs.rmSync(tempDir, { recursive: true, force: true })` trần trong `finally` để tránh việc lỗi cleanup che khuất lỗi kiểm thử ban đầu hoặc bị bỏ qua âm thầm:
  ```js
  function withTempWorkspace(fn, rmSyncImpl = fs.rmSync) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'));
    const filePath = path.join(tempDir, 'tasks.json');
    let testError = null;
    let result;

    try {
      result = fn({ tempDir, filePath });
    } catch (err) {
      testError = err;
    }

    let cleanupError = null;
    try {
      rmSyncImpl(tempDir, { recursive: true, force: true });
      if (fs.existsSync(tempDir)) {
        throw new Error(`Thư mục tạm vẫn còn tồn tại sau khi xóa: ${tempDir}`);
      }
    } catch (err) {
      cleanupError = new Error(
        `[Cleanup Failure tại ${tempDir}]: ${err && err.message ? err.message : String(err)}`
      );
    }

    if (testError && cleanupError) {
      // Bảo toàn lỗi gốc testError làm lỗi chính, đồng thời báo cáo rõ lỗi cleanup riêng biệt
      testError.cleanupError = cleanupError;
      testError.message = `${testError.message}\n  [Lỗi Cleanup kèm theo]: ${cleanupError.message}`;
      throw testError;
    }

    if (testError) {
      throw testError;
    }

    if (cleanupError) {
      // Tuyệt đối không báo PASS nếu cleanup thất bại
      throw cleanupError;
    }

    return result;
  }
  ```
- **Đảm bảo 5 bất biến của BLOCKER 04**:
  1. Bảo toàn lỗi gốc (`testError`) của test case.
  2. Báo cáo lỗi cleanup riêng biệt (`[Lỗi Cleanup kèm theo]` hoặc `testError.cleanupError`).
  3. Test runner bắt lỗi theo từng test case nên vẫn tiếp tục chạy các test còn lại.
  4. Không bao giờ báo `[PASS]` nếu `cleanupError` xảy ra.
  5. Không âm thầm bỏ qua bất kỳ lỗi dọn dẹp nào.

### 2.2. Hợp đồng `process.exitCode` & Hàm Bắt Luồng CLI (`captureCliExecution` — Khắc phục BLOCKER 02)
- **Xác định chính xác hợp đồng `todo.js` v2.1**:
  - Đối chiếu trực tiếp với thiết kế `CURRENT_PLAN.md` v2.1 (Mục 5) và mã nguồn `todo.js` (dòng 428–510):
    - **Chính hàm `runCli(args, filePath)` chịu trách nhiệm trực tiếp thiết lập `process.exitCode = 1` khi thất bại**:
      - Khi thiếu lệnh (`args.length === 0`) hoặc rơi vào `catch (err)`: `runCli()` ghi thông báo lỗi qua `console.error(...)`, **trực tiếp gán `process.exitCode = 1`**, và trả về mã trạng thái `1`.
      - Khi lệnh hợp lệ (`help`, `add`, `list`, `done`/`complete`, `remove`/`delete`): `runCli()` trả về mã trạng thái `0` và **không chạm vào `process.exitCode`** (giữ nguyên giá trị hiện có của `process.exitCode`).
    - **Entry point `if (require.main === module)`**: Chỉ gọi `runCli(process.argv.slice(2))` và để tiến trình Node.js tự kết thúc với `process.exitCode` do `runCli()` đã thiết lập.
- **Thiết kế `captureCliExecution(fn)` kiểm tra `process.exitCode` trước khi khôi phục**:
  ```js
  function captureCliExecution(fn) {
    const prevLog = console.log;
    const prevError = console.error;
    const prevExitCode = process.exitCode;
    const stdoutLines = [];
    const stderrLines = [];

    console.log = (...args) => stdoutLines.push(args.map(String).join(' '));
    console.error = (...args) => stderrLines.push(args.map(String).join(' '));
    process.exitCode = undefined;

    let returnValue;
    let exitCodeAfter;
    try {
      returnValue = fn();
      // Ghi nhận process.exitCode ngay sau khi fn() chạy xong, TRƯỚC khi khôi phục
      exitCodeAfter = process.exitCode;
    } finally {
      console.log = prevLog;
      console.error = prevError;
      process.exitCode = prevExitCode;
    }

    return {
      returnValue,
      exitCodeAfter,
      stdoutLines,
      stderrLines,
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines.join('\n'),
    };
  }
  ```

### 2.3. Bộ Điều phối Kiểm thử & Bất biến Định lượng (`runTestSuite` — Khắc phục BLOCKER 05)
- `runTestSuite(tests, options = { silent: false, setExitCode: true })`:
  - Duyệt tuần tự qua toàn bộ mảng `tests` (`{ name, fn }`).
  - Với mỗi test case:
    - Tăng `executed += 1`.
    - Thực thi `fn()` trong khối `try / catch (err)`.
    - Nếu không lỗi: `passed += 1`, in `[PASS] ${name}` (nếu `!options.silent`).
    - Nếu có lỗi: `failed += 1`, lưu `{ name, error: err, message: err.message, stack: err.stack }` vào mảng `failures`, in `[FAIL] ${name}: ${err.message}` ra `console.error` (nếu `!options.silent`).
  - Sau vòng lặp, kiểm tra các bất biến định lượng bắt buộc bằng `assert.strictEqual`:
    - `executed === tests.length` (số lượng test được đăng ký bằng đúng số lượng test đã chạy).
    - `passed + failed === total` (với `total = tests.length`).
  - Tính `suiteExitCode = failed > 0 ? 1 : 0`. Nếu `options.setExitCode === true` và `failed > 0`, đặt `process.exitCode = 1`.
  - Trả về `{ total, executed, passed, failed, failures, exitCode: suiteExitCode }`.

---

## 3. Ma trận Các Kịch bản Kiểm thử Chi tiết (8 Nhóm Nghiệm thu)

### Nhóm 1: Nghiệp vụ Cơ bản, Bộ lọc & Cấu hình Lưu trữ (`addTask`, `listTasks`, `removeTask`, `resolveStoragePath`)
- **T1.1 — Kiểm tra tập hằng số và toàn bộ 13 exports**:
  - Xác nhận `VALID_FILTERS` là `Set` có `size === 3`, chứa đúng `'all'`, `'pending'`, `'completed'`.
  - Xác nhận `deleteTask === removeTask` và cả 13 thành phần export đều đúng kiểu hàm/đối tượng.
- **T1.2 — Thứ tự ưu tiên của `resolveStoragePath()`**:
  - Có `customPath` (kể cả có khoảng trắng `'  ./custom/tasks.json  '`) -> ưu tiên `path.resolve(customPath.trim())`.
  - Không truyền `customPath` (hoặc truyền chuỗi rỗng `'   '`), có `process.env.TODO_FILE` -> ưu tiên `path.resolve(process.env.TODO_FILE.trim())`.
  - Không có cả hai -> trả về `path.resolve(process.cwd(), 'tasks.json')`.
  - Khôi phục `process.env.TODO_FILE` về trạng thái ban đầu trong `finally`.
- **T1.3 — Chu trình CRUD cơ bản (`addTask`, `listTasks`, `completeTask`, `removeTask`)**:
  - Khi file chưa tồn tại: `loadTasks(filePath)` và `listTasks('all', filePath)` trả về `[]` và **không** tạo file trên đĩa (`fs.existsSync(filePath) === false`).
  - Thêm 2 task (`'  Viết báo cáo  '`, `'Họp nhóm'`): kiểm tra `title` được `.trim()`, `id` tăng `1, 2`, `completed: false`, `createdAt` chuẩn ISO 8601, `completedAt: null`.
  - Kiểm tra `addTask` từ chối tiêu đề không hợp lệ (`''`, `'   \t\n '`, `null`, `undefined`, `123`), ném `Error` và giữ nguyên nội dung file trên đĩa (`Buffer.compare`).
  - Đánh dấu hoàn thành task `#1`: kiểm tra `listTasks('all')` (2 phần tử), `listTasks()` mặc định (2 phần tử), `listTasks('pending')` (chỉ có `#2`), `listTasks('completed')` (chỉ có `#1`).
  - Xóa task `#1` qua `removeTask(1, filePath)` và xóa task `#2` qua alias `deleteTask('2', filePath)`: kiểm tra giá trị trả về đúng là task vừa xóa và danh sách lưu trữ trở về `[]`.
- **T1.4 — Kiểm tra bộ lọc không hợp lệ của `listTasks()`**:
  - Truyền `'invalid'`, `'done'`, `''`, `null`, `123`, `{}` vào `listTasks(filter, filePath)` -> bắt buộc ném `Error` với thông báo chứa `'Bộ lọc không hợp lệ'`.

---

### Nhóm 2: Chiến lược Cấp phát & Tái sử dụng ID (`ID Strategy & Reuse Contract`)
- **T2.1 — Xóa phần tử ở giữa danh sách (Không tái sử dụng ID bị khuyết ở giữa)**:
  - Tạo 3 task có ID `[1, 2, 3]`, xóa task `#2` (`removeTask(2, filePath)`), danh sách còn `[1, 3]`.
  - Gọi `addTask('Task mới sau khi xóa giữa', filePath)` -> xác minh task mới nhận `id === 4` (`max(1, 3) + 1`), không cấp trùng hay quay lại `2`.
- **T2.2 — Xóa phần tử có ID lớn nhất ở cuối (Tái sử dụng ID lớn nhất vừa xóa)**:
  - Từ danh sách đang có ID `[1, 3, 4]`, xóa `id = 4` (`removeTask(4, filePath)`), còn `[1, 3]`.
  - Gọi `addTask('Task tái sử dụng maxId', filePath)` -> xác minh task mới nhận lại `id === 4` (`max(1, 3) + 1 = 4`).
- **T2.3 — Xóa toàn bộ danh sách (Reset ID về `1`)**:
  - Xóa hết các phần tử còn lại trong danh sách để file chứa `[]`.
  - Gọi `addTask('Task khởi đầu lại', filePath)` -> xác minh task mới nhận `id === 1`.
- **T2.4 — Chặn tràn số nguyên an toàn (`Number.MAX_SAFE_INTEGER`)**:
  - Ghi trước vào file một task hợp lệ có `id: Number.MAX_SAFE_INTEGER`, lưu `beforeBuf = fs.readFileSync(filePath)`.
  - Gọi `addTask('Tràn ID', filePath)` -> xác minh ném `Error('Không thể cấp phát ID mới: vượt quá giới hạn số nguyên an toàn')` và `Buffer.compare(fs.readFileSync(filePath), beforeBuf) === 0`.

---

### Nhóm 3: Bảo vệ Dữ liệu khi JSON Hỏng, Sai Schema, Ngày Lịch Không Tồn tại hoặc Trùng ID
- **T3.1 — Kiểm thử đơn vị hàm `isValidIsoTimestamp()` (Tích hợp cải tiến biên ngày/giờ/offset)**:
  - **Chấp nhận**:
    - UTC & mili/nano giây: `'2026-11-06T20:40:00.000Z'`, `'2026-11-06T20:40:00Z'`, `'2026-11-06T20:40:00.123456789Z'`, biên cuối ngày `'2026-12-31T23:59:59.999Z'`, biên đầu năm `'2026-01-01T00:00:00.000Z'`.
    - Timezone offsets hợp lệ & biên: `'2026-11-06T20:40:00+07:00'`, `'2026-11-06T00:00:00+00:00'`, `'2026-06-15T12:30:00+23:59'`, `'2026-06-15T12:30:00-23:59'`, `'2026-04-30T23:59:59-05:30'`.
    - Năm nhuận hợp lệ: `'2024-02-29T12:00:00.000Z'` (chia hết cho 4), `'2000-02-29T00:00:00.000Z'` (chia hết cho 400).
  - **Từ chối**:
    - Ngày lịch không tồn tại: `'2026-02-30T00:00:00.000Z'`, `'2025-02-29T00:00:00.000Z'` (năm thường), `'1900-02-29T00:00:00.000Z'` (năm thế kỷ không chia hết cho 400), `'2026-04-31T00:00:00.000Z'`, `'2026-06-31T00:00:00.000Z'`, `'2026-09-31T00:00:00.000Z'`, `'2026-11-31T00:00:00.000Z'`, `'2026-00-15T00:00:00.000Z'`, `'2026-13-01T00:00:00.000Z'`, `'2026-01-00T00:00:00.000Z'`, `'2026-01-32T00:00:00.000Z'`.
    - Biên giờ/phút/giây/offset không hợp lệ: `'2026-11-06T24:00:00.000Z'`, `'2026-11-06T23:60:00.000Z'`, `'2026-11-06T23:59:60.000Z'`, `'2026-11-06T10:00:00+24:00'`, `'2026-11-06T10:00:00-24:00'`, `'2026-11-06T10:00:00+00:60'`, `'2026-11-06T10:00:00-05:60'`.
    - Sai định dạng hoặc sai kiểu: `'2026-11-06'`, `'2026-11-06T20:40:00'` (thiếu Z/offset), `''`, `1700000000000`, `null`, `undefined`, `{}`, `new Date()`.
- **T3.2 — Bảo toàn nguyên vẹn Byte-for-Byte (`Buffer.compare`) với các mẫu lỗi Đơn biến (`Single-Fault Mutation`)**:
  - Định nghĩa hàm `createBaseValidTask(overrides = {})` trả về một đối tượng task chuẩn 100%, mỗi mẫu kiểm thử chỉ làm sai lệch **đúng 1 tiêu chí duy nhất**:
    1. File rỗng (`''` và `'   \n\t '`).
    2. JSON hỏng cú pháp (`'[{"id":1,"title":"Broken"'`).
    3. Gốc JSON không phải mảng (`'{"id":1}'`).
    4. Phần tử mảng không phải plain object (`'[null]'`, `'[[1]]'`, `'["str"]'`).
    5. Chỉ sai `id` (`id: 0`, `id: -1`, `id: 1.5`, `id: "1"`).
    6. Chỉ trùng `id` (2 task hợp lệ nhưng cùng `id: 1`).
    7. Chỉ sai `title` (`title: ""`, `title: "   "`, `title: 123`).
    8. Chỉ sai `completed` (`completed: "false"`, `completed: 0`, `completed: null`).
    9. Chỉ sai `createdAt` (`createdAt: "2026-02-30T00:00:00.000Z"`).
    10. Chỉ sai `completedAt` khi `completed: false` (`completedAt: "2026-11-06T20:40:00.000Z"` thay vì `null`).
    11. Chỉ sai `completedAt` khi `completed: true` (`completedAt: null` hoặc `"2026-02-30T00:00:00.000Z"`).
    12. Chỉ vi phạm thứ tự thời gian `completedAt < createdAt` (`createdAt: "2026-11-06T20:40:00.000Z"`, `completed: true`, `completedAt: "2026-11-06T20:39:59.999Z"`).
  - Với từng mẫu lỗi:
    - Lưu `const beforeBuffer = fs.readFileSync(filePath)`.
    - Xác minh `loadTasks(filePath)`, `listTasks('all', filePath)`, `addTask('New', filePath)`, `completeTask(1, filePath)`, `removeTask(1, filePath)` đều ném `Error`.
    - Xác minh `Buffer.compare(fs.readFileSync(filePath), beforeBuffer) === 0` (bảo toàn tuyệt đối byte-for-byte trên đĩa).

---

### Nhóm 4: Tính Lũy đẳng (`Idempotency`) của `completeTask()` (Khắc phục BLOCKER 03)
- **T4.1 — Hoàn thành lần thứ hai không đổi `completedAt`, không thay đổi `Buffer` file và không chạm vào bất kỳ thao tác ghi đĩa nào**:
  1. Tạo task mới (`task = addTask('Kiểm tra idempotent', filePath)`) và gọi hoàn thành lần 1 (`firstDone = completeTask(task.id, filePath)`).
  2. Xác nhận `firstDone.completed === true` và `isValidIsoTimestamp(firstDone.completedAt) === true`.
  3. Lưu nguyên vẹn nội dung file dưới dạng `Buffer`: `const beforeBuffer = fs.readFileSync(filePath)`.
  4. Cài đặt bộ chặn có kiểm soát (controlled write-path spy/guard) cho toàn bộ các thao tác ghi thuộc hợp đồng `saveTasks` (`fs.writeFileSync`, `fs.renameSync`, `fs.unlinkSync`, `fs.mkdirSync`, `fs.appendFileSync`, `fs.openSync`):
     - Nếu bất kỳ hàm nào trong số này được gọi với đường dẫn nằm trong `tempDir` (hoặc `filePath`): tăng `writeAttemptCount += 1` và ném lỗi `new Error('Vi phạm Idempotency: completeTask lần 2 không được ghi đĩa')`.
  5. Trong khối `try`:
     - Gọi `const secondDone = completeTask(task.id, filePath)`.
  6. Trong khối `finally`:
     - Khôi phục toàn bộ các hàm `fs.*` về trạng thái gốc.
  7. Xác minh:
     - `writeAttemptCount === 0` (chứng minh đường ghi thực tế hoàn toàn không được gọi).
     - `secondDone.completed === true` và `secondDone.completedAt === firstDone.completedAt`.
     - `Buffer.compare(fs.readFileSync(filePath), beforeBuffer) === 0` và `fs.readdirSync(tempDir)` chỉ chứa duy nhất `'tasks.json'`.

---

### Nhóm 5: Kịch bản Đồng hồ Hệ thống bị Lùi (`Clock-Rollback Consistency`)
- **T5.1 — Đánh dấu hoàn thành khi `Date.now()` nhỏ hơn `Date.parse(task.createdAt)`**:
  - Tạo một task mới (`task = addTask('Kiểm tra lùi đồng hồ', filePath)`).
  - Lưu `const originalDateNow = Date.now`.
  - Trong khối `try`:
    - Giả lập đồng hồ hệ thống bị điều chỉnh lùi 60 giây về trước thời điểm tạo task:
      ```js
      const rolledBackMs = Date.parse(task.createdAt) - 60_000;
      Date.now = () => rolledBackMs;
      ```
    - Gọi `const completedTask = completeTask(task.id, filePath)`.
    - Xác minh:
      1. Hàm thực thi thành công, không bị `validateTaskList()` ném lỗi.
      2. `completedTask.completed === true`.
      3. `completedTask.completedAt === task.createdAt` (`Date.parse(completedTask.completedAt) >= Date.parse(task.createdAt)`).
      4. Đọc lại từ đĩa qua `const reloaded = loadTasks(filePath)` thành công 100% và `reloaded[0].completedAt === task.createdAt`.
  - Trong khối `finally`:
    - Khôi phục `Date.now = originalDateNow`.

---

### Nhóm 6: Xác thực Nghiêm ngặt Tham số ID (`parseTaskId` & Bảo toàn File khi ID Lỗi)
- **T6.1 — Kiểm thử toàn diện `parseTaskId()`**:
  - Hợp lệ: `1`, `999`, `'1'`, `'42'`, `Number.MAX_SAFE_INTEGER`, `String(Number.MAX_SAFE_INTEGER)`.
  - Không hợp lệ (bắt buộc ném `Error`): `true`, `false`, `'1e0'`, `'1e5'`, `'0x1'`, `'0b1'`, `'0o1'`, `'01'`, `'007'`, `'+1'`, `' 1'`, `'1 '`, `0`, `-0`, `-1`, `'0'`, `'-1'`, `1.5`, `'1.5'`, `NaN`, `Infinity`, `-Infinity`, `Number.MAX_SAFE_INTEGER + 1`, `'9007199254740992'`, `''`, `'   '`, `null`, `undefined`, `{}`, `[]`, `[1]`.
- **T6.2 — Kiểm tra `completeTask(id)` và `removeTask(id)` khi truyền ID không hợp lệ hoặc không tồn tại (Kèm kiểm tra `Buffer.compare`)**:
  - Khởi tạo trước 1 task hợp lệ trong `filePath` và lưu `const beforeBuffer = fs.readFileSync(filePath)`.
  - Truyền các giá trị ID không hợp lệ (`true`, `'1e0'`, `'01'`, `0`, `-5`, `null`) và ID không tồn tại (`999`) vào `completeTask` và `removeTask`.
  - Sau mỗi lần gọi bị từ chối: xác minh hàm ném `Error` đúng quy định VÀ `Buffer.compare(fs.readFileSync(filePath), beforeBuffer) === 0` (file không hề bị thay đổi).

---

### Nhóm 7: Cô lập Khi Import, Hợp đồng `process.exitCode` của `runCli` & Tiến trình Con (`child_process.spawnSync`)
- **T7.1 — Kiểm chứng tính an toàn khi import `require('./todo')` bằng tiến trình con độc lập (Khắc phục BLOCKER 01)**:
  - Không dùng `require.cache` làm cơ chế cô lập chính.
  - Trong `withTempWorkspace(({ tempDir, filePath }) => ...)`:
    1. Tạo trước file `tasks.json` tại `filePath` (nằm trong `tempDir`) chứa dữ liệu sentinel hợp lệ và lưu `const sentinelBuffer = fs.readFileSync(filePath)`.
    2. Xác định đường dẫn tuyệt đối tới `todo.js`: `const todoModulePath = path.resolve(__dirname, 'todo.js')`.
    3. Khởi chạy một tiến trình Node.js con hoàn toàn mới với `cwd: tempDir`, biến môi trường đã xóa `TODO_FILE`, và `timeout: 10_000`:
       ```js
       const probeScript = [
         'const mod = require(process.env.TARGET_TODO_MODULE);',
         'if (process.exitCode !== undefined) { process.exit(2); }',
         'if (typeof mod.addTask !== "function" || typeof mod.runCli !== "function") { process.exit(3); }',
       ].join(' ');
       const res = childProcess.spawnSync(process.execPath, ['-e', probeScript], {
         cwd: tempDir,
         env: { ...process.env, TODO_FILE: '', TARGET_TODO_MODULE: todoModulePath },
         encoding: 'utf8',
         timeout: 10_000,
       });
       ```
    4. Xác minh toàn diện:
       - `res.error === undefined`, `res.signal === null`, `res.status === 0`.
       - `res.stdout === ''` và `res.stderr === ''` (tuyệt đối không phát sinh stdout/stderr khi nạp module lần đầu).
       - `Buffer.compare(fs.readFileSync(filePath), sentinelBuffer) === 0` (file `tasks.json` sentinel trong `cwd` giữ nguyên từng byte).
       - `assert.deepStrictEqual(fs.readdirSync(tempDir), ['tasks.json'])` (không tạo thêm bất kỳ file ngoài ý muốn nào).
- **T7.2 — Kiểm thử trực tiếp `runCli(args, filePath)` và hợp đồng `process.exitCode` (Khắc phục BLOCKER 02)**:
  - Sử dụng `captureCliExecution`:
    - **Các lệnh thành công**:
      - `['help']`, `['--help']`, `['-h']`.
      - `['add', 'Mua', 'sách', 'Node.js']`.
      - `['list']` (cả khi danh sách trống in `'Danh sách công việc trống.'` và khi có dữ liệu), `['list', 'all']`, `['list', 'pending']`, `['list', 'completed']`, `['list', '--all']`, `['list', '--pending']`, `['list', '--completed']`.
      - `['done', '1']`, `['complete', '2']`.
      - `['remove', '1']`, `['delete', '2']`.
      - Với mọi lệnh thành công: xác minh đồng thời `returnValue === 0`, `exitCodeAfter === undefined` (không làm thay đổi `process.exitCode`), `stderr === ''`, và `stdout` khớp nội dung mong đợi.
    - **Các lệnh thất bại**:
      - `[]` (thiếu lệnh), `['unknown-cmd']` (lệnh không hợp lệ), `['add']`, `['add', '   ']` (thiếu tiêu đề), `['list', 'all', 'extra']` (dư tham số), `['list', 'invalid']`, `['list', '--invalid']` (sai filter), `['done']`, `['done', '1', '2']`, `['done', '01']`, `['done', '999']`, `['remove']`, `['delete', '1', '2']`, `['remove', '1e0']`, `['remove', '999']`.
      - Với mọi lệnh thất bại: xác minh đồng thời `returnValue === 1`, `exitCodeAfter === 1` (`runCli` trực tiếp đặt `process.exitCode = 1`), và `stderr` chứa `'Lỗi:'`.
- **T7.3 — Kiểm thử tích hợp CLI End-to-End qua tiến trình con (`child_process.spawnSync`)**:
  - Đặt `timeout: 10_000` cho mọi lời gọi `spawnSync(process.execPath, [todoModulePath, ...args], { cwd: tempDir, env: { ...process.env, TODO_FILE: filePath }, encoding: 'utf8', timeout: 10_000 })`.
  - Ở mọi bước (`add`, `list --pending`, `done 1`, `list --completed`, `delete 1`, và bước lỗi `done 0x1`):
    - Luôn kiểm tra `assert.strictEqual(res.error, undefined)` và `assert.strictEqual(res.signal, null)`.
    - Kiểm tra `res.status === 0` cho các lệnh hợp lệ và `res.status === 1` (kèm `res.stderr.includes('Lỗi:')`) cho lệnh không hợp lệ.

---

### Nhóm 8: Kịch bản Ghi File Thất bại, Phạm vi Fault Injection & Dọn dẹp File Tạm (`Safe Write Failure & Temp Cleanup`)
- **T8.1 — Tạo thư mục cha tự động & Kiểm tra toàn diện quy ước tên file tạm của `saveTasks()`**:
  - Gọi `addTask` / `saveTasks` vào đường dẫn có thư mục con chưa tồn tại (`nestedFile = path.join(tempDir, 'nested', 'deep', 'tasks.json')`).
  - Xác nhận thư mục được tạo tự động, file `tasks.json` đọc lại hợp lệ.
  - Kiểm tra `entries = fs.readdirSync(path.dirname(nestedFile))`:
    - `assert.deepStrictEqual(entries, ['tasks.json'])`.
    - Không còn bất kỳ file tạm nào khớp tiền tố `.tasks.json.${process.pid}.` hay hậu tố `.tmp`.
- **T8.2 — Mô phỏng lỗi có phạm vi (`Scoped Fault Injection`) khi `fs.renameSync` thất bại (`EACCES` / `EXDEV`)**:
  - Khởi tạo trước 1 task hợp lệ trong `filePath`, lưu `beforeBuffer = fs.readFileSync(filePath)`.
  - Lưu `const originalRenameSync = fs.renameSync`.
  - Trong khối `try`:
    - Chỉ kích hoạt lỗi mô phỏng khi đường dẫn đích thuộc `tempDir` (tránh ảnh hưởng ngoài phạm vi):
      ```js
      fs.renameSync = function scopedMockRenameSync(oldPath, newPath) {
        if (String(newPath).startsWith(tempDir) || String(oldPath).startsWith(tempDir)) {
          const err = new Error('Simulated renameSync EXDEV/EACCES failure');
          err.code = 'EACCES';
          throw err;
        }
        return originalRenameSync.call(this, oldPath, newPath);
      };
      ```
    - Gọi `addTask('Task lỗi khi rename', filePath)`.
    - Xác minh:
      1. Hàm ném ra đúng lỗi gốc có `err.code === 'EACCES'` và thông điệp `'Simulated renameSync EXDEV/EACCES failure'`.
      2. Kiểm tra `fs.readdirSync(tempDir)`: chỉ có duy nhất `['tasks.json']` (khối `catch` của `saveTasks` đã xóa sạch file `.tmp` vừa tạo trước khi `renameSync` lỗi).
      3. `Buffer.compare(fs.readFileSync(filePath), beforeBuffer) === 0` (file gốc nguyên vẹn từng byte).
  - Trong khối `finally`:
    - Khôi phục `fs.renameSync = originalRenameSync`.
- **T8.3 — Mô phỏng lỗi có phạm vi (`Scoped Fault Injection`) khi `fs.writeFileSync` thất bại (`ENOSPC`)**:
  - Tương tự T8.2, chỉ kích hoạt lỗi `ENOSPC` (`Simulated writeFileSync ENOSPC disk full`) khi đường dẫn ghi nằm trong `tempDir`.
  - Xác minh lỗi gốc `ENOSPC` được bảo toàn, `fs.readdirSync(tempDir)` chỉ còn `['tasks.json']` (không sót file `.tmp`), và `Buffer.compare(fs.readFileSync(filePath), beforeBuffer) === 0`.
  - *Ghi chú giới hạn kỹ thuật (Technical Disclaimer)*: T8.2 và T8.3 sử dụng kỹ thuật tiêm lỗi ở tầng hàm JavaScript (`fs.renameSync`, `fs.writeFileSync`) để xác minh luồng rollback, dọn dẹp file tạm và bảo toàn lỗi gốc của `saveTasks()`, không tuyên bố thay thế việc kiểm chứng lỗi phần cứng/filesystem thực tế ở tầng nhân hệ điều hành.

---

### Nhóm Bổ sung (T9): Tự Kiểm chứng Cơ chế Test Runner & Cleanup (`Runner Self-Verification` — Khắc phục BLOCKER 04 & 05)
- **T9.1 — Kiểm chứng định lượng `runTestSuite` trên cả đường thành công (Positive) và đường thất bại (Negative)**:
  - **Kịch bản A (Tất cả PASS)**:
    - Gọi `resPass = runTestSuite([testPass1, testPass2], { silent: true, setExitCode: false })`.
    - Xác minh: `resPass.total === 2`, `resPass.executed === 2`, `resPass.passed === 2`, `resPass.failed === 0`, `resPass.passed + resPass.failed === resPass.total`, `resPass.exitCode === 0`, `resPass.failures.length === 0`.
  - **Kịch bản B (Cố ý tạo 1 assertion thất bại & Kiểm tra khôi phục mock khi test FAIL)**:
    - Tạo biến cờ `let mockState = 'clean'`.
    - Chạy `resFail = runTestSuite([test1Pass, test2IntentionalFailWithMockRestore, test3VerifyMockRestored], { silent: true, setExitCode: false })`, trong đó `test2IntentionalFailWithMockRestore` đổi `mockState = 'dirty'`, khôi phục `mockState = 'clean'` trong `finally`, và ném `assert.fail('Intentional test failure for runner verification')`.
    - Xác minh:
      1. `resFail.total === 3` và `resFail.executed === 3` (runner chạy đủ 3 test, không dừng đột ngột ở test 2).
      2. `resFail.passed === 2`, `resFail.failed === 1`, `resFail.passed + resFail.failed === resFail.total`.
      3. `resFail.exitCode === 1` (khác `0`).
      4. `resFail.failures.length === 1`, `resFail.failures[0].name` khớp tên test 2, `resFail.failures[0].message` chứa `'Intentional test failure for runner verification'`, và có `stack` truy vết.
      5. `mockState === 'clean'` (khôi phục mock không phụ thuộc vào kết quả `PASS`/`FAIL`).
- **T9.2 — Kiểm chứng cơ chế xử lý lỗi Cleanup của `withTempWorkspace`**:
  - **Trường hợp 1 (Test PASS nhưng Cleanup FAIL)**: Truyền hàm `rmSyncImpl` giả lập ném lỗi sau khi xóa thật thư mục tạm -> xác minh `withTempWorkspace` ném lỗi `[Cleanup Failure...]` (không báo PASS).
  - **Trường hợp 2 (Test FAIL và Cleanup cũng FAIL)**: Test ném `new Error('Primary test error')` và `rmSyncImpl` cũng ném lỗi -> xác minh lỗi ném ra vẫn là `Primary test error` (bảo toàn lỗi gốc), đồng thời đính kèm thông tin `[Lỗi Cleanup kèm theo]` và thuộc tính `err.cleanupError`.

---

## 4. Kế hoạch Kiểm chứng Sau khi Cài đặt (Verification Plan — Khắc phục BLOCKER 05)

Sau khi nhận được `STATUS: APPROVED` từ ChatGPT Mentor:
1. Triển khai file `todo.test.js` trong thư mục mã nguồn theo đúng thiết kế v1.1.
2. Thực thi bộ kiểm thử và xác minh đầy đủ các tiêu chí nghiệm thu định lượng:
   - Số lượng test đăng ký bằng chính xác số lượng test đã thực thi (`executed === total`).
   - `passed + failed === total` (với `failed === 0`, `passed === total`).
   - Toàn bộ các bài kiểm thử thuộc 8 nhóm nghiệm thu (T1.1 -> T8.3) và nhóm tự kiểm chứng runner (T9.1 -> T9.2) đều đạt `[PASS]`.
   - Tiến trình kết thúc với mã thoát `exitCode === 0`.
   - Kiểm chứng thực tế đường thất bại qua CLI: chạy một tiến trình con kiểm tra nhánh negative của `runTestSuite` trả về `exitCode === 1` khi có 1 assertion thất bại.
   - Xác nhận thư mục dự án sạch sẽ, không phát sinh file `tasks.json` hay `.tmp` ngoài ý muốn.
3. Sau khi toàn bộ bước kiểm chứng đạt 100%: đánh dấu hoàn thành `[x]` cho Task 2 trong `.agents/state/ROADMAP.md`, đặt lại `.agents/state/MENTOR_FEEDBACK.md` về `STATUS: PENDING` và cập nhật `.agents/state/HANDOFF.md`.
