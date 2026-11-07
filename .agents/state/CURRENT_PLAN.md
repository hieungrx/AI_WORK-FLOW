# KẾ HOẠCH NÂNG CẤP AI_WORK-FLOW LEVEL 1.2 (BẢN CHỐT v1.7) — INTEGRITY & SECURITY HARDENING

- **Phase Plan**: `Level 1.2`
- **Active Task**: `task-4`
- **Approved Scope**: `task-4` (Lộ trình 4 Task: `Task 4` -> `Task 7`; khóa chặt schema `CanonicalSnapshotManifest v1` ngay tại `Task 4`, không phá vỡ ở `Task 5`)
- **Approval Revision**: `v1.7` (Hoàn thành 5/5 điều kiện Design Gate: đóng `P0-26` -> `P0-29` và `P1-32` -> `P1-35`)

> **Trạng thái tài liệu**: Bản thiết kế kỹ thuật **v1.7** giữ nguyên kiến trúc gọn nhẹ bằng Node.js thuần + Git CLI, định nghĩa trung thực ranh giới tin cậy và điểm tuyến tính hóa giao dịch, đóng toàn bộ **29 điểm P0 (`P0-01` -> `P0-29`)** và **35 điểm P1 (`P1-01` -> `P1-35`)**, duy trì chính xác **39 nhóm kiểm thử (`G-1` -> `G-39`) / 41 test cases thực thi độc lập** (`30 + 7 + 4 = 41`).
> **Nguyên tắc**: Chỉ cập nhật tài liệu kế hoạch, chưa triển khai mã nguồn Task 4 trước khi nhận `STATUS: APPROVED`.

---

## 1. Bảng Đối Chiếu Khắc Phục 5 Điều Kiện Mở Gate Từ Vòng Review v1.6 (`P0-26` -> `P0-29` & `P1-32` -> `P1-35`)

| Mã lỗi | Phát hiện của ChatGPT Mentor (Architect + DevOps) trên Bản v1.6 | Hợp Đồng Kỹ Thuật Chốt Trong Bản v1.7 |
| :--- | :--- | :--- |
| **P0-26** | **Mutex recovery chưa là rào chắn chung với writer bình thường & giới hạn OS `unlink`**: Writer bình thường không kiểm tra `.state_lock.recovery.mutex`, và chuỗi `lstat -> readFile -> unlink` không phải phép compare-and-delete nguyên tử trước tiến trình ngoài giao thức. | **Unified Cooperative Barrier & Ranh Giới Tin Cậy Minh Bạch**: (1) **Chốt Trust Boundary**: Cơ chế mutex bảo đảm loại trừ tương hỗ **giữa các tiến trình hợp tác tuân thủ giao thức**; không tuyên bố tính nguyên tử trước tác nhân cục bộ ngoài giao thức cố tình thay đổi/xóa file khóa trực tiếp. (2) **Giao thức 2 chiều**: Mọi writer bình thường kiểm tra `.state_lock.recovery.mutex` **trước** khi mở `.state_lock.mutex` (`wx`) và **kiểm tra lại ngay sau khi chiếm khóa** (nếu thấy recovery đang chạy thì tự nhả khóa của mình và dừng với `RECOVERY_IN_PROGRESS`). Ngược lại, `--recover-mutex` kiểm tra lại `ownerToken` + fingerprint ngay trước `unlinkSync`. (3) Nếu bản thân `.state_lock.recovery.mutex` mồ côi sau crash -> **fail-closed (`STALE_RECOVERY_MUTEX_MANUAL_INSPECTION_REQUIRED`)** kèm quy trình vận hành thủ công, không đệ quy tự phá khóa (`G-37`). |
| **P0-27** | **Chưa định nghĩa điểm tuyến tính hóa (linearization point) & giới hạn của Re-Read CAS**: State mutex không khóa Git Index, `HEAD` hay worktree trước tiến trình Git/editor bên ngoài chạy song song ngay sau bước kiểm tra CAS. | **Định Nghĩa Điểm Commit, Explicit Tx/Revision CAS & Revalidation Bắt Buộc**: (1) **Điểm tuyến tính hóa**: Phép `fs.renameSync(tmp, STATE_LOCK.json)` ghi `writePhase: "COMMITTED"` và tăng `stateRevision` dưới `.state_lock.mutex`. (2) **Giới hạn trung thực**: CAS chỉ thu hẹp cửa sổ tranh chấp và bảo vệ trạng thái `STATE_LOCK.json` giữa các writer hợp tác (so sánh tường minh `stateRevision`, `writePhase === "PREPARING"` và `activeTxId`), **không ngăn được** thay đổi worktree/Index/`HEAD` ngoài giao thức sau thời điểm đọc. (3) **Chốt chặn hạ lưu bắt buộc**: Mọi thay đổi worktree/Index/`HEAD` phát sinh quanh hoặc sau CAS đều bị phát hiện tất định khi tái kiểm chứng tại `verifyPreCommitGuard()` và `--ci-verify`, vô hiệu hóa việc dùng approval cũ cho trạng thái mới (`G-15`). |
| **P0-28** | **Transition rollback chưa chống drift phát sinh ngay trong Pha R2**: Tác nhân ngoài giao thức sửa file `#4` sau khi Pha R1 đã PASS sẽ bị Pha R2 ghi đè. | **Per-File Just-In-Time Re-Check Trong Pha R2 & Ngữ Nghĩa Partial Rollback Minh Bạch**: (1) Giữa các writer hợp tác cùng tuân thủ `.state_lock.mutex`, rollback 5 file là toàn vẹn. (2) Trước tác nhân sửa file ngoài giao thức giữa Pha R2: **ngay trước mỗi lệnh thay thế từng file thứ `i`**, `--recover-transition` đọc và băm lại file `i` trên đĩa; nếu lệch khỏi `{beforeSha256, expectedAfterSha256}` -> **dừng ngay lập tức (`TRANSITION_RECOVERY_MID_FLIGHT_DRIFT`), tuyệt đối không ghi đè file `i`, giữ nguyên `.transition_journal.json`** (hệ thống tiếp tục fail-closed) và công bố rõ các file `1..(i-1)` đã rollback một phần để người vận hành xử lý (`G-39`). |
| **P0-29** | **Snapshot chưa quy định đủ điều kiện tương đương với Git attributes, filters & tập ứng viên**: Thiếu xử lý `working-tree-encoding`, `ident`, `core.autocrlf`, xóa file trong worktree, gitlink/submodule và điều kiện để 3 mode tương đương. | **Hợp Đồng Đầy Đủ Git Attributes/Filters & Điều Kiện Tương Đương 3 Mode**: (1) Tập đường dẫn ứng viên là hợp `keys(baseTreeMap) U keys(targetStateMap)` nên bắt trọn mọi file xóa (`D`), thêm (`A`), sửa (`M`), đổi kiểu (`T`). (2) Đường dẫn UTF-8 luôn qua `git hash-object -t blob --stdin --path=<utf8PosixPath>` (tuyệt đối không dùng `--no-filters`), áp dụng đúng pipeline Index cho `core.autocrlf`, `text`, `eol`, `ident`, `working-tree-encoding`, `filter`. (3) Đường dẫn non-UTF-8 kiểm tra đủ 5 thuộc tính `filter, ident, working-tree-encoding, text, eol` + `core.autocrlf=false`; nếu có bất kỳ phép biến đổi nào -> fail-closed (`NON_UTF8_PATH_WITH_GIT_FILTERS_UNSUPPORTED`). (4) Submodule/gitlink lệch giữa worktree và Index -> fail-closed (`SUBMODULE_DRIFT_OR_UNSUPPORTED`). Định nghĩa rõ 3 điều kiện tiền đề để 3 mode trùng khớp byte-for-byte (`G-22`, `G-31`). |
| **P1-32** | **`--recover-mutex` chưa quy định hành vi khi `processStartTime` không lấy được (`UNKNOWN`)**. | **Fail-Closed Khi Liveness `UNKNOWN`**: Nếu `lock.processStartTime === "UNKNOWN"` hoặc hệ điều hành không truy xuất được `processStartTime` hiện tại của `pid` đang tồn tại -> bắt buộc dừng fail-closed (`MUTEX_LIVENESS_UNKNOWN`), **cấm suy diễn tiến trình đã chết** (`G-37`). |
| **P1-33** | **Journal chưa đặc tả sentinel cho file không tồn tại & kiểm tra `beforeBase64`**. | **Sentinel `"MISSING"` Nhất Quán & Pre-Validation Journal**: Khi `existedBefore === false` thì `beforeSha256: "MISSING"`, `beforeBase64: null`; khi `existedBefore === true` thì `beforeSha256` là 64-hex và `sha256(Buffer.from(beforeBase64, 'base64')) === beforeSha256`. Kiểm tra cấu trúc/hash/Base64 của toàn bộ journal trước Pha R1; sai lệch -> từ chối ngay (`CORRUPT_TRANSITION_JOURNAL`) trước khi chạm vào đĩa (`G-39`). |
| **P1-34** | **`transitionGovernanceHash` chưa có định nghĩa canonical không phụ thuộc vòng**. | **Đặc Tả Canonical `TRANSITION_GOV_SCHEMA:v1`**: Định nghĩa chính xác thứ tự trường, chuẩn hóa LF, mã hóa UTF-8, sắp xếp từ điển 4 file quản trị và loại trừ tường minh `transitionEvidence` + `updatedAt` khỏi dữ liệu băm (§3.3.1). |
| **P1-35** | **Alias `--bootstrap-v12` gây hiểu nhầm rằng tạo ra schema v1.2**. | **Loại Bỏ Hoàn Toàn Alias `--bootstrap-v12`**: Chỉ hỗ trợ lệnh duy nhất `--bootstrap-v13` (tạo `schemaVersion: "1.3"`). Nếu truyền `--bootstrap-v12` -> báo lỗi tham số không hợp lệ và hướng dẫn dùng `--bootstrap-v13`. |

---

## 2. Mô Hình Tin Cậy 2 Tầng, Ranh Giới Giao Thức & Phân Định GitHub CI (`P0-19`, `P0-26`, `P0-27`)

1. **Tier 1 — Cooperative Local Workflow Integrity Guard (Phạm vi Task 4–7)**:
   - Bảo đảm tính nhất quán nội bộ (**Local Consistency Evidence** & **Hash-Bound Local Transition Evidence**) giữa các công cụ trong luồng công việc hợp tác (cùng tuân thủ `.state_lock.mutex` và `.state_lock.recovery.mutex`).
   - **Giới hạn trung thực**: User-space mutex và chuỗi ghi nhiều file trên Node.js/OS **không cung cấp** tính nguyên tử giao dịch trước các tiến trình cục bộ ngoài giao thức cố tình sửa/xóa trực tiếp file khóa, sửa worktree/`.git/index` song song mà không qua khóa, hoặc chạy `git commit --no-verify`. Thay vì tuyên bố ngăn chặn vật lý các tác nhân đó tại thời điểm ghi, hệ thống bảo đảm **phát hiện lệch (drift detection) và chặn fail-closed tại cổng tái kiểm chứng kế tiếp** (`--recover-transition` R2, `verifyPreCommitGuard`, `--ci-verify`). Cấm tuyệt đối mọi biến môi trường bypass (`AI_WORKFLOW_ALLOW_*`).
2. **Tier 2 — Independent Remote Verification Boundary (Phân Định 3 Thành Phần Rõ Ràng Trên GitHub CI)**:
   - **Trusted Verifier Code**: Bản `verify_guard.mjs` tự thân (chỉ import `node:*`) được checkout từ nhánh bảo vệ (`origin/master`) ra thư mục ngoài vùng PR; cấm tuyệt đối thực thi bản `verify_guard.mjs` do PR cung cấp (`G-25`).
   - **Untrusted Candidate Code**: Cây mã nguồn và lịch sử commit của nhánh PR chỉ được đọc dưới dạng dữ liệu đầu vào không tin cậy để kiểm tra snapshot và phạm vi đường dẫn.
   - **Trusted Approval Evidence**: Nguồn xác thực phê duyệt độc lập đến từ **cấu hình GitHub Branch Protection + CODEOWNERS + Required PR Reviews & Required Status Checks** trên kho lưu trữ từ xa (việc chỉ checkout verifier từ `origin/master` chỉ bảo đảm tính toàn vẹn của công cụ kiểm tra, không tự chứng minh quyền phê duyệt nếu thiếu kiểm tra chính sách PR review/branch protection).

---

## 3. Bốn Hợp Đồng Kỹ Thuật Cốt Lõi (Core Technical Contracts v1.7)

### 3.1. Hợp Đồng 1: Cooperative Mutex/Recovery Gate, Linearization Point, CAS & Non-Self-Referential Bundle (`P0-21`, `P0-26`, `P0-27`, `P1-32`)

1. **Chuẩn hóa `CRLF -> LF` Nhất quán**: Mọi dữ liệu văn bản trước khi băm đều chuẩn hóa `\r\n|\r -> \n`.
2. **Giao Thức Khóa Hợp Tác Hai Chiều (`acquireStateMutex` <-> `recoverStateMutex` — `P0-26`, `P1-32`, `G-37`)**:
   - **Hàm `getProcessStartTime(pid)`**: Truy vấn thời điểm khởi tạo tiến trình từ OS; nếu không đọc được hoặc không hỗ trợ -> trả về chuỗi `"UNKNOWN"`.
   - **Luồng Writer Bình Thường (`acquireStateMutex`)**:
     - **Bước W1 (Kiểm tra Recovery Gate trước)**: Nếu tồn tại `.agents/state/.state_lock.recovery.mutex` -> dừng ngay (`RECOVERY_IN_PROGRESS`).
     - **Bước W2 (Mở khóa chính)**: Mở độc quyền `fs.openSync('.agents/state/.state_lock.mutex', 'wx')`, ghi `{ ownerToken: crypto.randomUUID(), pid: process.pid, processStartTime, hostname: os.hostname(), createdAt, scope }` + `fsyncSync`. Nếu gặp `EEXIST`:
       - Nếu chủ khóa đang sống (`kill(pid, 0)` thành công hoặc ném `EPERM`) và `osStartTime === lock.processStartTime` (khác `"UNKNOWN"`) -> dừng ngay (`CONCURRENT_STATE_MUTATION_BLOCKED`).
       - Nếu `osStartTime === "UNKNOWN"` hoặc `lock.processStartTime === "UNKNOWN"` khi PID còn tồn tại -> dừng fail-closed (`MUTEX_LIVENESS_UNKNOWN`).
       - Nếu `ESRCH` hoặc xác nhận PID reuse (`osStartTime !== lock.processStartTime` và cả hai đều khác `"UNKNOWN"`), hoặc file khóa hỏng -> dừng fail-closed (`STALE_MUTEX_RECOVERY_REQUIRED`), **không tự thu hồi**.
     - **Bước W3 (Kiểm tra kép sau khi mở khóa)**: Đọc lại ngay `.state_lock.recovery.mutex` và `.state_lock.mutex`: nếu `.state_lock.recovery.mutex` vừa xuất hiện hoặc `ownerToken` không khớp -> tự xóa `.state_lock.mutex` (chỉ khi `ownerToken` khớp) và dừng với `RECOVERY_IN_PROGRESS`.
     - **Giải phóng (`finally`)**: Đọc lại `.state_lock.mutex`, chỉ `unlinkSync` khi `ownerToken` trùng khớp.
   - **Luồng Thu Hồi Khóa Mồ Côi (`verify_guard.mjs --recover-mutex`)**:
     - **Bước M1**: Mở độc quyền `fs.openSync('.agents/state/.state_lock.recovery.mutex', 'wx')` ghi `{ recoveryOwnerToken, pid, processStartTime, createdAt }` + `fsyncSync`. Nếu `EEXIST`: kiểm tra khóa recovery; nếu đang chạy -> báo `RECOVERY_ALREADY_IN_PROGRESS`; nếu bản thân khóa recovery bị mồ côi sau sự cố sập nguồn -> dừng fail-closed (`STALE_RECOVERY_MUTEX_MANUAL_INSPECTION_REQUIRED`) và in hướng dẫn vận hành (xác nhận không còn tiến trình workflow nào chạy, xóa thủ công `.state_lock.recovery.mutex`, rồi chạy lại `--recover-mutex`).
     - **Bước M2 (trong `try ... finally` luôn giải phóng khóa recovery theo `recoveryOwnerToken`)**: Đọc `stat1 = fs.lstatSync(mutexPath, { bigint: true })` và `raw1 = fs.readFileSync(mutexPath)`. Kiểm tra liveness: nếu PID còn tồn tại mà `lock1.processStartTime === "UNKNOWN"` hoặc `osStartTime === "UNKNOWN"` -> từ chối (`MUTEX_LIVENESS_UNKNOWN` — `P1-32`); nếu chủ khóa đang sống -> từ chối (`MUTEX_OWNER_STILL_ALIVE`).
     - **Bước M3**: Đọc lại `stat2` (`ino`, `size`, `mtimeNs`) và `raw2`; xác nhận `stat1.ino === stat2.ino && stat1.size === stat2.size && stat1.mtimeNs === stat2.mtimeNs && raw1.equals(raw2)` và `ownerToken === lock1.ownerToken` rồi thực hiện `fs.unlinkSync(mutexPath)`.
3. **Điểm Tuyến Tính Hóa, Explicit Re-Read CAS & Tái Kiểm Chứng Hạ Lưu (`P0-27` — `G-15`, `G-28`, `G-32`)**:
   - `STATE_LOCK.json` (`schemaVersion: "1.3"`) lưu `stateRevision` (số nguyên tăng đơn điệu), `activeTxId`, `planApprovalTxId`, `codeApprovalTxId`, `writePhase` (`"PREPARING" | "COMMITTED"`).
   - **Bước 1 (`PREPARING`)**: Dưới `.state_lock.mutex`, ghi atomic `STATE_LOCK.json` với `writePhase: "PREPARING"`, `activeTxId: txId`, `stateRevision: rev + 1`.
   - **Bước 2**: Ghi atomic file feedback kèm Single-Footer (và `LAST_REVIEW_BUNDLE.txt` ở `review-code`).
   - **Bước 3 (Explicit Re-Read CAS)**: Vẫn dưới `.state_lock.mutex`, đọc lại `STATE_LOCK.json` từ đĩa và kiểm tra tường minh: `reRead.writePhase === "PREPARING" && reRead.stateRevision === rev + 1 && reRead.activeTxId === txId`, đồng thời kiểm tra lại `computeCanonicalPlanHash(PLAN_FILE) === expectedPlanHash`, `git rev-parse --verify HEAD === baseCommitOid`, và (ở `review-code`) `captureCodeSnapshot('worktree').hash === codeSnapshotHash`. Nếu bất kỳ điều kiện nào sai -> hủy giao dịch (`TOCTOU_DRIFT_DETECTED`).
   - **Bước 4 (Linearization Point)**: Phép `fs.renameSync(tmp, STATE_LOCK.json)` (sau `fsyncSync`) chuyển `writePhase: "COMMITTED"`, `stateRevision: rev + 2`, chốt `planApprovalTxId` / `codeApprovalTxId` và xóa `activeTxId: ""`.
   - **Tái kiểm chứng bắt buộc tại điểm tiêu thụ**: Vì mutex không khóa `.git/index`, `HEAD` hay worktree trước tác nhân bên ngoài sau Bước 3, `verifyPreCommitGuard()` và `--ci-verify` bắt buộc kiểm chứng lại toàn bộ chuỗi `HEAD === lock.baseCommitOid`, `planHash`, `reviewBundleHash`, Single-Footer (`TX`, `REQ`, `BUNDLE`, `SNAPSHOT`) và `captureCodeSnapshot('index' | 'commit') === lock.codeSnapshotHash` (`G-15`).
4. **Non-Self-Referential `LAST_REVIEW_BUNDLE.txt` & Request Envelope (`P0-21` — `G-38`)**: Không nhúng `BUNDLE_SHA256` vào trong `LAST_REVIEW_BUNDLE.txt`; tính `reviewBundleHash = sha256(bundleBytes)` sau khi đóng file, gửi qua Request Envelope, lưu vào `STATE_LOCK.json` và `BUNDLE:` của footer.

---

### 3.2. Hợp Đồng 2: `CanonicalSnapshotManifest v1`, Git Attributes/Filters & Điều Kiện Tương Đương 3 Mode (`P0-23`, `P0-29`, `P1-31`)

1. **Phân Định Rõ Phạm Vi Giữa Task 4 và Task 5 (Không Đổi ROADMAP, Không Phá Vỡ Schema)**:
   - **Task 4** triển khai hoàn chỉnh đặc tả cố định `CanonicalSnapshotManifest v1`, bộ máy `captureCodeSnapshot` cho cả 3 mode (`worktree`, `index`, `commit`), đường ống `Buffer` `-z`, xử lý Git attributes/filters chuẩn Index và nghiệm thu `G-22`, `G-35`, `G-38`.
   - **Task 5** mở rộng kiểm thử và gia cố các kịch bản Git biên phức tạp (`G-17`, `G-18`, `G-20`, `G-23`, `G-24`, `G-29`, `G-31`) **mà tuyệt đối không thay đổi định dạng byte của `CanonicalSnapshotManifest v1` đã khóa ở Task 4**.
2. **Tập Ứng Viên Đầy Đủ & Đường Ống `Buffer` Không Mất Byte (`P0-29`, `P1-31`)**:
   - Đọc `objectFormat = git rev-parse --show-object-format` (`sha1` / `sha256`).
   - Không bao giờ truyền `<path>` qua chuỗi `argv` của Git subprocess. Đọc toàn bộ `baseTreeMap` từ `git ls-tree -r -z <baseCommitOid>` (`{ encoding: 'buffer' }`).
   - Lập `targetStateMap` theo mode:
     - `commit`: `git ls-tree -r -z <targetCommitOid>`.
     - `index`: `git ls-files --stage -z` (nếu có unmerged stage `1..3` -> fail-closed `UNMERGED_INDEX_ENTRIES`) + kiểm tra `git status -z --porcelain=v1 -uall` (nếu có unstaged/untracked trong `effectiveReviewScope` -> fail-closed `DIRTY_WORKTREE_OR_UNTRACKED`).
     - `worktree`: Hợp nhất các đường dẫn từ `git ls-files --stage -z` VÀ `git ls-files -z --others --exclude-standard` với `keys(baseTreeMap)`, lọc theo `effectiveReviewScope = unique(config.reviewScope U lock.allowedPaths)`. Do lấy hợp với `baseTreeMap` và `indexMap`, mọi thao tác xóa file (`ENOENT` khi `fs.lstatSync(absPathBuf)`), đổi kiểu file (`regular <-> symlink`), và file tracked trùng mẫu `.gitignore` đều được thu thập đầy đủ 100%. Nếu phát hiện thư mục con chứa `.git` (nested repo không khai báo) hoặc submodule/gitlink (`160000`) có `HEAD` thực tế lệch với OID trong Index/bẩn -> fail-closed (`SUBMODULE_DRIFT_OR_UNSUPPORTED`).
3. **Thuật Toán Tính Git Blob Tương Thích Tuyệt Đối Với Git Index (`working-tree-encoding`, `filter`, `ident`, `text`, `eol`, `core.autocrlf`)**:
   - Với symlink (`120000`): `git hash-object -t blob --stdin --no-filters` trên `fs.readlinkSync(absPathBuf, 'buffer')`.
   - Với regular file trong `worktree`:
     - Kế thừa `100755` từ `indexMap` (hoặc `baseTreeMap` nếu chưa stage) khi `core.filemode=false` trên Windows; kiểm tra bit `0o111` khi `core.filemode=true` trên POSIX.
     - **Đường dẫn UTF-8 hợp lệ**: Bắt buộc gọi `git hash-object -t blob --stdin --path=<utf8PosixPath>` truyền `input: fs.readFileSync(absPathBuf)` (**cấm dùng `--no-filters`**). Lệnh này áp dụng chính xác cùng bộ quy tắc chuyển đổi của `git add` cho `.gitattributes` (`text`, `eol`, `ident`, `working-tree-encoding`, `filter.clean` / process filter) và `core.autocrlf`. Nếu lệnh trả `exitCode !== 0` -> fail-closed (`GIT_HASH_OBJECT_FAILED`).
     - **Đường dẫn chứa byte non-UTF-8 (POSIX)**: Truy vấn `git check-attr -z --stdin filter ident working-tree-encoding text eol` (truyền `Buffer` qua `stdin`). Chỉ khi cả 5 thuộc tính đều là `"unspecified"`/`"unset"` VÀ `core.autocrlf === false` mới băm qua `git hash-object -t blob --stdin --no-filters`; nếu bất kỳ thuộc tính biến đổi nào có hiệu lực -> **fail-closed (`NON_UTF8_PATH_WITH_GIT_FILTERS_UNSUPPORTED`)**.
4. **Định Nghĩa Tường Minh Điều Kiện Tương Đương Giữa 3 Mode (`worktree`, `index`, `commit`)**:
   - Ba mode sinh ra cùng dãy byte `CanonicalSnapshotManifest v1` (`SNAPSHOT_SCHEMA:v1`, phân tách `\t` và `\n`, 6 cột `changeType`, `oldMode`, `newMode`, `oldBlobOid`, `newBlobOid`, `pathHex`) khi và chỉ khi thỏa mãn 3 điều kiện của chu trình hợp lệ:
     1. Toàn bộ thay đổi trong `effectiveReviewScope` đã được `git add` sạch vào `.git/index` (không còn diff unstaged hay file untracked; `.git/index` không giữ blob cũ lệch với kết quả clean-filter hiện tại của `worktree`).
     2. Các phép chuẩn hóa/clean-filter được cấu hình là **tất định** (cùng đầu vào `worktree` sinh cùng blob OID lúc review và lúc `git add`; nếu filter không tất định sinh blob khác trong Index -> `verifyPreCommitGuard` chặn ngay với `SNAPSHOT_MISMATCH` / `NON_DETERMINISTIC_OR_FAILED_FILTER`).
     3. Commit `<targetCommitOid>` được tạo trực tiếp từ chính `.git/index` đó trên cha `HEAD === baseCommitOid` mà không sửa đổi cây đối tượng sau staging.

---

### 3.3. Hợp Đồng 3: Canonical `transitionGovernanceHash`, Rollback R2 Chống Drift & Hai Luồng Quản Trị (`P0-22`, `P0-28`, `P1-29`, `P1-33`, `P1-34`)

#### 3.3.1. Lệnh `--advance-task <from> --to <to>`, Canonical Hash & `--recover-transition` (`P0-28`, `P1-33`, `P1-34` — `G-34`, `G-39`)
1. **Định nghĩa Canonical `transitionGovernanceHash` Không Phụ Thuộc Vòng (`P1-34`)**:
   - Chuẩn hóa LF (`\r\n|\r -> \n`) nội dung đích của 4 file quản trị ngoài lock (`.agents/state/CODE_REVIEW_FEEDBACK.md`, `.agents/state/CURRENT_PLAN.md`, `.agents/state/MENTOR_FEEDBACK.md`, `.agents/state/ROADMAP.md` — xếp theo thứ tự ASCII tăng dần) và băm UTF-8 chuỗi:
     ```text
     TRANSITION_GOV_SCHEMA:v1
     FROM_TASK:<fromTaskId>
     TO_TASK:<toTaskId>
     BASE_OID:<transitionBaseOid>
     APPROVED_COMMIT_OID:<approvedCodeCommitOid>
     APPROVED_SNAPSHOT_SHA256:<approvedCodeSnapshotHash>
     STATE_LOCK_CORE:<toTaskId>|PENDING|COMMITTED|TRANSITION|ALLOWED_COUNT:0
     FILE:.agents/state/CODE_REVIEW_FEEDBACK.md:<sha256_lf>
     FILE:.agents/state/CURRENT_PLAN.md:<sha256_lf>
     FILE:.agents/state/MENTOR_FEEDBACK.md:<sha256_lf>
     FILE:.agents/state/ROADMAP.md:<sha256_lf>
     ```
   - Loại trừ hoàn toàn bản thân `transitionEvidence` và `updatedAt` khỏi đầu vào băm (0 phụ thuộc vòng). Khi `verifyPreCommitGuard()` kiểm tra `GOVERNANCE_TASK_TRANSITION`, hàm dựng lại đúng chuỗi canonical này từ các blob đang staged trong Git Index để đối chiếu với `STATE_LOCK.json.transitionEvidence.transitionGovernanceHash`.
2. **Schema Chặt Chẽ Của `.transition_journal.json` (`P1-33`)**:
   - Ghi dưới `.state_lock.mutex` trước khi sửa file đầu tiên. Mỗi phần tử trong 5 file quản trị có dạng:
     `{ relPath, existedBefore: boolean, beforeSha256: <64-hex | "MISSING">, beforeBase64: <string | null>, expectedAfterSha256: <64-hex> }`.
   - Quy tắc bất biến: nếu `existedBefore === false` thì bắt buộc `beforeSha256 === "MISSING"` và `beforeBase64 === null`; nếu `existedBefore === true` thì `beforeSha256` là 64-hex thường và `sha256(Buffer.from(beforeBase64, 'base64')) === beforeSha256`.
3. **Giao Thức `--recover-transition` Kèm Kiểm Tra Lại Từng File Ở Pha R2 (`P0-28`, `P1-33` — `G-39`)**:
   - Chạy dưới khóa hợp tác `acquireStateMutex`.
   - **Pha R0 (Journal Integrity Validation)**: Xác thực JSON schema, đủ 5 mục chuẩn, kiểm tra tính hợp lệ của `existedBefore`, sentinel `"MISSING"`, định dạng 64-hex và giải mã `beforeBase64` khớp `beforeSha256`. Nếu sai lệch bất kỳ trường nào -> **dừng ngay (`CORRUPT_TRANSITION_JOURNAL`) trước khi chạm vào bất kỳ file nào**.
   - **Pha R1 (All-Files Pre-Check)**: Đọc cả 5 file trên đĩa (`"MISSING"` nếu `ENOENT`, ngược lại `sha256(bytes)`). Mọi file phải thuộc `{beforeSha256, expectedAfterSha256}`; nếu có file mang fingerprint thứ ba -> **dừng ngay (`TRANSITION_RECOVERY_DRIFTED`), 0 file bị ghi**.
   - **Pha R2 (Per-File Just-In-Time Re-Check & Bounded Partial Rollback)**: Duyệt tuần tự từng file `i` chưa ở trạng thái `beforeSha256`:
     - **Ngay trước lệnh `renameSync` (hoặc `unlinkSync` khi `existedBefore === false`) trên file `i`**, đọc và tính lại fingerprint hiện tại của chính file `i` trên đĩa.
     - Nếu file `i` vừa bị tác nhân ngoài giao thức sửa thành fingerprint thứ ba sau Pha R1 -> **dừng khẩn cấp (`TRANSITION_RECOVERY_MID_FLIGHT_DRIFT`), tuyệt đối không ghi đè/xóa file `i`, giữ nguyên `.transition_journal.json`** (để toàn bộ cổng Guard tiếp tục khóa fail-closed) và ghi log danh sách rõ ràng: các file `1..(i-1)` đã rollback một phần về `beforeSha256`, còn file `i` bị drift được bảo toàn nguyên trạng để người vận hành xử lý thủ công.
     - Chỉ khi hoàn tất 5/5 file và xác nhận lại cả 5 đều khớp `beforeSha256` mới `unlinkSync('.transition_journal.json')`.

#### 3.3.2. Hai Hợp Đồng Commit Quản Trị Tách Biệt (`GOVERNANCE_TASK_TRANSITION` & `GOVERNANCE_PLAN_UPDATE` — `P0-22`, `P1-29`, `G-34`)
- **`GOVERNANCE_TASK_TRANSITION`**: Không còn `.transition_journal.json`; `stagedPaths ⊆ transitionCommitAllowlist`; `HEAD === approvedCodeCommitOid && HEAD^1 === transitionBaseOid` (vé dùng 1 lần); khớp snapshot commit và khớp canonical `transitionGovernanceHash`.
- **`GOVERNANCE_PLAN_UPDATE`**: Cùng `taskId` với `HEAD`; `ROADMAP.md` không đổi; trạng thái `STATE_LOCK.json` hiệu lực bắt buộc là `approvalState === "PENDING"`, `writePhase === "COMMITTED"`, `allowedPaths: []`, xóa rỗng `plan*`/`code*`.

---

### 3.4. Hợp Đồng 4: Verified Migration `--bootstrap-v13` Duy Nhất & Dual-Path Protection (`P0-11`, `P0-19`, `P1-35`)

1. **Chỉ hỗ trợ `--bootstrap-v13` (`P1-35`)**: Bỏ hoàn toàn alias `--bootstrap-v12` (truyền `--bootstrap-v12` trả `exit 2` kèm thông báo dùng `--bootstrap-v13`). Mặc định hạ về `approvalState: "PENDING"`, `allowedPaths: []`, `provenanceLevel: "NONE"` (`G-30b`, `G-33`, `G-36`); chỉ giữ `PLAN_APPROVED` (`TIER1_LOCAL_CONSISTENCY`) khi có `--preserve-local-tier1-consistency` và nhất quán 100% (`G-30a`); `--restore-backup` chặn `RESTORE_TARGET_DRIFTED` (`G-30c`).
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

### Phân Bổ Chính Xác 39 Nhóm ID / 41 Test Cases Thực Thi (Giữ Nguyên Tổng Số, Mở Rộng Sub-Assertions Bắt Buộc)

| Task | Các Nhóm ID Kiểm Thử | Số Nhóm ID | Số Test Cases Thực Thi | Yêu Cầu Nghiệm Thu |
| :--- | :--- | :---: | :---: | :--- |
| **Task 4** | `G-1`..`G-16` (16), `G-22` (1), `G-26` (1), `G-28` (1), `G-30` [`G-30a`, `G-30b`, `G-30c`] (1 nhóm / 3 cases), `G-32`..`G-39` (8) | **28 nhóm** | **30 cases** | **`30/30 PASS \| 0 FAIL \| 0 SKIP`** |
| **Task 5** | `G-17`, `G-18`, `G-20`, `G-23`, `G-24`, `G-29`, `G-31` | **7 nhóm** | **7 cases** | **`7/7 PASS \| 0 FAIL`** (unit mock symlink `0 SKIP` + real symlink test) |
| **Task 6** | `G-19`, `G-21`, `G-25`, `G-27` | **4 nhóm** | **4 cases** | **`4/4 PASS \| 0 FAIL`** (unit `resolveDualTargetPaths` `0 SKIP` + real symlink test) |
| **Task 7** | Tổng hợp toàn bộ **`G-1` -> `G-39`** (`41` test cases thực thi) + tài liệu `README.md` | **39 nhóm** | **41 cases** | **`41/41 cases`**, `npm test` đạt `0 FAIL`, `exitCode === 0` |

*(Nguyên tắc kế toán minh bạch: Các kịch bản bổ sung của `G-15`, `G-22`, `G-37`, `G-39` được tích hợp làm các sub-assertions tuần tự bắt buộc bên trong chính hàm test của nhóm đó — thất bại bất kỳ sub-assertion nào làm FAIL toàn bộ test case đó — giữ nguyên chính xác `30` test cases thực thi ở Task 4 và `41` test cases thực thi toàn cục. Nếu khi code tách thêm hàm test độc lập mới, bắt buộc cập nhật đồng bộ con số tổng trong runner và báo cáo, tuyệt đối không khai khống `41/41`).*

---

## 5. Danh Mục Đầy Đủ 39 Nhóm Kiểm Thử (`41 Test Cases`: `G-1` -> `G-39`)

| Mã Test | Task | Kịch bản Kiểm thử Độc lập & Sub-Assertions Bắt Buộc | Kỳ vọng |
| :--- | :---: | :--- | :---: |
| **G-1 -> G-4** | Task 4 | Thiếu `planHash` (G-1), sửa `CURRENT_PLAN.md` 1 byte/CRLF (G-2), lệch footer hash (G-3), và Plan Approval hợp lệ (G-4) | `REJECT` (1-3) / `ALLOW` (4) |
| **G-5 -> G-9** | Task 4 | Thiếu `CODE_APPROVED`/footer (G-5), file untracked/unstaged mới (G-6), lệch Git Index blob (G-7), Mixed-Scope commit (G-8), và pre-commit hợp lệ (G-9) | `REJECT` (5-8) / `ALLOW` (9) |
| **G-10 -> G-14, G-16** | Task 4 | Xóa footer (G-10), 2 footer/sai cú pháp (G-11), `taskId` cũ (G-12), JSON/schema lỗi (G-13), migration `codeDiffHash` cũ (G-14), phản hồi request ID cũ đến muộn (G-16) | `REJECT` / Không cấp `CODE_APPROVED` |
| **G-15** | Task 4 | **TOCTOU & Post-CAS Revalidation (`P0-27`)**: (a) Thay đổi `stateRevision` / `activeTxId` / worktree trước Bước 4 CAS -> hủy giao dịch (`TOCTOU_DRIFT_DETECTED`); (b) Thay đổi Git Index hoặc dịch `HEAD` ngay quanh/sau thời điểm ghi `COMMITTED` -> bị `verifyPreCommitGuard()` phát hiện và chặn, không dùng lại approval cũ cho trạng thái mới | `REJECT` cả trước và sau CAS |
| **G-17 -> G-20** | Task 5 (19: Task 6) | Partial staging (G-17), đổi `fileMode`/symlink (G-18), sửa `.agents/config.json` trái phép (G-19 — Task 6), đổi `testCommand` sau review (G-20) | `REJECT` |
| **G-21** | Task 6 | Commit bypass `--no-verify` bị phát hiện bởi `--ci-verify` | `REJECT` |
| **G-22** | **Task 4** | **Snapshot Equivalence, Git Attributes & Filters (`P0-29`, `P1-31`)**: (a) Positive test với thêm, sửa, xóa, file thực thi VÀ chuẩn hóa `.gitattributes` hợp lệ (`text=auto eol=lf` / `working-tree-encoding`) -> `worktree`, `index`, `commit` xuất `CanonicalSnapshotManifest v1` trùng 100% từng byte (`Buffer.equals === true`); (b) Negative test với clean filter không tất định hoặc `.git/index` lệch blob với `worktree` -> phát hiện lệch / fail-closed; (c) Đường dẫn non-UTF-8 bảo toàn raw bytes khi không có filter, và fail-closed (`NON_UTF8_PATH_WITH_GIT_FILTERS_UNSUPPORTED`) khi gắn thuộc tính biến đổi | **Tương đương 100% hoặc Fail-Closed đúng hợp đồng** |
| **G-23 -> G-25** | Task 5 & 6 | `HEAD` dịch chuyển trước commit (G-23), CI truyền sai base (G-24), PR tự sửa `verify_guard.mjs` bị phát hiện bởi verifier chuẩn từ `origin/master` (G-25) | `REJECT` |
| **G-26 -> G-29** | Task 4, 5, 6 | Dùng lại lock `task-4` cho `task-5` (G-26), symlink nội bộ `src/link -> ../.agents/scripts/` (G-27), torn-write `writePhase === "PREPARING"` (G-28), `git mv` vượt ranh giới scope (G-29) | `REJECT` (26-28) / Chuẩn xác (29) |
| **G-30a** | Task 4 | `--bootstrap-v13 --preserve-local-tier1-consistency` trên fixture Tier-1 nhất quán -> giữ `PLAN_APPROVED` (`TIER1_LOCAL_CONSISTENCY`), Idempotent (`exit 0`), từ chối nếu `PREPARING`; từ chối cờ cũ `--bootstrap-v12` (`P1-35`) | `ALLOW` & Chặn `--bootstrap-v12` |
| **G-30b** | Task 4 | `--bootstrap-v13` mặc định (không cờ) trên lock cũ -> nâng schema `"1.3"` ở trạng thái `approvalState: "PENDING"`, `allowedPaths: []`, `provenanceLevel: "NONE"` | `PENDING` (Không tự cấp quyền) |
| **G-30c** | Task 4 | `--restore-backup` xác thực SHA-256 của `backup-manifest.json` và từ chối tự động ghi đè khi working tree đã phát sinh thay đổi mới ngoài giao dịch | `REJECT` (`RESTORE_TARGET_DRIFTED`) |
| **G-31** | Task 5 | Clean filter không tất định sinh ra blob trong Index khác với `worktree` lúc review trong luồng `review-code -> git add -> pre-commit` | `REJECT` (`NON_DETERMINISTIC_OR_FAILED_FILTER`) |
| **G-32** | Task 4 | Duyệt Plan (`planApprovalTxId = tx-plan-A`), sau đó duyệt Code (`codeApprovalTxId = tx-code-B`) | **Cả `verifyPlanGuard()` lẫn `verifyPreCommitGuard()` đều PASS** |
| **G-33** | Task 4 | Kế hoạch A được duyệt dưới lock cũ, sửa thành kế hoạch B rồi chạy `--bootstrap-v13 --preserve-local-tier1-consistency` | **Không cấp `PLAN_APPROVED` cho B; chuyển về `PENDING`** |
| **G-34** | Task 4 | Kiểm chứng 2 hợp đồng quản trị (`P0-22`, `P1-29`, `P1-34`): (1) `--advance-task` sinh canonical `transitionGovernanceHash` -> Governance Transition Commit PASS 1 lần, replay lần 2 bị **REJECT**; (2) tự chế 7 file quản trị `PENDING` đổi `ROADMAP.md` không qua `--advance-task` bị **REJECT**; (3) `GOVERNANCE_PLAN_UPDATE` cùng task với `PENDING` + `allowedPaths: []` PASS, nhưng sửa `ROADMAP.md` hoặc giữ `allowedPaths` khác `[]` bị **REJECT** | Đúng hợp đồng `P0-22`, `P1-29`, `P1-34` |
| **G-35** | Task 4 | Task 4 sửa `verify_guard.mjs`, `ask_mentor.mjs` và `tests/guard_integrity.test.js`; kiểm tra `effectiveReviewScope` và thử stage lệch 1 dòng trong `verify_guard.mjs` | **Tất cả file hạ tầng nằm trong snapshot; stage lệch bị REJECT** |
| **G-36** | Task 4 | Chạy `--bootstrap-v13` với feedback cũ `STATUS: APPROVED` nhưng thiếu `planHash` khớp nội dung | **Chuyển về `PENDING`, không tự cấp approval** |
| **G-37** | Task 4 | **Cooperative Mutex & Recovery Stress Test (`P0-26`, `P1-32`)**: (1) Tiến trình sống (`EPERM` / khớp `processStartTime`) chặn writer thứ 2; (2) `processStartTime === "UNKNOWN"` fail-closed (`MUTEX_LIVENESS_UNKNOWN`); (3) Khóa `.state_lock.mutex` mồ côi khiến writer bình thường fail-closed (`STALE_MUTEX_RECOVERY_REQUIRED`); (4) Stress đa tiến trình: writer bình thường tranh chấp đúng lúc `--recover-mutex` đang chạy + trường hợp `.state_lock.recovery.mutex` bị ngắt mồ côi (`STALE_RECOVERY_MUTEX_MANUAL_INSPECTION_REQUIRED`) -> không bao giờ xuất hiện 2 writer hợp tác đồng thời; (5) Sai `ownerToken` không xóa được khóa | Đúng hợp đồng `P0-26` & `P1-32` |
| **G-38** | Task 4 | Kiểm chứng `LAST_REVIEW_BUNDLE.txt` không tự tham chiếu (`P0-21`): không chứa `BUNDLE_SHA256`, `sha256(bundleBytes)` khớp Envelope + `STATE_LOCK.json` + footer `BUNDLE:`; sửa 1 byte bị chặn | **PASS khi nguyên vẹn / REJECT khi lệch 1 byte** |
| **G-39** | Task 4 | **Transition Journal Validation & Mid-R2 Drift Protection (`P0-28`, `P1-33`)**: (1) Journal chứa hash sai / Base64 hỏng / lệch sentinel `"MISSING"` -> bị chặn ngay ở Pha R0 (`CORRUPT_TRANSITION_JOURNAL`) trước mọi thao tác ghi; (2) Crash sau 3/5 file (không có drift) -> `--recover-transition` khôi phục 100% byte-exact cả 5 file; (3) Drift trước Pha R1 -> từ chối `TRANSITION_RECOVERY_DRIFTED` (0 file bị ghi); (4) **Drift xuất hiện sau Pha R1 nhưng ngay trước khi thay thế file `#4` ở Pha R2 -> dừng khẩn cấp (`TRANSITION_RECOVERY_MID_FLIGHT_DRIFT`), giữ journal, tuyệt đối không ghi đè file `#4`** | **Bảo toàn dữ liệu 100% ở cả Pha R0, R1 và R2** |
