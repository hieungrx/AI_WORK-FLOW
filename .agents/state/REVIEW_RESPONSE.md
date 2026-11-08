# REVIEW_RESPONSE — Phản hồi Khắc phục P0 cho `task-3-plan` (v1.3)

- **`[P0-01]` (Phép kiểm tra `callbackResult instanceof Promise` nằm ngoài `try/catch`, có thể ném lỗi nếu `callbackResult` là `Proxy` có trap `getPrototypeOf` ném ngoại lệ)**:
  - **Đã khắc phục triệt để trong `CURRENT_PLAN.md` (Mục 2.1.2)**:
    - Đưa toàn bộ biểu thức `if (callbackResult instanceof Promise) { ... } else { const thenProp = callbackResult.then; ... }` vào bên trong cùng một khối `try { ... } catch (_classifyErr) { isAsyncOrSuspect = true; quarantineLock = true; }`.
    - Nhờ đó, nếu `callbackResult` là `Proxy` có trap `getPrototypeOf()` ném lỗi khi chạy `instanceof Promise` (hoặc getter `.then` ném lỗi), ngoại lệ sẽ bị bắt ngay trong `catch (_classifyErr)`, đặt `quarantineLock = true` và giữ nguyên tệp `.lock` ở trạng thái cách ly.
    - Đã bổ sung kịch bản kiểm thử `new Proxy(pendingPromise, { getPrototypeOf() { throw new Error('PROTOTYPE_TRAP'); } })` vào **`TD-14`**.
