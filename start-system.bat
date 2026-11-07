@echo off
setlocal
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
echo ========================================================
echo   KHOI DONG CHROME MENTOR PROFILES (CHATGPT + GEMINI)
echo ========================================================

rem 1. Chrome Profile 1 - ChatGPT Mentor (port 9222)
netstat -ano | findstr ":9222 " | findstr "LISTENING" | findstr "\[::1\]" >nul 2>&1
if %ERRORLEVEL% equ 0 (
  echo [1/2] Chrome Profile 1 - ChatGPT (9222) da mo san.
) else (
  echo [1/2] Mo Chrome Profile 1 - ChatGPT Mentor (port 9222)...
  start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.chrome-mentor-profile" https://chatgpt.com/
)

rem 2. Chrome Profile 2 - Gemini Mentor (port 9223)
netstat -ano | findstr ":9223 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% equ 0 (
  echo [2/2] Chrome Profile 2 - Gemini (9223) da mo san.
) else (
  echo [2/2] Mo Chrome Profile 2 - Gemini Mentor (port 9223)...
  start "" "%CHROME%" --remote-debugging-port=9223 --user-data-dir="%USERPROFILE%\.chrome-gemini-profile" https://gemini.google.com/app
)

rem Tuy chon: truyen --multi-account khi can mo them 2 cua so Antigravity phu
if /I "%~1"=="--multi-account" (
  echo [+] Mo them 2 cua so Antigravity (Account A va B)...
  start "" /min cmd /c antigravity --user-data-dir="%USERPROFILE%\.ag-account-1" .
  start "" /min cmd /c antigravity --user-data-dir="%USERPROFILE%\.ag-account-2" .
)

echo ========================================================
echo  HOAN TAT! Khong mo thua cua so Antigravity hay cmd.
echo   - Chrome Profile 1 (9222): ChatGPT Mentor
echo   - Chrome Profile 2 (9223): Google Gemini Mentor
echo   - Khi het Quota, chay: start-system.bat --multi-account
echo ========================================================
pause
endlocal
