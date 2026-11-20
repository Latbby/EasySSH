@echo off
rem ============================================================
rem  SSH Client - launcher (USE THIS ONE)
rem
rem  Do NOT double-click ssh-client.exe directly.
rem
rem  Why: on managed Windows machines (enterprise security agents,
rem  VPN kernel drivers and their process-protection services),
rem  Chromium's sandbox initialization is blocked. The process then
rem  exits silently BEFORE any window is created, leaving no log and
rem  no crash dump - it just looks like "double-click does nothing".
rem
rem  --no-sandbox is the only flag that is actually required; the
rem  GPU related switches were tested and made no difference.
rem  This app only loads local pages and never browses external
rem  sites, so the trade-off is acceptable.
rem ============================================================

cd /d "%~dp0"
start "" "ssh-client.exe" --no-sandbox
