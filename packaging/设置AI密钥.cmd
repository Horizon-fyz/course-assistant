@echo off
setlocal
cd /d "%~dp0"
set "CFG=%~dp0app\md-ai-answer\config.json"
if not exist "%CFG%" (
  echo [ERROR] Config file not found:
  echo   %CFG%
  echo Please run the app once, or reinstall.
  pause
  exit /b 1
)
echo.
echo Config: %CFG%
echo Press Enter to cancel.
echo.
set /p "KEY=Paste your DeepSeek API Key: "
if "%KEY%"=="" (
  echo Cancelled. Nothing changed.
  pause
  exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%CFG%'; $j=Get-Content -Raw -Encoding UTF8 $p | ConvertFrom-Json; $j.reasonBaseUrl='https://api.deepseek.com/v1'; $j.reasonApiKey='%KEY%'; if (-not $j.reasonModel) { $j.reasonModel='deepseek-chat' }; $j | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $p"
if errorlevel 1 (
  echo [FAILED] Could not write the config file.
) else (
  echo [OK] Saved. Run the app again.
)
pause
