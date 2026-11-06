@echo off
chcp 65001 >nul
echo ========================================================
echo   KHỞI ĐỘNG HỆ THỐNG MULTI-ACCOUNT ANTIGRAVITY + CHATGPT
echo ========================================================

:: 1. Khởi động Chrome riêng biệt để phục vụ Playwright MCP (Cổng 9222)
echo [1/3] Đang mở Chrome điều khiển từ xa (Cổng 9222)...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.chrome-mentor-profile"

:: 2. Mở cửa sổ Antigravity cho Tài khoản số 1 (Chuyên Research & Plan)
echo [2/3] Đang mở Antigravity - Tài khoản số 1 (Account A)...
start "" antigravity --user-data-dir="%USERPROFILE%\.ag-account-1" .

:: 3. Mở cửa sổ Antigravity cho Tài khoản số 2 (Chuyên Implement & Test)
echo [3/3] Đang mở Antigravity - Tài khoản số 2 (Account B)...
start "" antigravity --user-data-dir="%USERPROFILE%\.ag-account-2" .

echo ========================================================
echo ✅ Hoàn tất! Hãy đăng nhập ChatGPT trên cửa sổ Chrome vừa mở.
echo ✅ Bạn có thể dùng Account A để lên kế hoạch và Account B để viết code.
echo ========================================================
pause