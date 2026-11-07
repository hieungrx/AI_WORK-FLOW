# REVIEW_RESPONSE — Phản hồi Khắc phục P0 cho Vòng 2 (`task-1-review`)

- **`[P0-01]` (`appendTechDebt` có thể bỏ sót nợ kỹ thuật mới khi áp dụng giới hạn trước khử trùng lặp)**:
  - **Đã khắc phục triệt để trong `src/tech_debt.mjs`**:
    - Trong `filterAndRankTechDebt(items, options)` và `appendTechDebt(filePath, items, meta, now)`: đọc `knownFingerprints = extractExistingFingerprints(header)` **trước**, truyền `existingFingerprints: knownFingerprints` vào `filterAndRankTechDebt`.
    - Quá trình xử lý thực hiện theo đúng thứ tự: (1) lọc nhiễu & chuẩn hóa toàn bộ đầu vào -> (2) khử trùng lặp trong cùng lô (`byCanonical`) -> (3) loại bỏ toàn bộ các mục có `fingerprint` hoặc `legacyKey` đã tồn tại trong `TECH_DEBT.md` (`stats.deduplicatedExisting`) -> (4) xếp hạng `P1` trước `P2` -> (5) mới áp dụng trần `maxItems` lên các mục thực sự mới.
    - Đã bổ sung regression test **`TD-9 [Review P0-01]`** trong `tests/tech_debt.test.mjs`: ghi 5 mục đầu tiên, sau đó gửi lại 5 mục cũ kèm mục thứ 6 mới -> xác nhận `appendTechDebt` trả về `1` và tổng số mục trong file là `6`.

- **`[P0-02]` (`resolveTechDebt` có thể khiến bản ghi biến mất khỏi parser và thống kê khi ghi chú chứa dấu ngoặc đóng `()`)**:
  - **Đã khắc phục triệt để trong `src/tech_debt.mjs`**:
    - Thay thế biểu thức chính quy đơn giản `_\(Đã xử lý:[^)]+\)_` trong `parseTechDebtFile()` bằng bộ phân tích 2 bước từ phải sang trái:
      1. Tách khung ngoài `^\s*-\s*\[([ xX])\]\s+\*\*([^*]+)\*\*\s+(.*?)\s*<!--\s*TD:(.*?)\s*-->\s*$`.
      2. Tách hậu tố `_(Đã xử lý: ...)_` bằng `/^(.*\s+_\([^()]+\)_)\s+_\(Đã xử lý:\s*(.*)\)_$/`, cho phép `resolutionNote` chứa bất kỳ số lượng ngoặc đơn `()`, `_(...)_`, liên kết Markdown `[text](url)` hoặc ký tự đặc biệt mà không làm vỡ parser.
      3. Tách `rawBody` và `metaText` bằng `/^(.*)\s+_\(([^()]+)\)_$/` và trả về thêm trường `resolutionNote` trong mỗi bản ghi của `parseTechDebtFile()`.
    - Đã bổ sung regression test **`TD-10 [Review P0-02]`** trong `tests/tech_debt.test.mjs` với ghi chú `'Fixed parse() handling, fn(a, b) & _(sub-note)_ [PR #12](https://example.com/pr/12) <!-- comment -->'`, xác nhận `summarizeTechDebt()` trả về `total = 1, open = 0, resolved = 1` và `parseTechDebtFile()` giữ nguyên đầy đủ bản ghi.

- **Về các góp ý `P1/P2` không chặn**:
  - **`[P2-01]`**: Đã chuyển `tests/tech_debt.test.mjs` sang dùng `import { test } from 'node:test'`, giúp `npm test` xuất báo cáo TAP chi tiết từng test case (`1..10`, `# tests 10`, `# pass 10`).
  - **`[P1-01]`**: Theo quy tắc bảo vệ công cụ tại Mục 3 `GEMINI.md` (*"Ở chế độ `--mode review-code`, chỉ gửi kết quả chạy `npm test` + `git diff HEAD -- src/ tests/`. Tuyệt đối KHÔNG gửi kèm code của `.agents/` vào gói review"*), file `.agents/scripts/review_policy.mjs` không nằm trong `review_bundle`, nhưng thực tế đã được tích hợp trực tiếp (`import { appendTechDebt } from '../../src/tech_debt.mjs'`) và chính kết quả chạy `ask_mentor.mjs` ở Vòng 1 vừa rồi đã tự động gọi `appendTechDebt` mới để ghi 3 mục P1/P2 vào `.agents/state/TECH_DEBT.md` (kèm kiểm thử `npm run test:workflow` đạt `12/12 PASS`).
