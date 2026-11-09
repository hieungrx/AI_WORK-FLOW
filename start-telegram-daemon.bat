@echo off
title AI Workflow - Telegram Real-time 24/7 Daemon
echo [AI WORKFLOW] Dang khoi chay Telegram Real-time Daemon...
if exist ".agents\scripts\telegram_daemon.mjs" (
    node .agents\scripts\telegram_daemon.mjs
) else (
    node daemon.mjs
)
pause
