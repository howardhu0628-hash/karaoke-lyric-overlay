@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ocr-control.ps1" -Action Start
pause
