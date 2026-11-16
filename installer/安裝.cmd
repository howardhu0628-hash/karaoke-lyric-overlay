@echo off
rem YT lyric subtitles v1.0 installer: runs install.ps1 (no admin needed). Re-run to update or resume.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
