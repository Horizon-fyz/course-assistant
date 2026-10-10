@echo off
rem ======================================================
rem  Zhihuishu question-bank tool - Windows launcher
rem
rem  Double-click          -> environment check + status
rem
rem  Command line:
rem    run.cmd all          full flow: fetch + documents + verify
rem    run.cmd import       import personal info (--prompt for interactive)
rem    run.cmd whoami       show effective credentials and platform identity
rem    run.cmd login        log in and persist the session
rem    run.cmd fetch        fetch only
rem    run.cmd docs         regenerate documents only
rem    run.cmd verify       verify output completeness
rem    run.cmd status       show current status
rem    run.cmd doctor       environment self-check
rem
rem  NOTE: this file is kept ASCII-only on purpose.
rem  cmd.exe parses .cmd files with the OEM codepage (cp936 here),
rem  so non-ASCII text in a UTF-8 file breaks command parsing.
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
    echo [ERROR] node not found. Install Node.js or use the DSH bundled runtime.
    pause
    exit /b 1
  )
)

if "%~1"=="" (
  "%NODE%" zhs.mjs doctor
  echo.
  "%NODE%" zhs.mjs status
  echo.
  echo Tip: run.cmd all  = full flow ^| run.cmd docs = regenerate documents
  pause
  exit /b 0
)

"%NODE%" zhs.mjs %*
exit /b %errorlevel%
