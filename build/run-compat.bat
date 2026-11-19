@echo off
chcp 65001 >nul
title SSH 客户端 - 兼容模式启动

echo ============================================================
echo   SSH 客户端 兼容模式启动
echo ------------------------------------------------------------
echo   普通双击没反应时，用这个脚本再试一次。
echo   它会关闭 GPU 加速与沙箱，并输出启动日志。
echo.
echo   日志文件：%TEMP%\ssh-client-startup.log
echo ============================================================
echo.

set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1

echo [启动] 兼容模式参数：--no-sandbox --disable-gpu --disable-software-rasterizer
echo.
"%~dp0ssh-client.exe" --no-sandbox --disable-gpu --disable-software-rasterizer --enable-logging
set EXITCODE=%ERRORLEVEL%

echo.
echo ============================================================
echo [退出码] %EXITCODE%
echo.
echo 请把本窗口的完整内容截图发回，并附上日志文件：
echo   %TEMP%\ssh-client-startup.log
echo ============================================================
echo.
pause
