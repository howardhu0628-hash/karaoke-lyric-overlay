# YT 歌詞字幕：解除安裝。停掉、刪掉兩個排程工作，移除「啟動本機服務」小幫手的登錄，再刪掉安裝程式放進安裝資料夾的東西。
# Edge 裡的擴充功能要自己到 edge://extensions 按「移除」。
param([switch]$Yes)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
# 介面語言：Windows 是簡體中文時，畫面上的字轉成簡體
foreach ($zp in (Join-Path $PSScriptRoot 'app\lib\zhcn.ps1'), (Join-Path $PSScriptRoot '..\lib\zhcn.ps1')) { if (Test-Path -LiteralPath $zp) { . $zp; break } }
$Dir = $PSScriptRoot
# 安裝程式只把東西放進這些位置（舊版可能裝在本來就有別的東西的資料夾，例如 D:\AI：其他檔案不能動）。
# tools、models、downloads 是常見的名字，只刪安裝程式放進去的那幾個，刪完變空了才刪資料夾本身
$Items = @('app', 'python', 'py-listen', 'py-ocr', 'uv-cache',
    'tools\uv', 'tools\yt-dlp', 'tools\node', 'tools\ffmpeg',
    'models\faster-whisper-large-v3-turbo', 'models\model_bs_roformer_ep_317_sdr_12.9755.ckpt', 'models\model_bs_roformer_ep_317_sdr_12.9755.ckpt.part',
    'downloads\uv.zip', 'downloads\uv.zip.part', 'downloads\node.zip', 'downloads\node.zip.part', 'downloads\ffmpeg.zip', 'downloads\ffmpeg.zip.part',
    'downloads\node-x', 'downloads\ffmpeg-x',
    'install.log', 'ytls-install.txt', 'uninstall.ps1', '解除安裝.cmd')
$Parents = @('tools', 'models', 'downloads')
# 沒有記號：這裡不是安裝資料夾（例如在解壓縮出來的安裝包裡按了「解除安裝」），什麼都不做，免得把真正裝好的服務拆掉
if (-not (Test-Path (Join-Path $Dir 'ytls-install.txt')) -and -not (Test-Path (Join-Path $Dir 'app\ytls-config.json'))) {
    Write-Host ''
    Write-Host "  $Dir 不是 YT 歌詞字幕的安裝資料夾，沒有刪任何東西。" -ForegroundColor Yellow
    Write-Host '  請到安裝資料夾（預設 %LOCALAPPDATA%\YTLyricSub）雙擊裡面的「解除安裝.cmd」。'
    return
}
Write-Host ''
Write-Host "  要解除安裝 YT 歌詞字幕，刪掉 $Dir 裡它的檔案（模型、伴奏快取都會刪掉；資料夾裡其他東西不會動）。" -ForegroundColor White
if (-not $Yes) {
    $ans = Read-Host '  確定的話輸入 y 再按 Enter'
    if ($ans.Trim().ToLower() -ne 'y') { Write-Host '  已取消。'; return }
}
# 排程放在 \YTLyricSub\；v1.0.61 以前在 \Claude\（只拿掉這兩個名字的工作）
foreach ($name in 'YT 歌詞字幕 OCR 服務', 'YT 歌詞字幕 AI 聽寫服務') {
    $t = Get-ScheduledTask -TaskPath '\YTLyricSub\', '\Claude\' -TaskName $name -ErrorAction SilentlyContinue
    foreach ($one in @($t)) { if ($one) { Stop-ScheduledTask -InputObject $one -ErrorAction SilentlyContinue; Unregister-ScheduledTask -InputObject $one -Confirm:$false } }
    if ($t) { Write-Host "  已移除排程工作：$name" }
}
foreach ($h in 'ytlyricsub.host', 'com.claude.ytls') { Remove-Item "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$h" -ErrorAction SilentlyContinue }
# uv 裝 Python 時會在登錄裡記一筆（HKCU\Software\Python\Astral\...）：只刪指到這個安裝資料夾裡的
Get-ChildItem 'HKCU:\Software\Python\Astral' -ErrorAction SilentlyContinue | ForEach-Object {
    $ip = (Get-ItemProperty -LiteralPath (Join-Path $_.PSPath 'InstallPath') -ErrorAction SilentlyContinue).'(default)'
    if ($ip -and $ip.StartsWith($Dir + '\', [StringComparison]::OrdinalIgnoreCase)) { Remove-Item -LiteralPath $_.PSPath -Recurse -ErrorAction SilentlyContinue }
}
# 新版 uv 還會在 %USERPROFILE%\.local\bin 放 python3.12.exe（小捷徑，裡面寫著真正的位置）：只刪指到這個安裝資料夾裡的
Get-ChildItem (Join-Path $env:USERPROFILE '.local\bin') -Filter 'python*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 1MB } | ForEach-Object {
    $t = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($_.FullName))
    if ($t.IndexOf($Dir + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2  # 等服務程式結束、放開檔案
# 這支腳本自己也在資料夾裡：交給另一個 PowerShell 等這邊結束後再刪。
# 安裝資料夾的路徑用環境變數傳、指令用 -EncodedCommand：路徑不進指令字串，單引號（O'Brien、’）、連續空白都不會把指令弄壞
# （以前貼進字串，彎引號會讓整段語法錯誤、兩個空白會被併成一個，什麼都沒刪卻顯示「完成」）。
# 工作目錄設到 TEMP：Windows 不能刪掉「某個程式的目前資料夾」，以前從安裝資料夾雙擊解除安裝會留下空資料夾
$lit = { ($args[0] | ForEach-Object { "'" + $_ + "'" }) -join ',' }  # 項目名稱都是固定的英文／中文，沒有引號
$body = @'
Start-Sleep -Seconds 2
$d = $env:YTLS_UNINSTALL_DIR
if (-not $d) { return }
foreach ($n in @(__ITEMS__)) { Remove-Item -LiteralPath (Join-Path $d $n) -Recurse -Force -ErrorAction SilentlyContinue }
foreach ($n in @(__PARENTS__)) {
    $p = Join-Path $d $n
    if ((Test-Path -LiteralPath $p) -and -not (Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }
}
if (-not (Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue }
'@
$body = $body.Replace('__ITEMS__', (& $lit $Items)).Replace('__PARENTS__', (& $lit $Parents))
$env:YTLS_UNINSTALL_DIR = $Dir
$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
Start-Process powershell -WorkingDirectory $env:TEMP -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', $enc
Write-Host '  完成。Edge 裡的擴充功能請到 edge://extensions 按「移除」。' -ForegroundColor Green
