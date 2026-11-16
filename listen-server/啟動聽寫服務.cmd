@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0listen-control.ps1" -Action Start
pause
