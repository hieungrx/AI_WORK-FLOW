@echo off
chcp 65001 >nul
echo ========================================================
echo   KHỞI ĐỘNG HỆ THỐNG MULTI-ACCOUNT ANTIGRAVITY + MENTOR
echo ========================================================

:: 1. Khởi động Hồ sơ Chrome 1 cho ChatGPT Mentor (Cổng 9222)
echo [1/4] Đang mở Chrome Hồ sơ 1 - ChatGPT Mentor (Cổng 9222)...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.chrome-mentor-profile" https://chatgpt.com/

:: 2. Khởi động Hồ sơ Chrome 2 cho Gemini Mentor (Cổng 9223)
echo [2/4] Đang mở Chrome Hồ sơ 2 - Gemini Mentor (Cổng 9223)...
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --user-data-dir="%USERPROFILE%\.chrome-gemini-profile" https://gemini.google.com/app

:: 3. Mở cửa sổ Antigravity cho Tài khoản số 1 (Chuyên Research & Plan)
echo [3/4] Đang mở Antigravity - Tài khoản số 1 (Account A)...
start "" antigravity --user-data-dir="%USERPROFILE%\.ag-account-1" .

:: 4. Mở cửa sổ Antigravity cho Tài khoản số 2 (Chuyên Implement & Test)
echo [4/4] Đang mở Antigravity - Tài khoản số 2 (Account B)...
start "" antigravity --user-data-dir="%USERPROFILE%\.ag-account-2" .

echo ========================================================
echo ✅ Hoàn tất!
echo    - Hồ sơ Chrome 1 (9222): Đăng nhập ChatGPT
echo    - Hồ sơ Chrome 2 (9223): Đăng nhập Google Gemini
echo    - Account A / B: Sẵn sàng điều phối RPIR đa luồng
echo ========================================================
pause
