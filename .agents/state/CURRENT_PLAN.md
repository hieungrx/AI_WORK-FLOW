# CURRENT_PLAN: Task 1 — Tối ưu hóa Cơ chế Ghi nhận, Khử trùng lặp và Quản lý Vòng đời Nợ Kỹ thuật (`src/tech_debt.mjs`)

## 1. Bối cảnh & Vấn đề Thực tế (Problem Statement)
Qua phiên chạy thực nghiệm `ask_mentor.mjs` trên trình duyệt Chrome (`9222`), cơ chế ghi nhận `TECH_DEBT.md` hiện tại bộc lộ 4 hạn chế:
1. **Nhiễu và phình số lượng mục mỗi vòng**: Trong 1 vòng review, Mentor có thể sinh 7–9 mục P1/P2 (bao gồm cả các câu `"Không có"`, hoặc nhắc lại tiêu chí nghiệm thu).
2. **Chưa tách biệt Tiêu đề ngắn (`summary`) và Chi tiết (`detail`)**: Toàn bộ câu dài 300–400 ký tự bị gộp chung vào `title`, làm dòng markdown và comment khóa `<!-- TD:... -->` quá dài, khó đọc.
3. **Khóa khử trùng lặp (`dedupKey`) quá phụ thuộc vào ID và câu chữ đầy đủ**:
   - Hiện tại khóa là `${threadKey}|${provider}|${item.id}|${item.title}`.
   - Nếu cùng một vấn đề trong `task-1` được nêu lại ở vòng 2, hoặc ở pha `review-code` (`task-1-review` so với `task-1-plan`), hoặc bởi provider thứ hai (`gemini` vs `chatgpt`) với mã số khác (`P1-02` thay vì `P1-01`) hay khác phần giải thích phía sau dấu `—`, hệ thống vẫn ghi trùng lặp vào `TECH_DEBT.md`.
4. **Thiếu quản lý vòng đời (Lifecycle)**: Chưa có hàm phân tích (`parseTechDebtFile`), đánh dấu đã xử lý (`resolveTechDebt`) và tổng hợp thống kê (`summarizeTechDebt`).

---

## 2. Thiết kế Kỹ thuật (`src/tech_debt.mjs` & `tests/tech_debt.test.mjs`)

### 2.1. Các Hằng số, Chuẩn hóa Toàn vẹn & Fingerprint Chống Va chạm (`[P0-02]`)
1. `DEFAULT_MAX_TECH_DEBT_PER_ROUND = 5`:
   - Giới hạn số mục P1/P2 tối đa được ghi nhận trong một lượt review (ưu tiên giữ `P1` trước `P2`).
2. `splitIssueTitle(rawTitle)`:
   - Chuẩn hóa xuống dòng trước khi tách; tách chuỗi đầu vào theo dấu phân cách đầu tiên (` — `, ` – `, ` - `, hoặc `: `) thành `{ summary, detail }`.
   - Nếu không có dấu phân cách: `summary = cleanTitle.trim()`, `detail = ''`.
3. `extractTaskIdFromThreadKey(threadKey)`:
   - Chuẩn hóa `task-1-plan`, `task-1-review`, `task-1-rescue` về cùng gốc `task-1` (chỉ cho phép ký tự `[a-z0-9_-]`) để khử trùng lặp xuyên suốt vòng đời của một Task.
4. `normalizeCanonicalSummary(summary)` (**Giải quyết `[P0-02]` — KHÔNG cắt 80 ký tự**):
   - Chuẩn hóa Unicode (`NFC`), chuyển về chữ thường, loại bỏ ký tự trang trí markdown (`*`, `` ` ``, `_`, `[`, `]`), chuẩn hóa dấu câu và gộp khoảng trắng liên tiếp thành 1 dấu cách trên **toàn bộ chiều dài chuỗi `summary`** (tuyệt đối không cắt 80 ký tự khi tính danh tính).
5. `buildTechDebtFingerprint(taskIdOrThreadKey, summary)` (**Giải quyết `[P0-02]`**):
   - Tính mã băm SHA-256 đầy đủ (64 ký tự hex) trên toàn bộ `normalizeCanonicalSummary(summary)`:
     `fingerprint = "${extractTaskIdFromThreadKey(taskIdOrThreadKey)}|${sha256Hex(normalizeCanonicalSummary(summary))}"`.
   - Hai `summary` có 80 ký tự đầu giống hệt nhau nhưng khác nhau ở phần cuối sẽ sinh ra 2 mã SHA-256 khác nhau, không bao giờ xảy ra mất mục do cắt ngắn.

### 2.2. Hợp đồng Bảo vệ Cấu trúc Markdown & Ghi File Nguyên tử (`[P0-03]` & `[P1-03]`)
1. `sanitizeSingleLineMarkdown(rawText)` (**Giải quyết `[P0-03]`**):
   - Chuyển mọi ký tự xuống dòng/điều khiển (`\r\n`, `\r`, `\n`, `\t`) thành khoảng trắng đơn `' '` và gộp khoảng trắng thừa để đảm bảo mỗi bản ghi luôn nằm trọn trên **đúng 1 dòng vật lý**.
   - Vô hiệu hóa chuỗi đóng/mở HTML comment (`<!--` -> `&lt;!--`, `-->` -> `--&gt;`) và escape chuỗi `**` nằm lẻ trong nội dung để không bao giờ phá vỡ cấu trúc `**id** **summary** — detail` hoặc tạo marker `<!-- TD:... -->` giả.
2. `sanitizeIssueId(rawId)`:
   - Kiểm tra khớp `/^(?:NEW-)?(P[12])-(\d+)$/i`, chuẩn hóa về dạng `P1-01` / `P2-01` (nếu sai định dạng thì gán `P2-00`).
3. **Tách biệt hoàn toàn dữ liệu Mentor khỏi thẻ `<!-- TD:... -->`**:
   - Thẻ comment ở cuối dòng mới chỉ chứa `<!-- TD:${fingerprint} -->` (chỉ gồm `taskId` đã lọc `[a-z0-9_-]` và 64 ký tự hex SHA-256), tuyệt đối không nội suy văn bản tự do của Mentor vào trong comment HTML.
4. **Đọc tương thích khóa Legacy (`[P1-01]`)**:
   - Hàm `extractExistingFingerprints(content)`: quét các thẻ `<!-- TD:... -->` trong file hiện có.
   - Nếu thẻ có định dạng mới `taskId|<64-hex>`, nạp trực tiếp vào tập `knownFingerprints`.
   - Nếu thẻ có định dạng legacy `threadKey|provider|id|rawTitle`, tự động tách `taskId = extractTaskIdFromThreadKey(threadKey)` và `summary = splitIssueTitle(rawTitle).summary`, sau đó tính `buildTechDebtFingerprint(taskId, summary)` để so khớp chống trùng lặp mà không cần sửa lại các dòng legacy cũ.
5. **Ghi file nguyên tử (`writeFileAtomic` — `[P1-03]`)**:
   - Mọi thao tác ghi/cập nhật `TECH_DEBT.md` trong `appendTechDebt` và `resolveTechDebt` đều ghi ra file tạm cùng thư mục (`${filePath}.tmp.${process.pid}.${Date.now()}`) rồi `fs.renameSync` sang `filePath` (dọn file tạm trong `catch`), đảm bảo không bao giờ làm hỏng hoặc mất dữ liệu file gốc nếu có lỗi ghi giữa chừng.

### 2.3. Lọc Nhiễu & Xếp hạng (`filterAndRankTechDebt(items, options)`)
- Đầu vào: mảng `items` (`Array<{ id: string, title: string, level?: 'P1'|'P2', late?: boolean }>`) và `{ maxItems = DEFAULT_MAX_TECH_DEBT_PER_ROUND }`.
- Xử lý:
  1. Loại bỏ các mục rỗng hoặc mang nội dung phủ định (`/^(\s*(không có|none|n\/a|không phát hiện|trống)\.?)\s*$/i` trên `summary` hoặc `title`).
  2. Tách `{ summary, detail }` qua `splitIssueTitle(item.title)` và làm sạch qua `sanitizeSingleLineMarkdown`.
  3. Khử trùng lặp ngay trong chính danh sách đầu vào theo `normalizeCanonicalSummary(summary)` (nếu trùng thì giữ mục có mức độ cao hơn `P1 > P2`).
  4. Sắp xếp ổn định (stable sort): tất cả `P1` đứng trước `P2`.
  5. Cắt theo trần `maxItems` và trả về `{ selected, droppedCount, stats: { filteredNoise, deduplicatedInBatch, cappedByLimit } }`.

### 2.4. Ghi nhận, Đánh dấu Hoàn thành Định danh Chặt chẽ (`[P0-01]`) & Thống kê
1. `appendTechDebt(filePath, items, meta, now = new Date())`:
   - Tương thích ngược 100% với chữ ký hàm hiện tại trong `.agents/scripts/review_policy.mjs`.
   - Định dạng mỗi dòng ghi mới (1 dòng duy nhất, đã sanitize):
     `- [ ] **${safeId}** **${safeSummary}**${safeDetail ? ` — ${safeDetail}` : ''} _(${tags.join(' · ')} · ${dateStr})_ <!-- TD:${fingerprint} -->`
2. `parseTechDebtFile(content)`:
   - Phân tích từng dòng của `TECH_DEBT.md` thành bản ghi có cấu trúc `{ checked: boolean, id: string, level: 'P1'|'P2'|'OTHER', taskId: string, summary: string, detail: string, metaText: string, fingerprint: string, rawLine: string, lineIndex: number }`.
3. `resolveTechDebt(filePath, matchers, resolutionNote = '', now = new Date())` (**Giải quyết `[P0-01]` — Chống đóng nhầm bản ghi**):
   - Mỗi phần tử `matcher` trong mảng `matchers` hỗ trợ 3 chế độ định danh chặt chẽ:
     a. **Theo `fingerprint` đầy đủ** (`{ fingerprint }` hoặc chuỗi dạng `task-X|<64-hex>`): khớp chính xác bản ghi có `record.fingerprint === fingerprint`.
     b. **Theo `id` có gắn phạm vi `taskId` bắt buộc** (`{ taskId, id }` hoặc chuỗi `'task-1:P1-01'`):
        - Nếu truyền một mã `P1-xx` / `P2-xx` đơn lẻ mà **không có `taskId`**, hàm lập tức ném lỗi `Error('UNSCOPED_ID_MATCHER: Khi tìm theo ID bắt buộc phải cung cấp taskId')` và **không sửa file**.
        - Nếu trong cùng `taskId` có `> 1` bản ghi đang mở (`[ ]`) mang cùng `id` (do nhiều vòng review), ném lỗi `Error('AMBIGUOUS_MATCH: Có nhiều hơn 1 bản ghi đang mở khớp điều kiện')` và **không sửa file**.
     c. **Theo `summary` (`{ taskId?, summary }`)**:
        - Tìm các bản ghi đang mở (`[ ]`) khớp chuỗi con `summary` (trong phạm vi `taskId` nếu có).
        - Chỉ cho phép cập nhật khi xác định được **duy nhất 1 bản ghi (`matches.length === 1`)**. Nếu `matches.length > 1`, ném lỗi `Error('AMBIGUOUS_MATCH: Tìm theo summary khớp nhiều bản ghi, hãy dùng fingerprint')` và **không sửa file**.
   - Toàn bộ các `matchers` được kiểm tra tính hợp lệ và tính duy nhất **trước khi ghi file** (all-or-nothing transaction qua `writeFileAtomic`).
4. `summarizeTechDebt(filePath)`:
   - Trả về `{ total, open, resolved, byLevel: { P1: { open, resolved }, P2: { open, resolved } }, byTask: Record<string, { open: number, resolved: number }> }`.

---

## 3. Phạm vi File Thay đổi & Kiểm thử (Verification Plan)
1. **File tạo mới trong phạm vi `sourceDirs` (`src/`, `tests/`)**:
   - `src/tech_debt.mjs`: Cài đặt toàn bộ các hàm xử lý và quản lý `TECH_DEBT.md`.
   - `tests/tech_debt.test.mjs`: Kiểm thử tự động bao phủ toàn bộ hợp đồng và các ca biên:
     - **`[P0-01]`**: Hai Task (`task-1` và `task-2`) có cùng `P1-01` -> tìm theo `id` thiếu `taskId` phải báo lỗi và giữ nguyên file; tìm theo `{ taskId: 'task-1', id: 'P1-01' }` chỉ đóng đúng mục của `task-1`; nhiều `summary` chứa cùng từ khóa -> báo lỗi `AMBIGUOUS_MATCH` và không sửa file.
     - **`[P0-02]`**: Hai `summary` có 80 ký tự đầu giống hệt nhau nhưng khác nhau ở phần cuối -> tạo 2 fingerprint SHA-256 khác nhau và cả hai đều được ghi nhận đầy đủ.
     - **`[P0-03]`**: Round-trip `appendTechDebt` -> `parseTechDebtFile` với chuỗi chứa `\n`, `\r\n`, `-->`, `<!--`, và ký tự Markdown đặc biệt -> giữ nguyên cấu trúc 1 dòng/bản ghi và parse lại chính xác.
     - **`[P1-01]` & `[P1-03]`**: Đọc khóa legacy không ghi trùng, ghi file nguyên tử qua temp file, thống kê `summarizeTechDebt`.
2. **Tích hợp hạ tầng**:
   - `.agents/scripts/review_policy.mjs` re-export / sử dụng `appendTechDebt` từ `src/tech_debt.mjs`.
3. **Tiêu chí Nghiệm thu**:
   - `npm test` chạy `tests/tech_debt.test.mjs` đạt `PASS 100%` (`exitCode === 0`).
   - `npm run test:workflow` đạt `12/12 PASS`.
