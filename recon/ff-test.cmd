@echo off
set FF=%~dp0..\ms-playwright\firefox-1555\firefox\firefox.exe
set DIR=%~dp0..\ff-test
if exist "%DIR%" rmdir /s /q "%DIR%"
mkdir "%DIR%"

echo === T1: fresh profile, plain start ===
"%FF%" -no-remote -profile "%DIR%\p1" about:blank > "%DIR%\t1.out" 2> "%DIR%\t1.err"
echo   exitcode=%errorlevel%  (3221225477 = 0xC0000005 access violation)
taskkill /F /IM firefox.exe > nul 2>&1
timeout /t 3 /nobreak > nul

echo === T2: fresh profile, -juggler-pipe ===
"%FF%" -no-remote -profile "%DIR%\p2" -juggler-pipe about:blank > "%DIR%\t2.out" 2> "%DIR%\t2.err"
echo   exitcode=%errorlevel%
taskkill /F /IM firefox.exe > nul 2>&1
timeout /t 3 /nobreak > nul

echo === T3: reused profile, -juggler-pipe ===
"%FF%" -no-remote -profile "%DIR%\p2" -juggler-pipe about:blank > "%DIR%\t3.out" 2> "%DIR%\t3.err"
echo   exitcode=%errorlevel%
taskkill /F /IM firefox.exe > nul 2>&1

echo === T2 stderr ===
type "%DIR%\t2.err" 2> nul
