@echo off
rem Register the Edge native messaging host (HKCU only) so the panel's start button works.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
