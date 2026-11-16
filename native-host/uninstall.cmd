@echo off
rem Remove the Edge native messaging host registration.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall
pause
