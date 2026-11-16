@echo off
rem YT lyric subtitles: uninstall (removes scheduled tasks, native host registration, and the install folder).
chcp 65001 >nul
set "YTLS_UNINSTALL=%~dp0uninstall.ps1"
rem Leave the install folder first: Windows cannot delete a folder that is some process's current directory.
cd /d "%TEMP%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%YTLS_UNINSTALL%" %*
pause
