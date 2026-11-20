@echo off
rem ============================================================
rem  SSH Client - fallback launcher
rem
rem  You normally do NOT need this file. Double-click
rem  ssh-client.exe directly: electron-builder resets the
rem  packaged files' mandatory integrity label to Medium via the
rem  afterPack hook (scripts/after-pack.cjs), so the Chromium
rem  sandbox initializes normally.
rem
rem  Use this launcher only when that reset did not happen and
rem  icacls reports "Low Mandatory Level" on ssh-client.exe.
rem  A Low label forces the process to Low integrity, Chromium
rem  then cannot provision sandbox ACLs on Medium directories
rem  (%TEMP%, %APPDATA%) and the browser process exits with
rem  0x80000003 before any window or log appears - a silent
rem  no-op on double-click.
rem
rem  --no-sandbox skips that ACL provisioning, at the cost of
rem  the renderer sandbox. Prefer fixing the label instead:
rem    icacls "<app dir>" /setintegritylevel Medium /T /C
rem ============================================================

cd /d "%~dp0"
start "" "ssh-client.exe" --no-sandbox
