# 啟動／停止背景的 AI 聽寫服務（工作排程器 \YTLyricSub\YT 歌詞字幕 AI 聽寫服務，登入 Windows 1 分鐘後自動啟動）
param([ValidateSet('Start', 'Stop')][string]$Action = 'Start')
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$zp = Join-Path $PSScriptRoot '..\lib\zhcn.ps1'; if (Test-Path -LiteralPath $zp) { . $zp } # Windows 是簡體中文時，畫面上的字轉成簡體
$path = '\YTLyricSub\'; $name = 'YT 歌詞字幕 AI 聽寫服務'
function Ping { try { $null = Invoke-WebRequest -Uri 'http://127.0.0.1:8767/ping' -UseBasicParsing -TimeoutSec 2; $true } catch { $false } }

if ($Action -eq 'Stop') {
    Stop-ScheduledTask -TaskPath $path -TaskName $name
    for ($i = 0; $i -lt 10 -and (Ping); $i++) { Start-Sleep -Milliseconds 500 }  # 程式結束要一兩秒
    if (Ping) { Write-Host '服務好像還在跑，請稍後再試一次。' -ForegroundColor Yellow }
    else { Write-Host '已停止 AI 聽寫服務。下次登入 Windows 會自動再啟動；要馬上開回來就雙擊「啟動聽寫服務.cmd」。' -ForegroundColor Green }
} else {
    if (Ping) { Write-Host 'AI 聽寫服務本來就在背景執行中（localhost:8767）。' -ForegroundColor Green; return }
    Start-ScheduledTask -TaskPath $path -TaskName $name
    for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; if (Ping) { Write-Host '已在背景啟動 AI 聽寫服務（localhost:8767）。模型第一次用到時才載入。' -ForegroundColor Green; return } }
    $act = (Get-ScheduledTask -TaskPath $path -TaskName $name).Actions[0]
    Write-Host ('啟動 20 秒後還沒回應。可以在命令列執行 "' + ($act.Execute -replace 'pythonw\.exe$', 'python.exe') + '" ' + $act.Arguments + ' --child 看錯誤訊息。') -ForegroundColor Red
}
