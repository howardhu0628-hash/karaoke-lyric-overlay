@echo off
chcp 65001 >nul <nul
setlocal
set "PY="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$a = Get-ScheduledTask -TaskPath '\YTLyricSub\' -ErrorAction SilentlyContinue | ForEach-Object { $_.Actions } | Where-Object { $_.Arguments -like '*listen-server.py*' } | Select-Object -First 1; if ($a) { $a.Execute -replace 'pythonw\.exe$', 'python.exe' }" ^<nul`) do set "PY=%%P"
if not defined PY set "PY=python"
"%PY%" -I "%~dp0export_transcript.py" %*
echo.
pause