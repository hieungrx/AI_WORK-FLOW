# KẾ HOẠCH NÂNG CẤP AI_WORK-FLOW LEVEL 1.2 (BẢN SỬA ĐỔI v1.2) — INTEGRITY & SECURITY HARDENING

- **Phase Plan**: `Level 1.2`
- **Active Task**: `task-4`
- **Approved Scope**: `task-4` (Lộ trình tổng thể: `Task 4` $\rightarrow$ `Task 7`, thực thi và nghiệm thu độc lập theo từng Task RPIR)
- **Approval Revision**: `v1.2`

> **Trạng thái tài liệu**: Bản thiết kế kỹ thuật **v1.2** (đã cập nhật đầy đủ theo phản biện Vòng 1 & Vòng 2 của ChatGPT Mentor — `Architect + DevOps`), giải quyết triệt để **toàn bộ 12 lỗi P0 (`P0-01` $\rightarrow$ `P0-12`)**, **14 lỗi P1 (`P1-01` $\rightarrow$ `P1-14`)** và mở rộng bộ kiểm thử đối kháng lên **31 kịch bản (`G-1` $\rightarrow$ `G-31`)** với `0 SKIP`.
> **Nguyên tắc**: Chỉ lập kế hoạch, chưa chỉnh sửa bất kỳ file mã nguồn nào trước khi được phê duyệt triển khai.

---

## 1. Bảng Đối Chiếu Khắc Phục Các Điểm Chặn từ Vòng Review 2 (`P0-08` $\rightarrow$ `P0-12` & `P1-09` $\rightarrow$ `P1-14`)

| Mã lỗi | Phát hiện của ChatGPT Mentor (Vòng 2) | Giải pháp Kiến trúc Chuẩn hóa trong Bản v1.2 |
| :--- | :--- | :--- |
| **P0-08** | Mâu thuẫn giữa Snapshot lúc `pre-commit` (`HEAD = A`) và Snapshot lúc `CI` (`HEAD = B`): sau khi tạo commit `B`, lấy `HEAD` mới làm base sẽ cho kết quả `H(B, B) != H(A, B)`. | **3-Mode Snapshot (`worktree`, `index`, `commit`) với `baseCommitOid` cố định**: Khóa `baseCommitOid` vào `STATE_LOCK.json` và footer `CODE_SHA256`. Ở `worktree`: `baseCommitOid -> Working Tree`; ở `index`: bắt buộc `HEAD === baseCommitOid` và so sánh `baseCommitOid -> Git Index`; ở `commit` (`--ci-verify`): so sánh `baseCommitOid -> targetCommitOid` (`HEAD` mới) qua `git diff-tree --no-renames`. Đảm bảo cùng một thay đổi hợp lệ cho ra **cùng 1 `codeSnapshotHash`** ở cả 3 mode (`G-22`, `G-23`, `G-24`). |
| **P0-09** | Nếu CI chạy `verify_guard.mjs` lấy từ chính PR, Worker có thể sửa `verify_guard.mjs` để luôn trả `exit 0`; và `STATE_LOCK.json` + footer trong cùng PR vẫn do Worker kiểm soát. | **Tách bạch Trusted Verifier & Khai báo Rõ Phạm vi Tier 2**: (1) Trong `--ci-verify`, hỗ trợ cờ `--trusted-verifier` (CI checkout `verify_guard.mjs` từ nhánh bảo vệ `origin/master` thay vì chạy code của PR, và chặn mọi PR sửa `.agents/scripts/` hoặc `.github/workflows/` nếu không có GitHub Required Review / `CODEOWNERS`). (2) Ghi rõ trong phạm vi local Task 4–7: chỉ nghiệm thu **Tier 1 + thuật toán `--ci-verify` (`G-21`, `G-25`)**; việc đạt **Tier 2 thực tế** đòi hỏi cấu hình GitHub Branch Protection + CODEOWNERS + nguồn approval ngoài quyền ghi của Worker. |
| **P0-10** | Tiêu đề kế hoạch chung `(TASK 4 – TASK 7)` gây deadlock khi `ROADMAP.md` chuyển sang Task 5 nhưng `CURRENT_PLAN.md` và `STATE_LOCK.json` vẫn giữ `task-4`, đồng thời `allowedPaths` bị cấp tràn giữa các task. | **Per-Task Active Metadata Header & Strict Task Transition**: Bổ sung trường có cấu trúc `- **Active Task**: \`task-x\`` ở đầu `CURRENT_PLAN.md` làm nguồn xác định duy nhất đối chiếu với mục `[ ]` đầu tiên trong `ROADMAP.md`. Mỗi Task (4, 5, 6, 7) có danh sách `allowedPaths` riêng biệt và phải qua chu trình Plan Approval $\rightarrow$ Implement $\rightarrow$ Code Review độc lập (`G-26`). |
| **P0-11** | Symlink nằm bên trong repo (ví dụ `src/link -> ../.agents/scripts/`) vẫn nằm trong `realRepoRoot` nên có thể lách qua kiểm tra vùng `protectedInfrastructure`. | **Dual-Path Zone Policy Enforcement**: Trong `--check-tool`, kiểm tra chính sách vùng (`checkPathZonePolicy`) trên **CẢ đường dẫn logic ban đầu (`logicalRelPath`) LẪN đường dẫn thực tế sau khi phân giải symlink (`realRelPath`)**. Nếu một trong hai chạm vùng cấm (`.git/**`, Immutable State files, `protectedInfrastructure` chưa ủy quyền, hoặc ngoài repo) hoặc là broken symlink trỏ vào vùng cấm $\rightarrow$ **CHẶN NGAY (`exit 2`)** (`G-27`). |
| **P0-12** | Nâng cấp chính `verify_guard.mjs` ở Task 4 có thể làm hệ thống tự khóa do lock cũ bị từ chối trong khi trạng thái `PENDING` cấm sửa `.agents/scripts/`. | **Controlled Two-Step Bootstrap (`--bootstrap-v12`)**: (1) Giữ Guard v1.1 đang `STATUS: APPROVED` khi viết code Task 4. (2) Chạy pass bộ kiểm thử cô lập cho Guard v1.2 trên repo tạm trước khi kích hoạt. (3) Cung cấp lệnh chuyển đổi có kiểm soát `verify_guard.mjs --bootstrap-v12` kiểm tra tính hợp lệ của `CURRENT_PLAN.md` + `MENTOR_FEEDBACK.md` và nâng cấp đồng bộ `STATE_LOCK.json` + footer sang chuẩn v1.2 kèm điểm khôi phục tự động nếu lỗi (`G-30`). |
| **P1-09** | Hai lệnh `fs.renameSync` liên tiếp (cho feedback và `STATE_LOCK.json`) không tạo thành một giao dịch nguyên tử; nếu dừng giữa chừng sẽ lệch trạng thái. | **Two-Phase Commit Journal (`writePhase` + `transactionId`)**: Dùng `STATE_LOCK.json` làm Commit Point có thẩm quyền với `transactionId` và `writePhase: "PREPARING" -> "COMMITTED"`, đồng thời nhúng `TX: <transactionId>` vào footer. Nếu `writePhase !== "COMMITTED"` hoặc `footer.txId !== lock.transactionId` $\rightarrow$ phát hiện ghi dở (torn write) và **FAIL-CLOSED** (`G-28`). |
| **P1-10** | `git status --porcelain=v1 -z` có thứ tự 2 đường dẫn đặc biệt cho rename (`R`/`C`) và phụ thuộc ngưỡng rename. | **Canonical `--no-renames` Normalization**: Luôn truyền `--no-renames` cho `git diff-index` / `git diff-tree`, và khi phân tích `git status --porcelain=v1 -z -uall`, tách mọi entry `R`/`C` thành 2 thay đổi độc lập (Delete đường dẫn cũ + Add/Modify đường dẫn mới), xử lý chính xác cả trường hợp di chuyển file qua ranh giới `reviewScope` (`G-29`). |
| **P1-11** | External clean filter có thể không tất định hoặc thất bại; Git OID có thể là SHA-1 (40 hex) hoặc SHA-256 (64 hex). | **Strict Filter Exit Check & Hash-Agnostic Git OID**: Kiểm tra `exitCode === 0` của `git hash-object --stdin --path`; chấp nhận Git blob OID `/^[a-f0-9]{40}([a-f0-9]{24})?$/i`; nếu filter tạo blob trong Index khác với `worktree` lúc review $\rightarrow$ **FAIL-CLOSED** (`G-31`). |
| **P1-12** | `postTestSnapshot.hash` đúng chưa chứng minh gói review gửi Mentor chứa đầy đủ nội dung (không bị lỗi đọc file hay thiếu dữ liệu). | **Review Bundle Completeness Contract**: Kiểm tra mọi file thay đổi/mới trong `reviewScope` đều được đọc thành công (`0 read errors`), đính kèm đầy đủ `manifest` + `testEvidence` + `gitDiff`, và khóa `reviewBundleHash = sha256(fullBundleText)` vào `STATE_LOCK.json`. |
| **P1-13** | Lưu backup trong `os.tmpdir()` không bền vững qua reboot; thiếu manifest kiểm tra toàn vẹn toàn bộ file backup và Git Index. | **Durable Repo-Local Backup (`.agents/backups/`)**: Lưu tại `.agents/backups/<timestamp>-<taskId>/` (được ignore trong `.gitignore`), tạo `git write-tree` lưu trạng thái Index, ghi `backup-manifest.json` chứa SHA-256 của mọi file đã sao lưu và kiểm chứng toàn bộ manifest trước khi `git restore`. |
| **P1-14** | Tiêu chí `100% PASS` chưa phân biệt rõ `SKIP` hợp lệ của `fs_fault.test.js` với yêu cầu `0 SKIP` của bộ test Guard. | **Explicit Metric Contract**: Yêu cầu toàn cục `0 FAIL` và `exitCode === 0`; `tests/fs_fault.test.js` cho phép `SKIP` có lý do trên Windows NTFS; riêng `tests/guard_integrity.test.js` bắt buộc **`31/31 PASS | 0 FAIL | 0 SKIP`**. |

---

## 2. Mô Hình Tin Cậy 2 Tầng & Giới Hạn Thực Thi (Trust Boundary Specification — `P0-03`, `P0-07`, `P0-09`)

1. **Tier 1 — Local Workflow Integrity Guard (Nghiệm thu trong Task 4–7)**:
   - Bảo vệ tính nhất quán giữa `CURRENT_PLAN.md`, `MENTOR_FEEDBACK.md`, `CODE_REVIEW_FEEDBACK.md`, `STATE_LOCK.json`, Working Tree, Git Index và Commit Tree khi Worker hoạt động qua các công cụ chuẩn.
   - **Giới hạn**: Không tuyên bố Local Hook hoặc SHA-256 cục bộ chống được tiến trình Worker có toàn quyền shell/filesystem cố tình chạy `git commit --no-verify`, sửa trực tiếp `.agents/scripts/` ngoài hook, hoặc đồng thời viết lại cả 3 file `.md`/`.json`.
   - **Cấm tuyệt đối Env-Var Bypass**: Không sử dụng bất kỳ biến môi trường nào (`AI_WORKFLOW_ALLOW_*`) để mở khóa.
2. **Tier 2 — Independent Verification Boundary (Yêu cầu Hạ tầng Ngoài Quyền Worker)**:
   - Để đạt Tier 2 thực chất trên môi trường đội nhóm/CI:
     1. Nhánh `master`/`main` bật **GitHub Branch Protection** + **Required Status Checks** + **CODEOWNERS Required Review** cho `.agents/**`, `.github/**`, `package.json`.
     2. Job CI lấy trình kiểm chứng `verify_guard.mjs` từ nhánh bảo vệ (`origin/master`), tuyệt đối không thực thi trực tiếp file `verify_guard.mjs` nằm trong nhánh PR chưa được duyệt (`G-25`).
     3. Nguồn phê duyệt độc lập (PR Approval từ tài khoản Reviewer tách biệt hoặc chữ ký ngoài quyền Worker) được đối chiếu với `codeSnapshotHash` và `baseCommitOid`.
   - **Tuyên bố phạm vi nghiệm thu**: Trong khuôn khổ repository cục bộ của Task 4–7, hệ thống hoàn thiện **100% Tier 1** và cung cấp đầy đủ **thuật toán kiểm chứng `commit` mode (`--ci-verify --base <oid> --commit <oid>`)**; việc kích hoạt Tier 2 thực tế phụ thuộc vào cấu hình quyền trên GitHub Remote.

---

## 3. Bốn Hợp Đồng Kỹ Thuật Cốt Lõi (Core Technical Contracts v1.2)

### 3.1. Hợp Đồng 1: Approval State, Task Binding & Two-Phase Commit Journal (`P0-01`, `P0-02`, `P0-06`, `P0-10`, `P1-09`, `P1-12`)

#### 3.1.1. Schema `STATE_LOCK.json` v1.2
```json
{
  "schemaVersion": "1.2",
  "taskId": "task-4",
  "approvalState": "PENDING",
  "writePhase": "COMMITTED",
  "transactionId": "tx-550e8400-e29b-41d4-a716-446655440000",
  "planHash": "",
  "planReviewRequestId": "",
  "planApprovedAt": "",
  "allowedPaths": [
    ".agents/scripts/verify_guard.mjs",
    ".agents/scripts/ask_mentor.mjs",
    ".agents/scripts/init_project.mjs",
    ".agents/scripts/checkpoint.mjs",
    "tests/guard_integrity.test.js",
    "package.json"
  ],
  "baseCommitOid": "",
  "codeSnapshotHash": "",
  "reviewBundleHash": "",
  "codeReviewRequestId": "",
  "testCommandHash": "",
  "testExitCode": null,
  "codeApprovedAt": "",
  "updatedAt": "2026-11-07T15:00:00.000Z"
}
```

#### 3.1.2. Xác định `activeTaskId` Tất định & Chuyển tiếp Giữa Các Task (`P0-10`)
1. **Nguồn xác định `activeTaskId`**:
   - Hàm `resolveActiveTaskContract(root)` đọc dòng metadata `- **Active Task**: \`(task-[a-z0-9-]+)\`` trong `CURRENT_PLAN.md` VÀ mục chưa hoàn thành `- [ ] ... Task <id>` đầu tiên trong `ROADMAP.md`.
   - Nếu một trong hai thiếu hoặc hai giá trị không trùng nhau $\rightarrow$ trả về `{ ok: false, reason: "TASK_ID_MISMATCH_BETWEEN_PLAN_AND_ROADMAP" }`.
2. **Chuyển tiếp RPIR theo từng Task (`Task 4 -> Task 5 -> Task 6 -> Task 7`)**:
   - Mỗi Task chỉ được cấp `allowedPaths` của riêng Task đó (đọc từ mục `### Files mục tiêu được ủy quyền (Task hiện hành)` trong `CURRENT_PLAN.md`).
   - Ngay khi một Task hoàn tất commit và đánh dấu `[x]` trong `ROADMAP.md`, bước chuyển sang Task kế tiếp bắt buộc cập nhật `- **Active Task**: \`task-<next>\`` trong `CURRENT_PLAN.md` và đặt lại `STATE_LOCK.json` về `approvalState: "PENDING"`, `planHash: ""`, `codeSnapshotHash: ""`. Approval của `task-4` hoàn toàn không thể dùng để sửa hay commit cho `task-5` (`G-26`).

#### 3.1.3. Định dạng Mandatory Single-Footer & Two-Phase Commit Journal (`P0-01`, `P1-09`)
- **Footer bắt buộc duy nhất trong `MENTOR_FEEDBACK.md`**:
  ```html
  <!-- PLAN_SHA256: <64-hex> | TASK: <taskId> | REQ: <planReviewRequestId> | TX: <transactionId> -->
  ```
- **Footer bắt buộc duy nhất trong `CODE_REVIEW_FEEDBACK.md`**:
  ```html
  <!-- CODE_SHA256: <64-hex> | BASE: <baseCommitOid> | BUNDLE: <reviewBundleHash> | TASK: <taskId> | REQ: <codeReviewRequestId> | TEST_CMD_SHA256: <testCommandHash> | TEST_EXIT: 0 | TX: <transactionId> -->
  ```
- **Quy trình Ghi 2 Pha Chống Torn-Write (`P1-09` — Test `G-28`)**:
  1. Sinh `transactionId = "tx-" + crypto.randomUUID()`.
  2. **Bước 1 (Prepare)**: Ghi atomic `STATE_LOCK.json` với `writePhase: "PREPARING"`, `transactionId`, và các trường hash mới.
  3. **Bước 2 (Write Feedback)**: Ghi atomic file `MENTOR_FEEDBACK.md` (hoặc `CODE_REVIEW_FEEDBACK.md`) có nhúng `TX: <transactionId>` ở dòng footer duy nhất.
  4. **Bước 3 (Commit)**: Ghi atomic `STATE_LOCK.json` với `writePhase: "COMMITTED"`.
  - **Quy tắc Kiểm chứng Đọc (Fail-Closed)**: Mọi hàm đọc (`verifyPlanGuard`, `verifyPreCommitGuard`) đều kiểm tra `lock.writePhase === "COMMITTED"` **VÀ** `footer.txId === lock.transactionId`. Nếu tiến trình bị ngắt giữa Bước 1, Bước 2 hoặc Bước 3, `writePhase` vẫn là `"PREPARING"` hoặc `txId` lệch nhau $\rightarrow$ Guard lập tức từ chối (`ok: false`, báo lỗi `TORN_APPROVAL_WRITE_DETECTED`).

---

### 3.2. Hợp Đồng 2: Ba Chế Độ Snapshot Tất Định (`worktree`, `index`, `commit`) (`P0-04`, `P0-08`, `P1-10`, `P1-11`)

Hàm `captureCodeSnapshot(root, cfg, { mode: 'worktree' | 'index' | 'commit', taskId, baseCommitOid, targetCommitOid })` là **hàm chỉ đọc 100% (Pure Read-Only)**:

1. **Xác định `baseCommitOid` (`P0-08`)**:
   - Ở `mode === 'worktree'`: nếu chưa truyền `baseCommitOid`, lấy `git rev-parse --verify HEAD`.
   - Ở `mode === 'index'`: bắt buộc truyền `baseCommitOid = lock.baseCommitOid`, và kiểm tra `git rev-parse --verify HEAD === lock.baseCommitOid`. Nếu `HEAD` hiện tại đã khác `lock.baseCommitOid` $\rightarrow$ **FAIL-CLOSED (`HEAD_MOVED_AFTER_REVIEW` — Test `G-23`)**.
   - Ở `mode === 'commit'`: bắt buộc truyền `baseCommitOid = lock.baseCommitOid` và `targetCommitOid` (mặc định `HEAD`). Kiểm tra `baseCommitOid` là tổ tiên hợp lệ của `targetCommitOid` (chặn trường hợp lấy `HEAD` mới làm base — Test `G-24`).
2. **Thu thập Danh sách Đường dẫn Thay đổi Không Phụ thuộc Ngưỡng Rename (`P1-10`)**:
   - **Ở `mode === 'worktree'`**:
     - Gọi `git diff-index --no-renames -z <baseCommitOid>` kết hợp `git ls-files --others --exclude-standard -z` (hoặc phân tích `git status --porcelain=v1 -z -uall` với quy tắc: nếu gặp bản ghi `R` hoặc `C`, đọc cả 2 đường dẫn NUL-terminated kế tiếp và tách thành 2 đường dẫn độc lập để kiểm tra trên cây thực tế).
     - Nhờ chuẩn hóa mọi thay đổi về trạng thái cuối cùng của từng đường dẫn so với `baseCommitOid` (Added `A`, Modified `M`, Deleted `D`, Type-changed `T`), kết quả hoàn toàn không phụ thuộc vào `diff.renames` hay ngưỡng tương đồng của Git!
   - **Ở `mode === 'index'`**:
     - Kiểm tra không có unmerged entries và không có bất kỳ thay đổi unstaged (`git diff-files -z -- <reviewScope>`) hay untracked (`git ls-files --others --exclude-standard -z -- <reviewScope>`) nào trong `reviewScope`.
     - Lấy danh sách đường dẫn thay đổi giữa `<baseCommitOid>` và Git Index bằng lệnh:
       ```bash
       git diff-index --cached --no-renames -z <baseCommitOid>
       ```
   - **Ở `mode === 'commit'`**:
     - Lấy danh sách đường dẫn thay đổi giữa `<baseCommitOid>` và `<targetCommitOid>` bằng lệnh:
       ```bash
       git diff-tree -r --no-renames -z <baseCommitOid> <targetCommitOid>
       ```
3. **Tính `canonicalBlobHash` & Kiểm tra Clean Filters (`P0-04`, `P1-11`)**:
   - Với mỗi đường dẫn `relPath` thuộc `reviewScope` có thay đổi so với `baseCommitOid`:
     - Nếu đường dẫn không còn tồn tại ở trạng thái đích (`worktree` / `index` / `targetCommitOid`):
       - `changeType = "D"`, `fileMode = "000000"`, `objectType = "deleted"`, `canonicalBlobHash = "DELETED"`.
     - Nếu đường dẫn tồn tại ở trạng thái đích:
       - Xác định `changeType`: nếu `relPath` không tồn tại trong `<baseCommitOid>` (`git cat-file -e <baseCommitOid>:<relPath>` trả khác 0) thì `changeType = "A"`, ngược lại `changeType = "M"` (hoặc `"T"` nếu đổi loại đối tượng).
       - **Ở `index`**: lấy `<fileMode>` và `<canonicalBlobHash>` trực tiếp từ `git ls-files --stage -z -- <relPath>`.
       - **Ở `commit`**: lấy `<fileMode>` và `<canonicalBlobHash>` trực tiếp từ `git ls-tree -z <targetCommitOid> -- <relPath>`.
       - **Ở `worktree`**:
         - Tính `<canonicalBlobHash>` bằng `git hash-object --stdin --path="<relPath>"` (không có `-w`).
         - **Kiểm tra lỗi Filter (`P1-11`)**: Nếu lệnh `git hash-object` trả `exitCode !== 0` hoặc stdout không khớp biểu thức OID hợp lệ `/^[a-f0-9]{40}([a-f0-9]{24})?$/i` $\rightarrow$ **FAIL-CLOSED**.
4. **Sắp xếp UTF-8 Byte Order & Băm Manifest**:
   - Sắp xếp các entries theo `Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'))`.
   - Tạo chuỗi Canonical Manifest (như mục 3.3.2 của v1.1, dùng `BASE_COMMIT_OID:<baseCommitOid>`) và tính `codeSnapshotHash = sha256(manifest)`.
   - **Định lý Bất biến (`G-22`)**: Vì cả 3 chế độ `worktree`, `index`, `commit` đều so sánh cùng một gốc `baseCommitOid`, dùng `--no-renames` quy về trạng thái đích (`A`/`M`/`D`/`T`), cùng cách lấy `fileMode` và cùng Git blob OID sau clean filter, nên khi nội dung được stage và commit đúng như lúc review:
     $$\text{Hash}_{\text{worktree}}(A \to W) \equiv \text{Hash}_{\text{index}}(A \to I) \equiv \text{Hash}_{\text{commit}}(A \to C)$$

---

### 3.3. Hợp Đồng 3: Dual-Path Symlink Protection & Three-Zone Scope Policy (`P0-05`, `P0-11`, `P1-05`, `P1-06`)

1. **Giải quyết Đường dẫn Kép (`resolveDualTargetPaths(repoRoot, rawPath)` — `P0-11`)**:
   - Bước 1: Tính đường dẫn tuyệt đối logic `logicalAbs = path.resolve(repoRoot, rawPath)` và đường dẫn tương đối logic `logicalRel = toPosixRel(repoRoot, logicalAbs)`.
   - Bước 2: Tìm tiền tố thư mục/file sâu nhất đang tồn tại của `logicalAbs`:
     - Nếu `fs.existsSync(logicalAbs)` hoặc `lstatSync` thành công (kể cả broken symlink):
       - Nếu bản thân nó hoặc cha của nó là broken symlink: đọc đích symlink bằng `fs.readlinkSync` và giải quyết thành `realAbs` để kiểm tra đích trỏ tới đâu.
       - Nếu tồn tại thực tế: dùng `fs.realpathSync.native(logicalAbs)` để lấy `realAbs`.
     - Nếu chưa tồn tại: lấy `fs.realpathSync.native` của thư mục tổ tiên gần nhất đang tồn tại rồi ghép phần đuôi tương đối còn lại để được `realAbs`.
   - Bước 3: Tính `realRel = toPosixRel(realRepoRoot, realAbs)`.
2. **Kiểm tra Chính sách Vùng trên Cả Hai Đường dẫn (`logicalRel` VÀ `realRel` — Test `G-27`)**:
   - Thao tác tool chỉ được phép (`allow`) khi **CẢ `logicalRel` LẪN `realRel`** đều được phép:
     - Cấm tuyệt đối (`.git/**`, ngoài repository, `.agents/state/MENTOR_FEEDBACK.md`, `CODE_REVIEW_FEEDBACK.md`, `STATE_LOCK.json`, `.mentor_tx.lock`) $\rightarrow$ nếu `logicalRel` **HOẶC** `realRel` rơi vào đây $\rightarrow$ **CHẶN NGAY (`exit 2`)**.
     - Vùng `protectedInfrastructure` (`.agents/scripts/**`, `.agents/hooks/**`, `.agents/skills/**`, `.agents/hooks.json`, `.agents/roles.json`, `.agents/config.json`, `GEMINI.md`) $\rightarrow$ nếu `logicalRel` **HOẶC** `realRel` rơi vào đây, bắt buộc `verifyPlanGuard(repoRoot)` phải `ok: true` **VÀ** đường dẫn đó phải nằm trong `lock.allowedPaths` của Task hiện hành.
     - Vùng `reviewScope` (`src/**`, `tests/**`, `package.json`, `package-lock.json`, `.gitattributes`) $\rightarrow$ nếu `logicalRel` **HOẶC** `realRel` rơi vào đây, bắt buộc `verifyPlanGuard(repoRoot)` phải `ok: true`.

---

### 3.4. Hợp Đồng 4: Quy Trình Bootstrap Nâng Cấp Guard & Phục Hồi Có Kiểm Chứng (`P0-12`, `P1-13`)

#### 3.4.1. Quy trình Bootstrap Nâng cấp Guard ở Task 4 Không Tự Khóa (`P0-12` — Test `G-30`)
Để tránh deadlock khi nâng cấp từ Guard v1.1 sang Guard v1.2 trong Task 4:
1. **Bước 1 (Backup & Baseline Check)**: Chạy script tạo bản sao lưu đầy đủ vào `.agents/backups/pre-task-4/` (bao gồm bản copy của `.agents/scripts/verify_guard.mjs` v1.1 và `.agents/state/`).
2. **Bước 2 (Phê duyệt Kế hoạch dưới Guard v1.1)**: Bản kế hoạch `CURRENT_PLAN.md` v1.2 này được duyệt dưới Guard v1.1 hiện hữu (`MENTOR_FEEDBACK.md` có `STATUS: APPROVED`).
3. **Bước 3 (Cài đặt & Chạy `--bootstrap-v12`)**:
   - Sau khi cập nhật mã nguồn `.agents/scripts/verify_guard.mjs` lên bản v1.2 (vẫn giữ `check_plan_approved.sh` tương thích), chạy lệnh:
     ```bash
     node .agents/scripts/verify_guard.mjs --bootstrap-v12 --task task-4
     ```
   - Lệnh `--bootstrap-v12` thực hiện:
     1. Kiểm tra `MENTOR_FEEDBACK.md` hiện có dòng đầu `STATUS: APPROVED` từ Mentor.
     2. Tính `planHash = computeCanonicalPlanHash(CURRENT_PLAN.md)`, trích xuất `allowedPaths` của `task-4`, sinh `planReviewRequestId` và `transactionId`.
     3. Ghi theo giao dịch 2 pha (`PREPARING -> Feedback Footer -> COMMITTED`) để nâng cấp đồng bộ cả `MENTOR_FEEDBACK.md` (bổ sung footer chuẩn v1.2 nếu bản v1.1 chưa ghi `REQ`/`TX`) và `STATE_LOCK.json` lên `schemaVersion: "1.2"`, `approvalState: "PLAN_APPROVED"`.
     4. Tự chạy ngay `verifyPlanGuard()` để xác nhận trạng thái sau bootstrap đạt `ok: true`. Nếu thất bại, tự động khôi phục từ `.agents/backups/pre-task-4/`.

#### 3.4.2. Sao lưu Bền vững trong `.agents/backups/` & Phục hồi Có Kiểm chứng (`P1-13`)
- Thay thế `os.tmpdir()` bằng thư mục bền vững `.agents/backups/<ISO-timestamp>-<taskId>/` (được khai báo trong `.gitignore` để không làm bẩn Git status).
- Mỗi gói backup bao gồm:
  1. Bản sao đầy đủ của `.agents/state/` và `.agents/scripts/`.
  2. File `index.tree` ghi lại OID từ lệnh `git write-tree` (bảo toàn trạng thái Git Index đã stage) và `worktree.patch` (`git diff HEAD`).
  3. File `backup-manifest.json` lưu danh sách mọi file trong gói backup kèm kích thước byte và mã băm `sha256` của từng file.
- Khi cần khôi phục:
  - Chạy kiểm chứng toàn bộ các file trong gói backup khớp 100% với `backup-manifest.json` trước khi gọi `git restore --source=<baseline> --staged --worktree -- <target-files>`.
  - Ghi nhận rõ rủi ro: `git restore` sẽ ghi đè nội dung các file được chỉ định về bản sao lưu/baseline, và `git revert` trên commit đã tạo có thể phát sinh conflict cần xử lý thủ công.

---

## 4. Phân Rã Lộ Trình RPIR Theo Từng Task & Phạm Vi Ủy Quyền (`P0-10`, `P1-14`)

### Files mục tiêu được ủy quyền (Task hiện hành: `task-4`)
- `.agents/scripts/verify_guard.mjs`
- `.agents/scripts/ask_mentor.mjs`
- `.agents/scripts/init_project.mjs`
- `.agents/scripts/checkpoint.mjs`
- `tests/guard_integrity.test.js`
- `package.json`
- `.gitignore`

*(Lưu ý: `.agents/scripts/check_plan_approved.sh` và `README.md` sẽ được cấp quyền tương ứng khi chuyển sang `task-6` và `task-7`).*

---

### Task 4 — Approval State, Two-Phase Commit Journal & Bootstrap Contract
- **Active Task**: `task-4`
- **Acceptance Criteria**:
  1. `STATE_LOCK.json` v1.2 với FSM (`PENDING -> PLAN_APPROVED -> CODE_APPROVED`), `writePhase` (`PREPARING -> COMMITTED`), `transactionId`, `baseCommitOid`, `reviewBundleHash`, và kiểm tra `activeTaskId` đồng nhất giữa `CURRENT_PLAN.md` và `ROADMAP.md`.
  2. `verifyPlanGuard()` kiểm tra đủ 10 điều kiện fail-closed + phát hiện torn write (`writePhase !== "COMMITTED"` hoặc lệch `TX`).
  3. Lệnh `--bootstrap-v12` nâng cấp an toàn khóa trạng thái từ v1.1 lên v1.2 mà không gây tự khóa; migration từ lock cũ không bao giờ tự cấp `CODE_APPROVED`.
  4. **Kiểm thử bắt buộc tại Task 4**: Chạy pass `G-1..G-4`, `G-10..G-16`, `G-26`, `G-28`, `G-30` (`14/14 PASS | 0 FAIL | 0 SKIP`).

### Task 5 — Three-Mode Deterministic Snapshot Contract (`worktree`, `index`, `commit`)
- **Active Task**: `task-5` (cập nhật `CURRENT_PLAN.md` và xin duyệt `task-5` sau khi hoàn thành `task-4`)
- **Acceptance Criteria**:
  1. `captureCodeSnapshot()` 100% chỉ đọc, hỗ trợ đủ 3 mode (`worktree`, `index`, `commit`) dựa trên `baseCommitOid` cố định, dùng `--no-renames` và UTF-8 byte order (`Buffer.compare`).
  2. Chứng minh bằng kiểm thử rằng cùng một thay đổi hợp lệ sinh ra cùng một `codeSnapshotHash` ở cả 3 mode `worktree`, `index`, `commit` (`G-22`).
  3. Chặn mọi trường hợp `HEAD` dịch chuyển trước khi commit (`G-23`), CI dùng sai base (`G-24`), rename vượt ranh giới scope (`G-29`), hoặc clean filter không tất định (`G-31`).
  4. **Kiểm thử bắt buộc tại Task 5**: Chạy pass thêm `G-5..G-9`, `G-17`, `G-18`, `G-20`, `G-22`, `G-23`, `G-24`, `G-29`, `G-31`.

### Task 6 — Dual-Path Infrastructure Protection & Trusted CI Verifier
- **Active Task**: `task-6`
- **Acceptance Criteria**:
  1. `check_plan_approved.sh` + `verify_guard.mjs --check-tool` thực thi kiểm tra đường dẫn kép (`logicalRelPath` VÀ `realRelPath`), chặn tuyệt đối symlink nội bộ trỏ vào `.agents/scripts/` (`G-27`), chặn `.git/**` và Immutable State files.
  2. Chế độ `--ci-verify` hỗ trợ `--trusted-verifier` (phát hiện và từ chối khi PR tự ý sửa verifier để trả `exit 0` — `G-25`) và kiểm chứng commit tree so với `lock.baseCommitOid` (`G-21`).
  3. **Kiểm thử bắt buộc tại Task 6**: Chạy pass thêm `G-19`, `G-21`, `G-25`, `G-27`.

### Task 7 — Full 31-Scenario Adversarial Regression Suite & Documentation
- **Active Task**: `task-7`
- **Acceptance Criteria (`P1-14`)**:
  1. Bộ kiểm thử `tests/guard_integrity.test.js` thực thi toàn bộ **31 kịch bản (`G-1` $\rightarrow$ `G-31`)** trên các Git repository tạm cô lập đạt **`31/31 PASS | 0 FAIL | 0 SKIP`** (`exitCode === 0`).
  2. Lệnh `npm test` chạy toàn bộ 3 suite (`src/todo.test.js`, `tests/fs_fault.test.js`, `tests/guard_integrity.test.js`) đạt **`0 FAIL`** và **`exitCode === 0`** (các kịch bản `SKIP` do giới hạn HĐH trong `fs_fault.test.js` được thống kê rõ kèm lý do).

---

## 5. Bảng Tổng Hợp 31 Kịch Bản Kiểm Thử Đối Kháng (`G-1` $\rightarrow$ `G-31`)

| Mã Test | Task | Kịch bản Kiểm thử (trên Git repo cô lập) | Kỳ vọng |
| :--- | :---: | :--- | :---: |
| **G-1 $\rightarrow$ G-4** | Task 4 | Thiếu `planHash` (G-1), sửa `CURRENT_PLAN.md` 1 ký tự (G-2), lệch footer hash (G-3), và trường hợp chuẩn hợp lệ (G-4) | `REJECT` (1-3) / `ALLOW` (4) |
| **G-5 $\rightarrow$ G-9** | Task 5 | Thiếu `CODE_APPROVED`/footer (G-5), file untracked/unstaged mới (G-6), lệch Git Index blob (G-7), Mixed-Scope commit (G-8), và pre-commit hợp lệ (G-9) | `REJECT` (5-8) / `ALLOW` (9) |
| **G-10 $\rightarrow$ G-16** | Task 4 | Xóa footer (G-10), 2 footer mâu thuẫn (G-11), `taskId` cũ (G-12), JSON/schema lỗi (G-13), migration từ `codeDiffHash` cũ (G-14), TOCTOU drift (G-15), phản hồi request cũ đến muộn (G-16) | `REJECT` / Không cấp `CODE_APPROVED` |
| **G-17 $\rightarrow$ G-21** | Task 5 & 6 | Partial staging (G-17), đổi `fileMode`/symlink (G-18), sửa `.agents/config.json` trái phép (G-19), đổi `testCommand` sau review (G-20), commit bằng `--no-verify` bị `--ci-verify` phát hiện (G-21) | `REJECT` |
| **G-22** | Task 5 | Cùng một thay đổi hợp lệ được tính snapshot ở cả 3 mode: `worktree`, `index`, và `commit` | **3 mã `codeSnapshotHash` bằng nhau tuyệt đối** |
| **G-23** | Task 5 | `HEAD` thay đổi (có thêm commit khác) sau khi code review được duyệt nhưng trước khi chạy `git commit` | **REJECT** (`HEAD !== baseCommitOid`) |
| **G-24** | Task 5 | Chế độ `--ci-verify` cố tình truyền `HEAD` mới làm base thay vì `lock.baseCommitOid` đã khóa | **REJECT** |
| **G-25** | Task 6 | PR sửa đổi `.agents/scripts/verify_guard.mjs` để luôn trả `exit 0` khi chạy kiểm chứng với `--trusted-verifier` từ baseline | **REJECT** (`VERIFIER_TAMPERED`) |
| **G-26** | Task 4 | Sau khi hoàn thành `task-4` và `ROADMAP.md` chuyển sang `task-5`, cố dùng lại lock `PLAN_APPROVED` của `task-4` | **REJECT** (`TASK_ID_MISMATCH`) |
| **G-27** | Task 6 | Tạo symlink nội bộ `src/internal-link -> ../.agents/scripts/` rồi gọi tool ghi `src/internal-link/verify_guard.mjs` | **REJECT** (Dual-Path Policy chặn `realRelPath`) |
| **G-28** | Task 4 | Mô phỏng tiến trình dừng giữa bước ghi `MENTOR_FEEDBACK.md` và `STATE_LOCK.json` (`writePhase === "PREPARING"` hoặc lệch `TX`) | **REJECT** (`TORN_APPROVAL_WRITE_DETECTED`) |
| **G-29** | Task 5 | Đổi tên file (`git mv`) có ký tự đặc biệt và di chuyển file qua ranh giới `reviewScope` | **Manifest ghi nhận chính xác Delete + Add; REJECT nếu lệch** |
| **G-30** | Task 4 | Chạy `--bootstrap-v12` nâng cấp từ lock v1.1 và thử nghiệm khôi phục tự động khi bootstrap gặp lỗi | **Bootstrap thành công & Rollback an toàn** |
| **G-31** | Task 5 | Cấu hình Git clean filter tạo ra blob trong Index khác với snapshot đã duyệt ở `worktree` | **REJECT** |
