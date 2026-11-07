# KẾ HOẠCH NÂNG CẤP AI_WORK-FLOW LEVEL 1.2 (BẢN CHỐT v1.5) — INTEGRITY & SECURITY HARDENING

- **Phase Plan**: `Level 1.2`
- **Active Task**: `task-4`
- **Approved Scope**: `task-4` (Lộ trình tổng thể: `Task 4` -> `Task 7`, thực thi và nghiệm thu độc lập theo từng Task RPIR)
- **Approval Revision**: `v1.5` (Khắc phục triệt để `P0-21` -> `P0-23` và `P1-26` -> `P1-28`)

> **Trạng thái tài liệu**: Bản thiết kế kỹ thuật **v1.5** đã đóng toàn bộ **23 lỗi P0 (`P0-01` -> `P0-23`)**, **28 điểm P1 (`P1-01` -> `P1-28`)**, và chuẩn hóa chính xác **39 nhóm kiểm thử (`G-1` -> `G-39`) / 41 test cases thực thi độc lập** (`30 + 7 + 4 = 41`).
> **Nguyên tắc**: Chỉ lập kế hoạch, chưa triển khai mã nguồn Task 4 trước khi nhận `STATUS: APPROVED`.

---

## 1. Bảng Đối Chiếu Khắc Phục Các Điểm Chặn Từ Vòng Review v1.4 (`P0-21` -> `P0-23` & `P1-26` -> `P1-28`)

| Mã lỗi | Phát hiện của ChatGPT Mentor trên Bản v1.4 | Hợp Đồng Kỹ Thuật Chốt Trong Bản v1.5 |
| :--- | :--- | :--- |
| **P0-21** | **Self-referential Bundle Hash**: Nhúng `BUNDLE_SHA256: <reviewBundleHash>` vào bên trong `LAST_REVIEW_BUNDLE.txt` trong khi định nghĩa `reviewBundleHash = sha256(bundleBytes)` tạo vòng phụ thuộc toán học không thể băm. | **Non-Self-Referential Bundle & Envelope Contract (Phương án A)**: Tuyệt đối **không** ghi `BUNDLE_SHA256` vào bên trong `LAST_REVIEW_BUNDLE.txt`. File `LAST_REVIEW_BUNDLE.txt` chỉ chứa `CODE_REVIEW_REQUEST_ID`, `TASK_ID`, `BASE_COMMIT_OID`, `SNAPSHOT_SHA256`, Canonical Manifest, Test Evidence và Source/Diff đầy đủ. Sau khi chốt bytes của file, tính `reviewBundleHash = sha256(bundleBytes)` rồi truyền độc lập trong **Mentor Request Envelope** (ngoài file bundle), lưu vào `STATE_LOCK.json` và nhúng vào `BUNDLE: <reviewBundleHash>` ở footer `CODE_REVIEW_FEEDBACK.md` (`G-38`). |
| **P0-22** | **Governance Commit có thể thành đường bypass**: Chỉ kiểm tra `stagedPaths ⊆ transitionCommitAllowlist` + `PENDING` chưa phân biệt được transition hợp lệ do `--advance-task` tạo ra với một bộ sửa đổi quản trị tùy ý. | **Cryptographically Bound `transitionEvidence` & Tách Biệt 2 Luồng Quản Trị**: (1) **`GOVERNANCE_TASK_TRANSITION`**: `--advance-task` sinh `transitionEvidence` một lần (`consumed: false`) ràng buộc `fromTaskId`, `toTaskId`, `transitionBaseOid`, `approvedCodeCommitOid`, `approvedCodeSnapshotHash`, `transitionGovernanceHash` và `transitionTxId`; `--pre-commit` kiểm tra `HEAD === approvedCodeCommitOid`, đúng phép biến đổi `task-N -> task-(N+1)` trên `ROADMAP.md`/`CURRENT_PLAN.md`/`STATE_LOCK.json` (`allowedPaths: []`), khớp `transitionGovernanceHash` và không cho tái sử dụng. (2) **`GOVERNANCE_PLAN_UPDATE`**: Luồng riêng chỉ cho phép cập nhật `CURRENT_PLAN.md`, `HANDOFF.md`, `SESSION_MAP.json` (và reset `PENDING`) khi giữ nguyên `activeTaskId`, `ROADMAP.md` checkboxes và `allowedPaths` như trên `HEAD` (`G-34`). |
| **P0-23** | **Thiếu hợp đồng byte-level cho `CanonicalSnapshotManifest`**: Ba mode `worktree`, `index`, `commit` có thể lấy các trường metadata khác nhau hoặc lệch `fileMode` trên Windows, không đảm bảo sinh ra cùng dãy byte manifest. | **Byte-Identical `CanonicalSnapshotManifest v1` Ngay Trong Task 4**: Định nghĩa đặc tả tuần tự hóa cấp độ byte duy nhất cho cả 3 mode ngay tại Task 4 (không đẩy sang Task 5): tự động phát hiện `OBJECT_HASH_ALGO` (`sha1`/`sha256` qua `git rev-parse --show-object-format`), mã hóa đường dẫn lossless bằng `pathHex` (raw Git path bytes sang lower-hex), sắp xếp bằng `Buffer.compare(rawPathBytes)`, loại bỏ mọi trường riêng theo mode, đồng bộ `fileMode` trên Windows (`core.filemode=false` kế thừa bit `100755` từ Index/baseCommit), và chứng minh bằng test `G-22` ngay tại Task 4 rằng **cả 3 mode sinh ra cùng một chuỗi byte manifest giống hệt nhau từng byte**. |
| **P1-26** | Mutex dùng `process.kill(pid, 0)` có thể gặp PID reuse sau crash, lỗi `EPERM` khác quyền, hoặc tự phá khóa sai nếu dùng timeout. | **Safe Owner-Token & Process-Start-Time Mutex**: `.state_lock.mutex` lưu `{ ownerToken, pid, processStartTime, hostname, createdAt, scope }`. Mở khóa chỉ khi khớp `ownerToken`. Khi gặp `EEXIST`: nếu `process.kill(pid, 0)` thành công **hoặc ném `EPERM`** và `processStartTime` vẫn khớp tiến trình OS -> chặn ngay (`CONCURRENT_STATE_MUTATION_BLOCKED`). **Cấm tuyệt đối tự phá khóa theo timeout thời gian thực**; chỉ thu hồi khóa mồ côi khi `ESRCH` hoặc `processStartTime` của PID trên OS khác với `lock.processStartTime` (xác nhận PID reuse) (`G-37`). |
| **P1-27** | `--advance-task` sửa 5 file quản trị nhưng chưa có cơ chế rollback xác định nếu lỗi giữa chừng. | **Atomic Transition Journal (`.transition_journal.json`)**: Trước khi sửa bất kỳ file nào, `--advance-task` ghi `.agents/state/.transition_journal.json` lưu bản gốc + SHA-256 của cả 5 file quản trị. Nếu sập giữa chừng, sự hiện diện của `.transition_journal.json` khiến Guard **FAIL-CLOSED (`INCOMPLETE_TASK_TRANSITION`)** ngăn commit trạng thái lai, và lệnh `--recover-transition` khôi phục nguyên trạng 100% cả 5 file (`G-39`). |
| **P1-28** | `G-30b` gộp 2 hành vi khác nhau (migration mặc định `PENDING` và từ chối restore khi đích đã drift) vào 1 test case. | **Tách Độc Lập `G-30a`, `G-30b`, `G-30c` & Cập Nhật Bảng Đếm**: Tách thành 3 test cases thực thi riêng biệt (`G-30a`: Tier-1 consistent migration & Idempotency; `G-30b`: default migration -> `PENDING`; `G-30c`: `--restore-backup` chặn `RESTORE_TARGET_DRIFTED`), cộng thêm `G-38` (`P0-21`) và `G-39` (`P1-27`), nâng tổng số lên **39 nhóm ID / 41 test cases thực thi** (`30 + 7 + 4 = 41`). |

---

## 2. Mô Hình Tin Cậy 2 Tầng & Giới Hạn Thực Thi (`P0-19`, `P0-20`, `P1-17`)

1. **Tier 1 — Local Workflow Integrity Guard (Nghiệm thu trọn vẹn trong Task 4–7)**:
   - Bảo đảm tính nhất quán nội bộ (**Local Consistency Evidence**) xuyên suốt vòng đời giữa Plan, Feedback, Bundle, Lock, Working Tree, Git Index và Commit Tree; chống lỗi thao tác, torn-write, stale replay, partial staging và lệch chuyển pha.
   - **Giới hạn trung thực**: Không thay thế ranh giới bảo mật độc lập trước tiến trình cục bộ có quyền ghi toàn bộ filesystem cố tình sửa đồng thời mọi file state/script, chạy `git commit --no-verify`, hoặc can thiệp sau thời điểm `pre-commit` kết thúc. Cấm tuyệt đối mọi biến môi trường bypass (`AI_WORKFLOW_ALLOW_*`).
2. **Tier 2 — Independent Verification Boundary (Hạ tầng Ngoài Quyền Worker)**:
   - Đòi hỏi cấu hình trên GitHub Remote: **Branch Protection + CODEOWNERS + Required PR Approval** (nguồn **Trusted Approval Provenance** độc lập) và job CI chạy bản `verify_guard.mjs` tự thân (chỉ import `node:*`, không nạp bất kỳ module nào từ PR worktree) được checkout từ nhánh bảo vệ (`origin/master`).

---

## 3. Bốn Hợp Đồng Kỹ Thuật Cốt Lõi (Core Technical Contracts v1.5)

### 3.1. Hợp Đồng 1: Dual-Transaction Approval, Safe Mutex, CAS & Non-Self-Referential Bundle (`P0-13`, `P0-20`, `P0-21`, `P1-15`, `P1-26`)

1. **Chuẩn hóa `CRLF -> LF` Nhất quán**: Áp dụng `\r\n|\r -> \n` trước mọi bước băm văn bản (`computeCanonicalPlanHash`, `parseStrictSingleFooter`, `LAST_REVIEW_BUNDLE.txt`).
2. **Safe Single-Writer Mutex (`.agents/state/.state_lock.mutex` — `P1-26`, `G-37`)**:
   - Chiếm khóa bằng `fs.openSync(mutexPath, 'wx')`, ghi `{ ownerToken: crypto.randomUUID(), pid: process.pid, processStartTime, hostname: os.hostname(), createdAt, scope }`.
   - Khi giải phóng trong `finally`, đọc lại `ownerToken` khớp mới được xóa khóa.
   - Khi gặp `EEXIST`: kiểm tra `process.kill(pid, 0)`:
     - Nếu không ném lỗi **hoặc ném `EPERM`** và `getProcessStartTime(pid) === lock.processStartTime` -> tiến trình giữ khóa đang sống, từ chối ngay (`CONCURRENT_STATE_MUTATION_BLOCKED`).
     - Không bao giờ phá khóa chỉ vì quá thời gian chờ (`timeout`). Chỉ thu hồi khóa mồ côi khi `process.kill(pid, 0)` ném `ESRCH` hoặc `getProcessStartTime(pid) !== lock.processStartTime` (PID đã bị OS cấp lại cho tiến trình khác sau crash), bằng cách đổi tên nguyên tử sang file tạm trước khi xóa và mở lại `'wx'`.
3. **Dual-Transaction & Re-Read CAS (`P0-13`, `P0-20` — `G-15`, `G-16`, `G-28`, `G-32`)**:
   - `STATE_LOCK.json` (`schemaVersion: "1.3"`) tách riêng `planApprovalTxId` và `codeApprovalTxId` cùng bộ đếm đơn điệu `stateRevision`.
   - Pre-Send Reset của `--mode review-code` giữ nguyên `approvalState: "PLAN_APPROVED"` + `planApprovalTxId` + `planHash`; chỉ xóa các trường `code*`.
   - Ngay trước khi chuyển `writePhase: "PREPARING" -> "COMMITTED"`, đọc lại `STATE_LOCK.json` kiểm tra CAS (`stateRevision`), tính lại `planHash`, `HEAD === baseCommitOid`, và `captureCodeSnapshot('worktree').hash === codeSnapshotHash`; nếu lệch -> hủy giao dịch (`TOCTOU_DRIFT_DETECTED`).
4. **Non-Self-Referential `LAST_REVIEW_BUNDLE.txt` & Request Envelope (`P0-21` — `G-35`, `G-38`)**:
   - Cấu trúc `.agents/state/LAST_REVIEW_BUNDLE.txt` (chuẩn hóa LF, **tuyệt đối không chứa `BUNDLE_SHA256`**):
     ```text
     CODE_REVIEW_REQUEST_ID: <codeReviewRequestId>
     TASK_ID: <taskId>
     BASE_COMMIT_OID: <baseCommitOid>
     SNAPSHOT_SHA256: <codeSnapshotHash>
     --- CANONICAL SNAPSHOT MANIFEST ---
     <canonicalManifestBytes>
     --- TEST EVIDENCE ---
     <testCommand & exitCode & output>
     --- COMPLETE DIFF & NEW FILES ---
     <non-truncated contents of 100% changed/new files in effectiveReviewScope>
     ```
   - Sau khi ghi xong `LAST_REVIEW_BUNDLE.txt`, tính `reviewBundleHash = sha256(bundleBytes)` (không sửa lại file bundle!).
   - Gửi cho Mentor qua **Request Envelope** bên ngoài: dòng thông tin Envelope trong prompt chứa `REQUEST_ID: <codeReviewRequestId>` + `REVIEW_BUNDLE_SHA256: <reviewBundleHash>`, kèm đính kèm/nội dung nguyên bản `bundleBytes`.
   - Lưu `reviewBundleHash` vào `STATE_LOCK.json` và nhúng `BUNDLE: <reviewBundleHash>` vào Single-Footer của `CODE_REVIEW_FEEDBACK.md`. `verifyPreCommitGuard()` kiểm chứng `sha256(fs.readFileSync(LAST_REVIEW_BUNDLE.txt)) === lock.reviewBundleHash === codeFooter.bundleHash` (hoàn toàn không có vòng tự tham chiếu — `G-38`).

---

### 3.2. Hợp Đồng 2: `CanonicalSnapshotManifest v1` Cấp Độ Byte Chung Cho Cả 3 Mode Ngay Tại Task 4 (`P0-16`, `P0-18`, `P0-23`)

Hàm chỉ đọc `captureCodeSnapshot(root, cfg, { mode: 'worktree' | 'index' | 'commit', baseCommitOid, targetCommitOid, effectiveScope })` được triển khai đầy đủ quy tắc chuẩn hóa cấp độ byte ngay trong **Task 4**:

1. **Phát hiện Định dạng OID của Repo**: Lấy `objectFormat = git rev-parse --show-object-format` (`"sha1"` -> 40 hex thường, `"sha256"` -> 64 hex thường; giá trị rỗng ký hiệu `"ZERO"`).
2. ** Biểu diễn & Sắp xếp Đường dẫn Không Mất Dữ Liệu (`Raw Path Bytes`)**:
   - Đọc đường dẫn từ các lệnh Git có cờ `-z` (`NUL`-delimited raw `Buffer`, không qua giải mã chuỗi có thể mất byte hoặc dính quote).
   - Chuẩn hóa dấu phân cách về `/` (`0x2f`), lọc các đường dẫn thuộc `effectiveReviewScope = unique(config.reviewScope U lock.allowedPaths)`.
   - Sắp xếp danh sách entries tăng dần tuyệt đối theo `Buffer.compare(a.rawPathBytes, b.rawPathBytes)`.
   - Mã hóa đường dẫn trong manifest thành `pathHex = rawPathBytes.toString('hex')` (chữ thường).
3. **Quy tắc Trích xuất 6 Trường Duy Nhất Cho Mỗi Entry (Không Có Metadata Riêng Của Từng Mode)**:
   - Với mỗi `rawPathBytes` có thay đổi giữa `<baseCommitOid>` và trạng thái đích (`worktree` / `index` / `targetCommitOid`):
     - **`oldMode` & `oldBlobOid`**: Đọc từ `<baseCommitOid>` qua `git ls-tree -z <baseCommitOid> -- <path>`. Nếu không tồn tại ở `<baseCommitOid>` -> `oldMode = "000000"`, `oldBlobOid = "ZERO"`.
     - **`newMode` & `newBlobOid`**:
       - Nếu không tồn tại ở trạng thái đích -> `newMode = "000000"`, `newBlobOid = "ZERO"`.
       - Ở `mode === 'commit'`: Đọc từ `git ls-tree -z <targetCommitOid> -- <path>` (`100644`, `100755`, `120000`, `160000` và OID chữ thường).
       - Ở `mode === 'index'`: Đọc từ `git ls-files --stage -z -- <path>` (bắt buộc stage `0`; từ chối nếu có unmerged stage `1..3` hoặc có thay đổi unstaged/untracked trong `effectiveReviewScope`).
       - Ở `mode === 'worktree'`:
         - Nếu `lstat.isSymbolicLink()`: `newMode = "120000"`, tính `newBlobOid` bằng `git hash-object -t blob --stdin` trên buffer đích `fs.readlinkSync(absPath, 'buffer')`.
         - Nếu thư mục gitlink/submodule: `newMode = "160000"`, đọc HEAD OID của submodule.
         - Nếu regular file: trên hệ thống `core.filemode=false` (Windows), nếu đường dẫn đang có mode `100755` trong Git Index (hoặc `<baseCommitOid>` khi chưa stage) thì giữ `newMode = "100755"`, ngược lại `"100644"`; trên hệ thống `core.filemode=true` (POSIX), kiểm tra `(lstat.mode & 0o111) !== 0 ? "100755" : "100644"`. Tính `newBlobOid` qua `git hash-object --stdin --path="<posixPath>"` (bắt buộc `exitCode === 0`, chuyển về chữ thường).
     - **Suy diễn tất định `changeType` & Loại bỏ No-op**:
       - Nếu `oldMode === newMode && oldBlobOid === newBlobOid` -> bỏ qua entry (không đưa vào manifest).
       - Nếu `oldMode === "000000"` -> `changeType = "A"`.
       - Nếu `newMode === "000000"` -> `changeType = "D"`.
       - Nếu 3 ký tự đầu của `oldMode` khác 3 ký tự đầu của `newMode` (ví dụ regular file `100xxx` <-> symlink `120000` <-> gitlink `160000`) -> `changeType = "T"`.
       - Ngược lại -> `changeType = "M"`.
4. **Định dạng Byte Chuẩn `CanonicalSnapshotManifest v1` (LF `\n`)**:
   ```text
   SNAPSHOT_SCHEMA:v1
   OBJECT_HASH_ALGO:<sha1|sha256>
   BASE_COMMIT_OID:<lower-hex>
   SCOPE_HEX:<comma-separated sorted lower-hex of normalized effectiveReviewScope>
   ENTRY_COUNT:<decimal>
   ENTRY	<changeType>	<oldMode>	<newMode>	<oldBlobOid>	<newBlobOid>	<pathHex>
   ```
   - `codeSnapshotHash = crypto.createHash('sha256').update(Buffer.from(manifestText, 'utf8')).digest('hex')`.
   - **Định lý Bất biến Cấp Độ Byte (`G-22` kiểm chứng ngay tại Task 4)**: Với cùng một tập thay đổi hợp lệ đã được stage sạch và commit lên `<baseCommitOid>`, chuỗi `manifestText` sinh ra từ `worktree`, `index`, và `commit` **trùng khớp 100% từng byte (`Buffer.equals === true`)**!

---

### 3.3. Hợp Đồng 3: Xác Thực `transitionEvidence`, Atomic Journal & Hai Luồng Quản Trị Riêng Biệt (`P0-17`, `P0-18`, `P0-22`, `P1-24`, `P1-25`, `P1-27`)

#### 3.3.1. Lệnh `--advance-task <from> --to <to>` Kèm Atomic Transition Journal (`P0-18`, `P0-22`, `P1-27` — `G-34`, `G-39`)
1. **Điều kiện tiên quyết trước khi chuyển task**:
   - Đang không tồn tại file `.agents/state/.transition_journal.json` dở dang (nếu có -> báo `INCOMPLETE_TASK_TRANSITION`, yêu cầu chạy `--recover-transition`).
   - `lock.taskId === <from>`, `lock.approvalState === "CODE_APPROVED"`, `lock.writePhase === "COMMITTED"`.
   - `HEAD` không phải merge commit (`git rev-parse --verify HEAD^2` thất bại), cha trực tiếp `git rev-parse --verify HEAD^1 === lock.baseCommitOid`, và `captureCodeSnapshot('commit', lock.baseCommitOid, 'HEAD').hash === lock.codeSnapshotHash`.
   - `effectiveReviewScope` sạch hoàn toàn (`0` staged/unstaged/untracked).
2. **Giao dịch Chuyển Task Có Nhật Ký Khôi Phục (`.transition_journal.json` — `P1-27`)**:
   - Giữ khóa `.state_lock.mutex`.
   - **Bước J1**: Ghi atomic `.agents/state/.transition_journal.json` lưu nội dung gốc (base64) + SHA-256 của cả 5 file quản trị (`ROADMAP.md`, `CURRENT_PLAN.md`, `STATE_LOCK.json`, `MENTOR_FEEDBACK.md`, `CODE_REVIEW_FEEDBACK.md`) tại thời điểm bắt đầu.
   - **Bước J2**: Tính nội dung mới cho `ROADMAP.md` (chỉ đổi dòng `[ ] ... Task <from>` thành `[x]` và xác nhận mục `[ ]` kế tiếp là `<to>`), `CURRENT_PLAN.md` (chỉ đổi `- **Active Task**: \`<to>\``), `MENTOR_FEEDBACK.md` (`STATUS: PENDING`), `CODE_REVIEW_FEEDBACK.md` (`CODE_STATUS: PENDING`).
   - **Bước J3**: Tính `transitionGovernanceHash = sha256` của manifest 4 file quản trị trên, và tạo trường `transitionEvidence` trong `STATE_LOCK.json` mới (`taskId: <to>`, `approvalState: "PENDING"`, `allowedPaths: []`, xóa sạch `plan*`/`code*`):
     ```json
     "transitionEvidence": {
       "fromTaskId": "task-4",
       "toTaskId": "task-5",
       "transitionBaseOid": "<lock.baseCommitOid>",
       "approvedCodeCommitOid": "<HEAD OID>",
       "approvedCodeSnapshotHash": "<lock.codeSnapshotHash>",
       "transitionGovernanceHash": "<sha256>",
       "transitionTxId": "tx-trans-...",
       "createdAt": "<ISO>"
     }
     ```
   - **Bước J4**: Ghi toàn bộ các file `.tmp` kèm `fsync`, rename lần lượt, chốt `STATE_LOCK.json` (`writePhase: "COMMITTED"`, `lastWriteScope: "TRANSITION"`), rồi xóa `.transition_journal.json`. Nếu có lỗi bất kỳ trước khi xóa journal -> giữ nguyên journal để Guard chặn mọi thao tác tiếp theo và cho phép `--recover-transition` khôi phục chính xác 100% về trước Bước J1 (`G-39`).

#### 3.3.2. Tách Biệt Tuyệt Đối Hai Luồng Commit Quản Trị Trong `verifyPreCommitGuard()` (`P0-17`, `P0-22` — `G-34`)
Nếu tập file staged trong Git Index không chạm bất kỳ file mã nguồn/hạ tầng nào, `verifyPreCommitGuard()` **không bao giờ cho qua chỉ vì `approvalState === "PENDING"`**, mà chỉ chấp nhận đúng 1 trong 2 hợp đồng chặt chẽ sau:
1. **Hợp đồng `GOVERNANCE_TASK_TRANSITION` (Commit chuyển task sau `--advance-task`)**:
   - Không tồn tại `.transition_journal.json`.
   - Tập đường dẫn staged `⊆ transitionCommitAllowlist` (`ROADMAP.md`, `CURRENT_PLAN.md`, `HANDOFF.md`, `SESSION_MAP.json`, `STATE_LOCK.json`, `MENTOR_FEEDBACK.md`, `CODE_REVIEW_FEEDBACK.md`) và không chứa bất kỳ đường dẫn nào khác.
   - Đọc `STATE_LOCK.json` từ Git Index: bắt buộc có `lastWriteScope === "TRANSITION"`, `approvalState === "PENDING"`, `writePhase === "COMMITTED"`, `allowedPaths.length === 0`, mọi trường `plan*`/`code*` rỗng, và có `transitionEvidence` hợp lệ thỏa mãn:
     - `git rev-parse --verify HEAD === transitionEvidence.approvedCodeCommitOid` VÀ `git rev-parse --verify HEAD^1 === transitionEvidence.transitionBaseOid` (chứng minh bằng chứng chưa bị tiêu thụ bởi một commit trước đó — ngay sau khi commit này hoàn tất, `HEAD` đổi sang OID mới nên `transitionEvidence` tự động hết hiệu lực vĩnh viễn, 0 khả năng replay!).
     - `captureCodeSnapshot('commit', transitionEvidence.transitionBaseOid, 'HEAD').hash === transitionEvidence.approvedCodeSnapshotHash`.
     - Đối chiếu nội dung staged trong Index của `ROADMAP.md` so với `HEAD:ROADMAP.md` chỉ thay đổi duy nhất checkbox `[ ] -> [x]` của `fromTaskId` và mục `[ ]` đầu tiên là `toTaskId`; `transitionGovernanceHash` khớp tuyệt đối với các blob staged!
2. **Hợp đồng `GOVERNANCE_PLAN_UPDATE` (Commit lưu bản nháp kế hoạch/handoff của CÙNG task trước khi code)**:
   - Tập đường dẫn staged `⊆ planUpdateAllowlist` (chỉ gồm `.agents/state/CURRENT_PLAN.md`, `.agents/state/HANDOFF.md`, `.agents/state/SESSION_MAP.json`, và tùy chọn `MENTOR_FEEDBACK.md` / `STATE_LOCK.json` ở trạng thái `PENDING`).
   - **Cấm sửa `ROADMAP.md` và cấm nâng quyền**: `ROADMAP.md` không được nằm trong staged diff (hoặc giống hệt `HEAD:ROADMAP.md`); `Active Task` trong `CURRENT_PLAN.md` staged và `taskId` trong `STATE_LOCK.json` staged phải trùng khớp với mục `[ ]` đầu tiên hiện hành; `STATE_LOCK.json` (nếu staged) phải có `approvalState === "PENDING"`, `allowedPaths: []`, xóa rỗng `plan*`/`code*`.

---

### 3.4. Hợp Đồng 4: Verified Migration (`--bootstrap-v13`), Drift-Safe Backup & Dual-Path Protection (`P0-11`, `P0-19`, `P1-24`, `P1-25`)

1. **Migration `--bootstrap-v13` (Alias `--bootstrap-v12`)**:
   - Idempotent (`exit 0`) chỉ khi `schemaVersion === "1.3"`, cấu trúc hợp lệ đầy đủ VÀ `writePhase === "COMMITTED"` (nếu `PREPARING` -> `exit 2`).
   - Mặc định chuyển về `approvalState: "PENDING"`, `provenanceLevel: "NONE"` (`G-30b`, `G-33`, `G-36`). Chỉ khi có cờ `--preserve-local-tier1-consistency` trên fixture nhất quán 100% mới giữ `PLAN_APPROVED` với nhãn `provenanceLevel: "TIER1_LOCAL_CONSISTENCY"` (`G-30a`).
   - Sao lưu và khôi phục giữ khóa `.state_lock.mutex`, xác thực `backup-manifest.json` và từ chối ghi đè nếu đích đã drift (`RESTORE_TARGET_DRIFTED` — `G-30c`).
2. **Dual-Path Zone Policy & Self-Contained Verifier**: Kiểm tra cả `logicalRel` và `realRel` (`G-27`); `verify_guard.mjs` chỉ import `node:*` (`G-25`).

---

## 4. Lộ Trình Thực Thi & Bảng Kế Toán Kiểm Thử Chính Xác (`39 Nhóm ID / 41 Test Cases`)

### Files mục tiêu được ủy quyền (Task hiện hành: `task-4`)
- `.agents/scripts/verify_guard.mjs`
- `.agents/scripts/ask_mentor.mjs`
- `.agents/scripts/init_project.mjs`
- `.agents/scripts/checkpoint.mjs`
- `tests/guard_integrity.test.js`
- `package.json`
- `.gitignore`

---

### Phân Bổ Chính Xác 39 Nhóm ID / 41 Test Cases Thực Thi (`P1-22`, `P1-23`, `P1-28`)

| Task | Các Nhóm ID Kiểm Thử | Số Nhóm ID | Số Test Cases Thực Thi | Yêu Cầu Nghiệm Thu |
| :--- | :--- | :---: | :---: | :--- |
| **Task 4** | `G-1`..`G-16` (16), `G-22` (1 — chứng minh 3 mode byte-identical ngay Task 4), `G-26` (1), `G-28` (1), `G-30` [`G-30a`, `G-30b`, `G-30c`] (1 nhóm / 3 cases), `G-32`..`G-39` (8) | **28 nhóm** | **30 cases** | **`30/30 PASS \| 0 FAIL \| 0 SKIP`** |
| **Task 5** | `G-17`, `G-18`, `G-20`, `G-23`, `G-24`, `G-29`, `G-31` | **7 nhóm** | **7 cases** | **`7/7 PASS \| 0 FAIL`** (unit mock symlink `0 SKIP` + real symlink test) |
| **Task 6** | `G-19`, `G-21`, `G-25`, `G-27` | **4 nhóm** | **4 cases** | **`4/4 PASS \| 0 FAIL`** (unit `resolveDualTargetPaths` `0 SKIP` + real symlink test) |
| **Task 7** | Tổng hợp toàn bộ **`G-1` -> `G-39`** (`41` test cases thực thi) + tài liệu `README.md` | **39 nhóm** | **41 cases** | **`41/41 cases`**, `npm test` đạt `0 FAIL`, `exitCode === 0` |

*(Kiểm chứng tổng số học: Nhóm ID = `28 + 7 + 4 = 39` nhóm [`G-1`..`G-39`]; Test cases thực thi = `30 + 7 + 4 = 41` cases [do nhóm `G-30` gồm 3 cases độc lập `G-30a`, `G-30b`, `G-30c`]).*

---

## 5. Danh Mục Đầy Đủ 39 Nhóm Kiểm Thử (`41 Test Cases`: `G-1` -> `G-39`)

| Mã Test | Task | Kịch bản Kiểm thử Độc lập (trên Git repo tạm cô lập) | Kỳ vọng |
| :--- | :---: | :--- | :---: |
| **G-1 -> G-4** | Task 4 | Thiếu `planHash` (G-1), sửa `CURRENT_PLAN.md` 1 byte/CRLF (G-2), lệch footer hash (G-3), và Plan Approval hợp lệ (G-4) | `REJECT` (1-3) / `ALLOW` (4) |
| **G-5 -> G-9** | Task 4 | Thiếu `CODE_APPROVED`/footer (G-5), file untracked/unstaged mới (G-6), lệch Git Index blob (G-7), Mixed-Scope commit (G-8), và pre-commit hợp lệ (G-9) | `REJECT` (5-8) / `ALLOW` (9) |
| **G-10 -> G-16** | Task 4 | Xóa footer (G-10), 2 footer hoặc thêm 1 footer sai cú pháp (G-11), `taskId` cũ (G-12), JSON/schema lỗi (G-13), migration từ `codeDiffHash` cũ (G-14), TOCTOU drift trước `COMMITTED` (G-15), phản hồi request ID cũ đến muộn (G-16) | `REJECT` / Không cấp `CODE_APPROVED` |
| **G-17 -> G-20** | Task 5 (19: Task 6) | Partial staging (G-17), đổi `fileMode`/symlink (G-18), sửa `.agents/config.json` trái phép (G-19 — Task 6), đổi `testCommand` sau review (G-20) | `REJECT` |
| **G-21** | Task 6 | Commit bypass `--no-verify` bị phát hiện bởi `--ci-verify` | `REJECT` |
| **G-22** | **Task 4** | Cùng một thay đổi hợp lệ (gồm thêm, sửa, xóa, file thực thi) được xuất `CanonicalSnapshotManifest v1` ở cả 3 mode `worktree`, `index`, `commit` | **`Buffer.equals` của manifest 3 mode bằng `true` tuyệt đối (trùng 100% từng byte)** |
| **G-23 -> G-25** | Task 5 & 6 | `HEAD` dịch chuyển trước commit (G-23), CI truyền sai base (G-24), PR tự sửa `verify_guard.mjs` bị phát hiện bởi verifier chuẩn (G-25) | `REJECT` |
| **G-26 -> G-29** | Task 4, 5, 6 | Dùng lại lock `task-4` cho `task-5` (G-26), symlink nội bộ `src/link -> ../.agents/scripts/` (G-27), torn-write `writePhase === "PREPARING"` (G-28), `git mv` vượt ranh giới scope (G-29) | `REJECT` (26-28) / Chuẩn xác (29) |
| **G-30a** | Task 4 | `--bootstrap-v13 --preserve-local-tier1-consistency` trên fixture Tier-1 nhất quán -> giữ `PLAN_APPROVED` (`TIER1_LOCAL_CONSISTENCY`), chạy lại Idempotent (`exit 0`), nhưng từ chối nếu đang `PREPARING` | `ALLOW` & Idempotent |
| **G-30b** | Task 4 | `--bootstrap-v13` mặc định (không cờ) trên lock cũ -> nâng schema `"1.3"` ở trạng thái `approvalState: "PENDING"`, `provenanceLevel: "NONE"` | `PENDING` (Không tự cấp quyền) |
| **G-30c** | Task 4 | `--restore-backup` xác thực SHA-256 của `backup-manifest.json` và từ chối tự động ghi đè khi working tree đã phát sinh thay đổi mới ngoài giao dịch | `REJECT` (`RESTORE_TARGET_DRIFTED`) |
| **G-31** | Task 5 | Clean filter không tất định sinh ra blob trong Index khác với `worktree` lúc review | `REJECT` (`NON_DETERMINISTIC_OR_FAILED_FILTER`) |
| **G-32** | Task 4 | Duyệt Plan (`planApprovalTxId = tx-plan-A`), sau đó duyệt Code (`codeApprovalTxId = tx-code-B`) | **Cả `verifyPlanGuard()` lẫn `verifyPreCommitGuard()` đều PASS** |
| **G-33** | Task 4 | Kế hoạch A được duyệt dưới lock cũ, sửa thành kế hoạch B rồi chạy `--bootstrap-v13 --preserve-local-tier1-consistency` | **Không cấp `PLAN_APPROVED` cho B; chuyển về `PENDING`** |
| **G-34** | Task 4 | Kiểm chứng cả 2 nhánh quản trị (`P0-22`): (1) `--advance-task` tạo `transitionEvidence` -> Governance Transition Commit PASS 1 lần và không thể replay lần 2; (2) Worker tự chế bộ 7 file quản trị `PENDING` giả mạo đổi `ROADMAP.md` không qua `--advance-task` -> bị **REJECT**; (3) `GOVERNANCE_PLAN_UPDATE` sửa `CURRENT_PLAN.md` cùng task PASS nhưng kèm `ROADMAP.md` hoặc `allowedPaths` bị **REJECT** | Đúng hợp đồng `P0-22` |
| **G-35** | Task 4 | Task 4 sửa `verify_guard.mjs`, `ask_mentor.mjs` và `tests/guard_integrity.test.js`; kiểm tra `effectiveReviewScope` và thử stage lệch 1 dòng trong `verify_guard.mjs` | **Tất cả file hạ tầng nằm trong snapshot; stage lệch bị REJECT** |
| **G-36** | Task 4 | Chạy `--bootstrap-v13` với feedback cũ `STATUS: APPROVED` nhưng thiếu `planHash` khớp nội dung | **Chuyển về `PENDING`, không tự cấp approval** |
| **G-37** | Task 4 | Kiểm thử Mutex & CAS (`P1-26`): (1) Tiến trình sống (kể cả giả lập `EPERM`) giữ khóa -> writer thứ 2 bị chặn, không tự phá khóa theo timeout; (2) Khóa mồ côi có `ESRCH` hoặc lệch `processStartTime` (PID reuse) -> thu hồi an toàn; (3) Mở khóa sai `ownerToken` bị từ chối | Đúng hợp đồng `P0-20` & `P1-26` |
| **G-38** | Task 4 | Kiểm chứng `LAST_REVIEW_BUNDLE.txt` không tự tham chiếu (`P0-21`): file lưu trên đĩa không chứa `BUNDLE_SHA256`, `sha256(bundleBytes)` khớp chính xác với Request Envelope, `STATE_LOCK.json.reviewBundleHash` và `BUNDLE:` trong footer; sửa 1 byte của bundle bị `verifyPreCommitGuard()` chặn ngay | **PASS khi nguyên vẹn / REJECT khi lệch 1 byte** |
| **G-39** | Task 4 | Giả lập lỗi sập tiến trình giữa chừng khi đang chạy `--advance-task` (để lại `.transition_journal.json`) -> mọi lệnh Guard/commit tiếp theo đều **FAIL-CLOSED (`INCOMPLETE_TASK_TRANSITION`)** cho đến khi chạy `--recover-transition` khôi phục nguyên vẹn 100% cả 5 file quản trị | **FAIL-CLOSED khi dở dang & Khôi phục 100% byte-exact** |
