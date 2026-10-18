@echo off
rem ======================================================
rem  Zhihuishu one-click automation
rem
rem  Just double-click this file. No commands needed.
rem  It will: start Edge -> wait for login -> answer
rem          homework -> watch courses -> print summary.
rem
rem  NOTE: this file is ASCII-only on purpose.
rem  cmd.exe parses .cmd files with the OEM codepage.
rem ======================================================
setlocal
cd /d "%~dp0"

if not defined PLAYWRIGHT_BROWSERS_PATH set PLAYWRIGHT_BROWSERS_PATH=%~dp0ms-playwright

where node >nul 2>nul
if %errorlevel%==0 (
  set NODE=node
) else (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
  ) else (
    if exist "%ProgramFiles%\nodejs\node.exe" (
      set NODE=%ProgramFiles%\nodejs\node.exe
    ) else (
      echo [ERROR] Node.js not found.
      echo Install Node.js from https://nodejs.org/ and double-click again.
      pause
      exit /b 1
    )
  )
)

"%NODE%" start.mjs %*
set CODE=%errorlevel%
echo.
echo Finished. Exit code: %CODE%
echo Press any key to close this window...
pause >nul
exit /b %CODE%
