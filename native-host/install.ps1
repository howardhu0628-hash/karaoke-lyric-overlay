# 註冊／移除 Edge 的「原生訊息」小幫手，讓擴充功能面板的「啟動本機服務」按鈕能用。
# 只寫目前使用者的登錄機碼 HKCU\Software\Microsoft\Edge\NativeMessagingHosts\ytlyricsub.host（不用系統管理員）。
# v1.0.61 以前叫 com.claude.ytls：註冊、移除時都順便清掉舊名稱。
# 用法：powershell -ExecutionPolicy Bypass -File install.ps1 [-ExtensionId <ID>] [-Uninstall]
#   擴充功能 ID 在 edge://extensions 的「YT 歌詞字幕」卡片上；換資料夾重新載入後 ID 會變，要重跑一次。
param([string]$ExtensionId = 'eodcndmiihigkmmaogbgplbjkdeapckh', [switch]$Uninstall)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$zp = Join-Path $PSScriptRoot '..\lib\zhcn.ps1'; if (Test-Path -LiteralPath $zp) { . $zp } # Windows 是簡體中文時，畫面上的字轉成簡體
$key = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\ytlyricsub.host'
$manifest = Join-Path $PSScriptRoot 'ytlyricsub.host.json'
Remove-Item 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.claude.ytls' -ErrorAction SilentlyContinue
Remove-Item (Join-Path $PSScriptRoot 'com.claude.ytls.json') -ErrorAction SilentlyContinue
if ($Uninstall) {
    Remove-Item $key -ErrorAction SilentlyContinue
    Remove-Item $manifest -ErrorAction SilentlyContinue
    Write-Host '已移除。面板上的「啟動本機服務」按鈕之後會無法使用。' -ForegroundColor Green
    return
}
if ($ExtensionId -notmatch '^[a-p]{32}$') { Write-Host "擴充功能 ID 格式不對：$ExtensionId" -ForegroundColor Red; return }
$json = [ordered]@{
    name            = 'ytlyricsub.host'
    description     = 'YT 歌詞字幕：啟動本機 OCR／AI 聽寫服務'
    path            = 'ytls-host.cmd'
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifest, $json, (New-Object Text.UTF8Encoding $false))
New-Item -Path $key -Force | Out-Null
Set-Item -Path $key -Value $manifest
Write-Host "已註冊（擴充功能 $ExtensionId）。到 edge://extensions 重新載入擴充功能後就能用。" -ForegroundColor Green
