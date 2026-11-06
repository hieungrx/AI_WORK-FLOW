# KẾ HOẠCH THIẾT KẾ CHI TIẾT (BẢN SỬA ĐỔI v1.4) — TASK 3: Giải Quyết Triệt Để 3 Mục Technical Debt (Path Containment, Runner Self-Verification & Real Filesystem Fault Injection)

> **Trạng thái tài liệu**: Bản thiết kế kỹ thuật v1.4 cho Task 3, giải quyết triệt để **2 BLOCKER về SHA-256 Manifest & Git Index Integrity** (bảo đảm tính bất biến giữa Approved Content, Git Index và Commit Content, xử lý trọn vẹn A/M/D/R và kiểm soát phạm vi toàn repository) và bảo toàn 100% các thiết kế kiểm thử kỹ thuật (T1.5, T9.1, FS-1 -> FS-5) cùng chính sách Single-Gate Commit đã được ChatGPT Mentor phê duyệt.
> **Phạm vi**: 100% Node.js thuần (`assert/strict`, `fs`, `path`, `os`, `child_process`), không cài thư viện ngoài, bảo toàn tuyệt đối hợp đồng kiến trúc public API v2.1 của `src/todo.js` (13 exports).

---

## 1. Đối Chiếu & Khắc Phục Các Điểm Chặn từ Vòng Review v1.3

| Mục Hạng mục | Đánh giá từ v1.3 | Giải pháp khắc phục chuẩn hóa trong v1.4 (INTEGRITY CONTRACT) |
| :--- | :--- | :--- |
| **Checklist 1 & 2 (FS-3)** | **APPROVED** | Giữ nguyên 100% thiết kế kỹ thuật: File `tasks.json` ban đầu với 1 task, lưu `beforeBuffer`, gọi `saveTasks()` trên `0o555`, khôi phục quyền trong `finally`, so sánh `Buffer.compare === 0` và xác nhận 0 file `.tmp` rò rỉ. Kiểm chứng lỗi tạo/mở file tạm do quyền thư mục (lỗi ghi dở giữa chừng thuộc `T8.3`). |
| **Checklist 3 (FS-4)** | **APPROVED** | Giữ nguyên 100% thiết kế kỹ thuật: Capability Probe độc lập kiểm tra rename đè file chỉ đọc; probe cho phép rename $\rightarrow$ SKIP có lý do; probe từ chối $\rightarrow$ chạy FS-4; probe hỗ trợ mà không ném lỗi $\rightarrow$ **bắt buộc ghi nhận FAIL, tuyệt đối không chuyển thành SKIP**; kiểm tra `err.syscall === 'rename'`. |
| **Checklist 4 (Runner Metrics)** | **APPROVED** | Giữ nguyên hợp đồng runner: `assert.strictEqual(passed + failed + skipped, total);`, `assert.strictEqual(executed, total);`, `const exitCode = failed > 0 ? 1 : 0;`. Trong đó `executed` là số scenario được runner xử lý; `SKIP` không được tính vào `passed`. |
| **Checklist 5 (No Pre-Approval Commit)** | **APPROVED** | Giữ nguyên chính sách Single-Gate Commit: `ask_mentor.mjs` thu thập toàn bộ thay đổi (staged, unstaged, untracked) thuộc phạm vi Task 3. Tuyệt đối không commit bất kỳ file nào trước khi nhận `CODE_STATUS: APPROVED`. |
| **Checklist 6 — SHA-256 Manifest & Git Index Integrity** | **REJECTED (BLOCKER 01 & 02)** | **Bổ sung INTEGRITY CONTRACT — TASK 3**:<br>1) **Git Index Verification**: Pre-commit Guard đọc staged content thực tế (qua `git show :<path>`) và so sánh SHA-256 với Approved Manifest. Reject nếu khác hash, reject nếu partial staging / thiếu / thừa staged file. Đảm bảo bất biến: `Approved Content SHA-256 == Git Index Content SHA-256 == Expected Commit Content SHA-256`.<br>2) **Xử lý toàn diện trạng thái Git (A/M/D/R)**: Ghi nhận rõ file Added (A), Modified (M), Deleted (D - ghi nhận cờ xóa, không đọc nội dung), Renamed (R - ghi nhận đường dẫn cũ và mới).<br>3) **Repository Scope Verification**: Quét toàn bộ repository (`git status --porcelain=v1`). Phát hiện và CHẶN NGAY mọi thay đổi ngoài phạm vi Task 3 chưa được duyệt (chỉ cho phép các file trạng thái ngoại lệ hợp lệ đã định nghĩa). |

---

## 2. Kiến trúc & Thiết kế Chi tiết Từng Mục

### 2.1. Mục 1: Chuẩn hóa Path Containment (`isInsideDir` trong `src/todo.test.js`)

#### 2.1.1. Công thức chuẩn hóa (Lexical Containment)
```javascript
function isInsideDir(targetPath, parentDir) {
  if (typeof targetPath !== 'string' || typeof parentDir !== 'string') return false;
  const resolvedParent = path.resolve(parentDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedParent, resolvedTarget);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
```

#### 2.1.2. Kịch bản kiểm thử chi tiết (`T1.5` trong `src/todo.test.js`)
Sử dụng `path.join` từ thư mục cơ sở `baseDir = path.resolve(os.tmpdir(), 'todo-containment-check')`:
1. Trùng chính thư mục: `isInsideDir(baseDir, baseDir) === true`.
2. Thư mục con thông thường: `isInsideDir(path.join(baseDir, 'sub'), baseDir) === true`.
3. File con lồng sâu: `isInsideDir(path.join(baseDir, 'sub', 'deep', 'tasks.json'), baseDir) === true`.
4. Thư mục con có tên bắt đầu bằng `..`:
   - `isInsideDir(path.join(baseDir, '..foo'), baseDir) === true`.
   - `isInsideDir(path.join(baseDir, '..cache', 'tasks.json'), baseDir) === true`.
   - `isInsideDir(path.join(baseDir, '...data'), baseDir) === true`.
5. Đường dẫn có chứa `.` hoặc `..` nhưng sau khi chuẩn hóa vẫn nằm trong:
   - `isInsideDir(path.join(baseDir, 'sub', '..', 'sub', 'file.json'), baseDir) === true`.
6. Thư mục cha trực tiếp: `isInsideDir(path.resolve(baseDir, '..'), baseDir) === false`.
7. Thư mục anh em: `isInsideDir(path.resolve(baseDir, '..', 'sibling'), baseDir) === false`.
8. Khác ổ đĩa trên Windows (nếu có): ví dụ `C:\path` so với `D:\path` $\rightarrow$ `false`.
9. Đầu vào không hợp lệ: `null`, `undefined`, số `123`, object `{}`, mảng `[]` $\rightarrow$ `false`.

---

### 2.2. Mục 2: Bổ sung Assertion Định lượng cho Runner Self-Verification (`T9.1` trong `src/todo.test.js`)

Cập nhật `T9.1` đảm bảo kiểm tra định lượng đầy đủ theo đúng góp ý của Mentor:

#### 2.2.1. Nhánh thành công (`passSuite`)
```javascript
assert.strictEqual(passSuite.total, 2);
assert.strictEqual(passSuite.executed, 2);
assert.strictEqual(passSuite.passed, 2);
assert.strictEqual(passSuite.failed, 0);
assert.strictEqual(passSuite.exitCode, 0);
assert.strictEqual(Array.isArray(passSuite.failures), true);
assert.strictEqual(passSuite.failures.length, 0);
assert.strictEqual(passSuite.passed + passSuite.failed, passSuite.total);
```

#### 2.2.2. Nhánh thất bại có chủ đích (`failSuite`)
```javascript
assert.strictEqual(failSuite.total, 3);
assert.strictEqual(failSuite.executed, 3);
assert.strictEqual(failSuite.passed, 2);
assert.strictEqual(failSuite.failed, 1);
assert.strictEqual(failSuite.exitCode, 1);
assert.strictEqual(failSuite.passed + failSuite.failed, failSuite.total);
assert.strictEqual(failSuite.failures.length, 1);
assert.strictEqual(failSuite.failures[0].name, 'Step 2 Intentional Fail');
assert.strictEqual(failSuite.failures[0].message, 'Intentional assertion failure for runner check');
assert.strictEqual(typeof failSuite.failures[0].stack, 'string');
assert.ok(failSuite.failures[0].stack.includes('Intentional assertion failure for runner check'));
assert.strictEqual(mockFlag, 'restored');
```

#### 2.2.3. Nhánh kiểm thử tiến trình con (`childProcess.spawnSync`)
```javascript
assert.strictEqual(childRes.error, undefined);
assert.strictEqual(childRes.signal, null);
assert.strictEqual(childRes.status, 1);
assert.ok(childRes.stderr.includes('[FAIL] Simulated Failing Test'));
assert.ok(childRes.stdout.includes('=== TỔNG KẾT: 1/2 PASS | 1/2 FAIL (Executed: 2) ==='));
```

---

### 2.3. Mục 3: Bộ Kiểm thử Lỗi Filesystem Thực tế Độc lập (`tests/fs_fault.test.js`)

Bộ kiểm thử chạy độc lập, tự quản lý runner mini với hợp đồng bất biến:
- `assert.strictEqual(passed + failed + skipped, total);`
- `assert.strictEqual(executed, total);`
- `const exitCode = failed > 0 ? 1 : 0;`
- Báo cáo rõ danh sách các bài test `PASS`, `FAIL`, và `SKIP` (kèm nguyên nhân kỹ thuật cụ thể).
- Tuân thủ 100% nguyên tắc Isolation: mỗi kịch bản chạy trong một `tempDir = fs.mkdtempSync(...)` riêng, dọn dẹp tài nguyên (quyền file, thư mục) an toàn trong `finally`.

#### Ma trận 5 Kịch bản Kiểm thử Lỗi Thực tế (Không Mock)

```
+-----------------------------------------------------------------------------------+
| Giai đoạn 1: Trước khi ghi tạm (Pre-write / mkdirSync)                             |
| -> Kịch bản FS-2: Thành phần cha trong đường dẫn là một file thường              |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| Giai đoạn 2: Trong khi ghi file tạm (Temp-write / writeFileSync)                  |
| -> Kịch bản FS-3: Thư mục cha không có quyền ghi (POSIX 0555 / Read-only dir)     |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| Giai đoạn 3: Khi thay thế nguyên tử (Atomic Replace / renameSync)                 |
| -> Kịch bản FS-1: Đường dẫn đích là một thư mục đang tồn tại                     |
| -> Kịch bản FS-4: File đích bị đặt thuộc tính Read-Only trên Windows NTFS         |
+-----------------------------------------------------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
| Baseline Verification: Tính toàn vẹn End-to-End trên ổ đĩa vật lý                 |
| -> Kịch bản FS-5: Chu trình CRUD thực tế, kiểm tra không rò rỉ file .tmp          |
+-----------------------------------------------------------------------------------+
```

#### Chi tiết Kịch bản FS-1: Lỗi giai đoạn `renameSync()` khi đích là thư mục
- **Call flow**: Gọi trực tiếp hàm xuất bản `saveTasks(sampleTasks, existingDirPath)`.
  1. `validateTaskList()` hợp lệ.
  2. `targetPath = resolveStoragePath(existingDirPath)`. `dir = path.dirname(targetPath)` (thư mục cha `tempDir`).
  3. `tempPath` được tạo dưới dạng `.${basename}.${pid}.${timestamp}-${rand}.tmp`.
  4. `fs.writeFileSync(tempPath, payload, 'utf8')` thực hiện thành công trên đĩa.
  5. `fs.renameSync(tempPath, existingDirPath)` bị hệ điều hành từ chối thật: ném mã lỗi `EPERM` (Windows) hoặc `EISDIR` (POSIX).
  6. Khối `catch (err)` phát hiện `fs.existsSync(tempPath) === true` và gọi `fs.unlinkSync(tempPath)`.
  7. Lỗi được rethrow ra ngoài.
- **Tiêu chí nghiệm thu**:
  - Lỗi ném ra có `err.code === 'EPERM' || err.code === 'EISDIR'`.
  - Nếu có `err.syscall`: `assert.strictEqual(err.syscall, 'rename')` (chứng minh lỗi xảy ra ở bước rename, không phải trước đó).
  - `fs.statSync(existingDirPath).isDirectory() === true`.
  - Thư mục cha `tempDir` không còn sót bất kỳ file `.tmp` nào (`entries.filter(e => e.endsWith('.tmp')).length === 0`).

#### Chi tiết Kịch bản FS-2: Lỗi giai đoạn trước khi ghi tạm (`mkdirSync`)
- **Setup**: Tạo file thường `const parentFile = path.join(tempDir, 'plain_file.txt'); fs.writeFileSync(parentFile, 'sentinel data', 'utf8'); const beforeBuffer = fs.readFileSync(parentFile);`.
- **Call flow**: Gọi `saveTasks(sampleTasks, path.join(parentFile, 'tasks.json'))`.
  1. `path.dirname(targetPath)` là `parentFile`.
  2. `fs.mkdirSync(parentFile, { recursive: true })` thất bại ngay lập tức: ném `ENOTDIR` (POSIX) hoặc `EEXIST` (Windows).
- **Tiêu chí nghiệm thu**:
  - Lỗi ném ra có `err.code === 'ENOTDIR' || err.code === 'EEXIST'`.
  - File `parentFile` được bảo toàn nguyên vẹn 100% từng byte (`Buffer.compare(beforeBuffer, fs.readFileSync(parentFile)) === 0`).
  - Hoàn toàn không có file `.tmp` nào được tạo ra trên đĩa.

#### Chi tiết Kịch bản FS-3: Lỗi giai đoạn ghi file tạm (`writeFileSync` trên thư mục không có quyền ghi)
- **Capability Probe thực tế**:
  - Tạo `probeDir = path.join(tempDir, 'probe_dir')`, `fs.mkdirSync(probeDir)`, `fs.chmodSync(probeDir, 0o555)`.
  - Thử ghi `probe_file.tmp` vào `probeDir`.
  - Nếu việc ghi thành công (chạy dưới quyền root trên POSIX hoặc Windows NTFS bỏ qua bit 0555): khôi phục quyền `0o755`, xóa probe và ghi nhận `SKIP` cho FS-3 kèm lý do: `"Môi trường không áp dụng giới hạn quyền ghi trên thư mục 0555 (Windows NTFS hoặc POSIX root)"`.
  - Nếu việc ghi thất bại với `EACCES` hoặc `EPERM`: Capability được xác nhận! Tiến hành chạy test FS-3.
- **FS-3 Setup & Execution**:
  - Tạo thư mục `noWriteDir = path.join(tempDir, 'no_write'); fs.mkdirSync(noWriteDir);`.
  - Tạo trước file `tasks.json` hợp lệ với 1 task, lưu `beforeBuffer = fs.readFileSync(filePath)`.
  - Đổi quyền thư mục cha sang `0o555`: `fs.chmodSync(noWriteDir, 0o555);`.
  - Gọi `saveTasks(sampleTasks, filePath)`.
  - Bắt lỗi: xác nhận ném `EACCES` hoặc `EPERM`.
- **Tiêu chí nghiệm thu**:
  - Trong `finally`: khôi phục `fs.chmodSync(noWriteDir, 0o755)`.
  - Đọc lại `filePath` và xác minh bảo toàn nguyên vẹn từng byte: `assert.strictEqual(Buffer.compare(beforeBuffer, fs.readFileSync(filePath)), 0)`.
  - Xác nhận 0 file `.tmp` dở dang bị bỏ lại: `assert.strictEqual(fs.readdirSync(noWriteDir).filter(f => f.endsWith('.tmp')).length, 0)`.
  - **Giới hạn kiểm thử**: FS-3 kiểm chứng lỗi không thể mở/tạo file tạm do quyền thư mục, không mô phỏng lỗi ghi dở giữa chừng (vốn đã được kiểm chứng riêng ở `T8.3` bằng scoped mock).

#### Chi tiết Kịch bản FS-4: Lỗi giai đoạn `renameSync()` với file chỉ đọc trên Windows NTFS
- **Capability Probe độc lập**:
  - Tạo 2 file thử nghiệm độc lập: `probe_dst.txt` (ghi dữ liệu, `chmodSync 0o444`), và `probe_src.tmp` (ghi dữ liệu).
  - Thử `fs.renameSync(probe_src.tmp, probe_dst.txt)`.
  - Nếu thành công (như trên POSIX nơi rename đè lên file chỉ đọc): khôi phục `chmodSync 0o666`, dọn dẹp probe và ghi nhận `SKIP` cho FS-4 kèm lý do: `"Filesystem cho phép rename thay thế file read-only nếu thư mục cha có quyền ghi (hành vi chuẩn POSIX)"`.
  - Nếu thất bại với `EPERM` hoặc `EACCES`: Capability được xác nhận! Tiến hành chạy test FS-4.
- **FS-4 Setup & Execution**:
  - Tạo `tasks.json` ban đầu với 1 task hợp lệ, lưu `beforeBuffer = fs.readFileSync(filePath)`.
  - Đặt `fs.chmodSync(filePath, 0o444)`.
  - Gọi `saveTasks(updatedTasks, filePath)`.
  - Xử lý kết quả:
    - Nếu `saveTasks()` KHÔNG ném lỗi hoặc làm sai lệch file: **ghi nhận FAIL, tuyệt đối không chuyển thành SKIP** (vì capability probe đã xác nhận hệ điều hành có chặn).
    - Khi bắt được lỗi:
      - `assert.ok(err.code === 'EPERM' || err.code === 'EACCES')`.
      - Nếu có `err.syscall`: `assert.strictEqual(err.syscall, 'rename')`.
- **Tiêu chí nghiệm thu**:
  - Trong `finally`: khôi phục `fs.chmodSync(filePath, 0o666)`.
  - So sánh byte-for-byte: `assert.strictEqual(Buffer.compare(beforeBuffer, fs.readFileSync(filePath)), 0)`.
  - Dọn sạch file tạm: `assert.strictEqual(fs.readdirSync(tempDir).filter(f => f.endsWith('.tmp')).length, 0)`.

#### Chi tiết Kịch bản FS-5: Kiểm chứng toàn vẹn End-to-End không rò rỉ file tạm trên đĩa thật
- **Call flow**: Chạy chuỗi thao tác CRUD hoàn chỉnh trên đĩa thật: `saveTasks` $\rightarrow$ `loadTasks` $\rightarrow$ `addTask` $\rightarrow$ `completeTask` $\rightarrow$ `removeTask`.
- **Tiêu chí nghiệm thu**:
  - Sau mỗi thao tác, kiểm tra chi tiết dữ liệu trong `tasks.json` (`id`, `title`, `completed`, `completedAt`).
  - Sau mỗi thao tác, kiểm tra `fs.readdirSync(tempDir).filter(f => f.endsWith('.tmp')).length === 0`.
  - Dữ liệu `tasks.json` lưu đúng chuẩn JSON, có ký tự xuống dòng `\n` ở cuối, các trường dữ liệu hợp lệ 100%.

---

## 3. Cập nhật Cấu hình & Tích hợp Bộ Kiểm thử

### 3.1. Cập nhật `package.json`
```json
"scripts": {
  "test": "node src/todo.test.js && node tests/fs_fault.test.js",
  "ask-mentor": "node .agents/scripts/ask_mentor.mjs"
}
```

### 3.2. Cập nhật `.agents/scripts/ask_mentor.mjs` & Hợp đồng Toàn vẹn (INTEGRITY CONTRACT — TASK 3)

Để loại bỏ triệt để nguy cơ sai lệch giữa nội dung được phê duyệt, dữ liệu trong Git Index và nội dung commit thực tế, hệ thống áp dụng hợp đồng kiểm soát toàn vẹn 5 điểm:

```
+-----------------------------------------------------------------------------------+
|                           INTEGRITY CONTRACT — TASK 3                             |
+-----------------------------------------------------------------------------------+
| 1. Approved Manifest:                                                             |
|    - Đường dẫn file (chuẩn hóa đường dẫn tương đối từ repo root).                |
|    - Trạng thái Git (Added: 'A', Modified: 'M', Deleted: 'D', Renamed: 'R').       |
|    - SHA-256 của nội dung được Mentor duyệt (chuẩn hóa \r\n -> \n).                |
|    - Thông tin file đổi tên (oldPath -> newPath) hoặc bị xóa (D).                 |
|                                                                                   |
| 2. Git Index Verification:                                                        |
|    - Pre-commit Guard đọc trực tiếp nội dung staged từ Git Index qua              |
|      `git show :<path>` hoặc `git ls-files --stage`.                              |
|    - Đối chiếu SHA-256 của từng file staged với Approved Manifest.                |
|    - Bác bỏ (REJECT) nếu staged content khác hash đã được duyệt.                  |
|    - Bác bỏ (REJECT) nếu có file staged bị thiếu, thừa hoặc partial staging.      |
|                                                                                   |
| 3. Repository Scope Verification:                                                 |
|    - Quét toàn bộ thay đổi trên toàn repository (`git status --porcelain=v1`).     |
|    - Bác bỏ (REJECT) bất kỳ thay đổi nào ngoài phạm vi Task 3 chưa được duyệt.    |
|    - Chỉ cho phép các ngoại lệ trạng thái hợp lệ đã định nghĩa rõ:               |
|      .agents/state/STATE_LOCK.json, .agents/state/SESSION_MAP.json,               |
|      .agents/state/CODE_REVIEW_FEEDBACK.md, .agents/state/MENTOR_FEEDBACK.md,     |
|      .agents/state/HANDOFF.md, .agents/state/ROADMAP.md,                          |
|      .agents/state/CURRENT_PLAN.md.                                               |
|                                                                                   |
| 4. Commit Authorization (Điều kiện phê chuẩn Commit):                             |
|    - CODE_STATUS: APPROVED trong CODE_REVIEW_FEEDBACK.md.                         |
|    - planSha256 hợp lệ và khớp STATE_LOCK.json.                                   |
|    - codeSha256 hợp lệ và khớp STATE_LOCK.json.                                   |
|    - npm test thực thi thành công (testExitCode = 0).                             |
|    - Approved Manifest == Commit Manifest (Bất biến tam giác):                    |
|      Approved Content SHA-256 == Git Index Content SHA-256 == Commit Content SHA  |
|                                                                                   |
| 5. Failure Policy:                                                                |
|    - Bất kỳ điều kiện nào sai lệch: DỪNG VÀ CHẶN COMMIT NGAY LẬP TỨC              |
|      (BLOCK COMMIT với exit code khác 0).                                         |
+-----------------------------------------------------------------------------------+
```

#### Chi tiết Thuật toán Manifest Determinism
1. **Thu thập thay đổi toàn bộ Repo**:
   - Sử dụng `git status --porcelain=v1` để liệt kê tất cả các file bị thay đổi (staged, unstaged, untracked).
   - Phân loại file thành: file phạm vi review Task 3 (`src/`, `tests/`, `package.json`, `.agents/scripts/`), file trạng thái ngoại lệ, và file bất thường ngoài phạm vi.
2. **Xây dựng Manifest**:
   - Mỗi file được biểu diễn dưới dạng đối tượng: `{ path, status, sha256 }`.
   - Với file Deleted (`D`): `sha256 = 'DELETED'`.
   - Với file Renamed (`R`): lưu `{ path: newPath, oldPath, status: 'R', sha256 }`.
   - Danh sách file được sắp xếp theo thứ tự từ điển (`localeCompare` hoặc `path < other.path`) để bảo đảm tính tất định 100%.
   - Chuỗi manifest JSON xác định được băm bằng SHA-256 tạo ra `codeSha256`.
3. **Pre-commit Guard Đối chiếu Git Index**:
   - Khi chạy `git commit`, hook `.git/hooks/pre-commit` kích hoạt `verify_guard.mjs --pre-commit`.
   - Guard đọc trực tiếp staged content qua `git show :<stagedPath>` và tính SHA-256 của từng file trong index.
   - So sánh trực tiếp mảng staged manifest với Approved Manifest đã được khóa trong `STATE_LOCK.json`.
   - Nếu phát hiện bất kỳ sự khác biệt nào giữa Working Tree, Git Index và Approved Content $\rightarrow$ Chặn commit ngay lập tức.

---

## 4. Checklist Đối Chiếu Phê duyệt Design Gate v1.4 (6/6 Đạt)

- [x] **1. FS-3 có dữ liệu gốc và assertion bảo toàn từng byte**: Tạo trước file `tasks.json` hợp lệ, lưu `beforeBuffer`, sau lỗi khôi phục quyền thư mục để `Buffer.compare === 0` và xác nhận 0 file `.tmp` rò rỉ.
- [x] **2. FS-3 mô tả đúng giới hạn kiểm thử lỗi tạo file tạm**: Định nghĩa rõ là kiểm thử lỗi không thể tạo/mở file tạm do quyền thư mục, không tuyên bố kiểm chứng lỗi ghi dở giữa chừng (vốn thuộc phạm vi `T8.3`).
- [x] **3. FS-4 có capability probe độc lập và quy tắc SKIP/FAIL chính xác**: Chạy probe trước; nếu không hỗ trợ $\rightarrow$ SKIP có lý do; nếu probe hỗ trợ mà `saveTasks()` không lỗi $\rightarrow$ FAIL; tuyệt đối không chuyển lỗi thành SKIP; kiểm tra `err.syscall === 'rename'`.
- [x] **4. Runner thống kê PASS + FAIL + SKIP = TOTAL**: Bổ sung hợp đồng `assert.strictEqual(passed + failed + skipped, total);`, `assert.strictEqual(executed, total);`, `const exitCode = failed > 0 ? 1 : 0;`. Trong đó `executed` là số scenario được runner xử lý.
- [x] **5. Single-Gate Commit Policy**: `ask_mentor.mjs` thu thập toàn bộ thay đổi thuộc phạm vi Task 3 (staged, unstaged, untracked files và nội dung đầy đủ). Implementation Gate kiểm tra source code, test, `package.json`, agent scripts. Không commit bất kỳ file nào trước khi nhận `CODE_STATUS: APPROVED`.
- [x] **6. Complete SHA-256 Integrity Coverage & Git Index Guard (INTEGRITY CONTRACT — TASK 3)**:
  - Approved Manifest ghi nhận đầy đủ đường dẫn, trạng thái (A/M/D/R) và hash nội dung.
  - Git Index Verification: Pre-commit Guard đọc staged content thực tế và so khớp với Approved Manifest; bảo đảm bất biến: `Approved Content SHA-256 == Git Index Content SHA-256 == Expected Commit Content SHA-256`.
  - Repository Scope Verification: Quét toàn bộ repository, chặn commit nếu có thay đổi ngoài phạm vi Task 3.
  - Commit Authorization & Failure Policy: Chặn commit ngay lập tức nếu bất kỳ điều kiện nào sai lệch.
