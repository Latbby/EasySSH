# Generate build/start.lnk -- the Windows fallback launcher (--no-sandbox).
#
# Why the .lnk is not committed: a shortcut stores an absolute target path (user name and
# repo location included), which is meaningless in a public repo and leaks personal paths.
# It is therefore generated right before packaging, and .gitignore ignores the result.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI and would
# mangle non-ASCII text (comments included) into a parse error.
$repo = Split-Path -Parent $PSScriptRoot
$appDir = Join-Path $repo 'dist\win-unpacked'
$target = Join-Path $appDir 'EasySSH.exe'
$lnkPath = Join-Path $repo 'build\start.lnk'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath = $target
$shortcut.Arguments = '--no-sandbox'
$shortcut.WorkingDirectory = $appDir
$shortcut.IconLocation = "$target,0"
# 说明字段用英文：Windows PowerShell 5.1 会按 ANSI 读取无 BOM 的 .ps1，中文会乱码
$shortcut.Description = 'EasySSH fallback launcher (--no-sandbox)'
$shortcut.Save()

Write-Host "[make-start-lnk] generated build\start.lnk -> dist\win-unpacked\EasySSH.exe (--no-sandbox)"