@echo off
chcp 65001 >nul
title SSH 客户端 - 诊断启动

echo ============================================================
echo   SSH 客户端 诊断启动
echo ------------------------------------------------------------
echo   这个窗口会显示应用的启动日志与退出码。
echo   如果窗口一闪而过或没有任何反应，这里能看出原因。
echo.
echo   启动日志文件：
echo     %TEMP%\ssh-client-startup.log
echo ============================================================
echo.

set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1

echo [启动] 正在运行 ssh-client.exe ...
echo.
"%~dp0ssh-client.exe"
set EXITCODE=%ERRORLEVEL%

echo.
echo ============================================================
echo [退出码] %EXITCODE%
echo.
echo 请把本窗口的完整内容截图发回，并附上日志文件内容：
echo   %TEMP%\ssh-client-startup.log
echo ============================================================
echo.
pause
