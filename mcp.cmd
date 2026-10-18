@echo off
rem ======================================================
rem  Zhihuishu automation - MCP stdio server launcher
rem
rem  AI clients (Trae / Claude Desktop / Cursor ...) should
rem  be configured to run this file, with no arguments.
rem
rem  stdin/stdout carry JSON-RPC messages. Do NOT print
rem  anything to stdout in this file, or the MCP handshake
rem  will break. Errors go to stderr only.
rem
rem  NOTE: this file is kept ASCII-only on purpose.
rem  cmd.exe parses .cmd files with the OEM codepage (cp936
rem  here), so non-ASCII text in a UTF-8 file breaks parsing.
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
    echo [ERROR] node not found. Install Node.js or use the DSH bundled runtime. 1>&2
    exit /b 1
  )
)

"%NODE%" mcp-server.mjs %*
exit /b %errorlevel%
