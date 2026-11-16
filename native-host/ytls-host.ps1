# YT 歌詞字幕：Edge「原生訊息」小幫手。擴充功能面板按「啟動」時，Edge 會執行這支，
# 它只做一件事：啟動（或回報）工作排程器裡的兩個服務。只接受固定的指令，不執行任何傳進來的內容。
# 通訊格式（Chrome／Edge native messaging）：前 4 個位元組是長度（little-endian），後面是 UTF-8 JSON。
$ErrorActionPreference = 'Stop'
$tasks = @{ ocr = 'YT 歌詞字幕 OCR 服務'; listen = 'YT 歌詞字幕 AI 聽寫服務' }
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

function Read-Message {
    $len = New-Object byte[] 4
    $n = 0
    while ($n -lt 4) { $r = $stdin.Read($len, $n, 4 - $n); if ($r -le 0) { return $null }; $n += $r }
    $size = [BitConverter]::ToInt32($len, 0)
    if ($size -le 0 -or $size -gt 65536) { return $null }
    $buf = New-Object byte[] $size
    $n = 0
    while ($n -lt $size) { $r = $stdin.Read($buf, $n, $size - $n); if ($r -le 0) { break }; $n += $r }
    return ([Text.Encoding]::UTF8.GetString($buf, 0, $n) | ConvertFrom-Json)
}

function Send-Message($obj) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
    $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

try {
    $msg = Read-Message
    $which = @()
    if ($msg -and $msg.which) { $which = @($msg.which) | Where-Object { $tasks.ContainsKey([string]$_) } }
    if (-not $which.Count) { $which = @('ocr', 'listen') }
    # 不用 Get-ScheduledTask：光載入那個模組就要 5 秒多（按「啟動」後要等很久）；schtasks.exe 約 0.2 秒
    $ports = @{ ocr = 8766; listen = 8767 }
    $out = @{}
    foreach ($w in $which) {
        $tn = '\YTLyricSub\' + $tasks[$w]
        # 先看服務有沒有在回應（連得上埠就是開著）；沒開才找工作排程器（schtasks 的輸出是系統語言，不拿來判斷）
        $up = $false
        try { $c = New-Object Net.Sockets.TcpClient; $up = $c.ConnectAsync('127.0.0.1', $ports[$w]).Wait(300); $c.Close() } catch { $up = $false }
        if ($up) { $out[$w] = 'up'; continue }
        # schtasks 找不到工作時會印到 stderr：在 ErrorActionPreference=Stop 下那會變成例外，整個請求失敗、另一個服務也不會啟動
        $ErrorActionPreference = 'Continue'
        if ($msg.action -eq 'start') { & schtasks.exe /run /tn $tn 2>$null | Out-Null } else { & schtasks.exe /query /tn $tn 2>$null | Out-Null }
        $ErrorActionPreference = 'Stop'
        $out[$w] = if ($LASTEXITCODE -ne 0) { 'missing' } elseif ($msg.action -eq 'start') { 'started' } else { 'down' }
    }
    Send-Message @{ ok = $true; tasks = $out }
} catch {
    Send-Message @{ ok = $false; error = [string]$_.Exception.Message }
}
