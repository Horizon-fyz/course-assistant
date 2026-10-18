@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-all.ps1"
echo.
echo 构建已结束，按任意键关闭窗口...
pause >nul
