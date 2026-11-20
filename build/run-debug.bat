@echo off
rem ============================================================
rem  SSH Client - diagnostic launch
rem
rem  Same flags as start.bat, but this window stays open and shows
rem  the exit code, so failures are visible instead of silent.
rem
rem  Launch log: %TEMP%\ssh-client-startup.log
rem ============================================================

title SSH Client - Diagnostics

echo ============================================================
echo  SSH Client - Diagnostic launch
echo ------------------------------------------------------------
echo  Launch log: %TEMP%\ssh-client-startup.log
echo ============================================================
echo.

set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1

cd /d "%~dp0"
"ssh-client.exe" --no-sandbox
set EXITCODE=%ERRORLEVEL%

echo.
echo ============================================================
echo [Exit code] %EXITCODE%
echo.
echo If the app still fails, please send this window's content
echo together with the log file above.
echo ============================================================
echo.
pause
