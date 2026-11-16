@echo off
rem Edge native messaging host for YT lyric subtitles: starts the OCR / listen scheduled tasks.
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0ytls-host.ps1"
