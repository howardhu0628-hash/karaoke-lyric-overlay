# YT 歌詞字幕 v1.0 安裝程式（Windows 10／11，Edge）
# 裝好的東西：擴充功能、兩個本機服務（畫面 OCR、AI 聽寫＋伴奏），以及它們要用的 Python、模型、工具。
# 全部放在同一個資料夾（預設 %LOCALAPPDATA%\YTLyricSub），不寫系統資料夾、不用系統管理員。
# 要下載的東西（約 5 GB）全部來自官方來源：
#   uv（Python 安裝工具，Astral）、Python 3.12、PyTorch（pytorch.org）、faster-whisper／RapidOCR 等套件（PyPI）、
#   Whisper large-v3-turbo 模型（Hugging Face mobiuslabsgmbh）、BS-RoFormer 去人聲模型（UVR 公開模型庫）、
#   yt-dlp、Node.js（yt-dlp 解 YouTube 要用）、ffmpeg（BtbN 的 GPL 版，含 rubberband 變調）。
# 重複執行 = 更新：已經下載過的東西不會再下載，只換新的程式檔（伴奏、聽寫的快取都保留）。
#
# 分級安裝（數字大的包含小的；之後想加，再跑一次選大一點的就好）：
#   1 歌詞、字幕、翻譯（不用下載）  2 ＋畫面字幕 OCR  3 ＋雲端 AI 聽寫、官方伴奏、升降 Key（不裝 AI 模型）  4 全部
#
# 用法：雙擊「安裝.cmd」。進階：install.ps1 [-Dir <資料夾>] [-Tier 1～4] [-Yes] [-NoTasks] [-NoNativeHost] [-NoStart]
param(
    [string]$Dir = '',
    [ValidateRange(0, 4)][int]$Tier = 0,  # 要裝哪一級（0＝問使用者；-Yes 時用建議的）
    [switch]$Yes,           # 不問問題，全部用預設
    [switch]$NoTasks,       # 不建立開機自動啟動的排程工作（測試用）
    [switch]$NoNativeHost,  # 不註冊面板上「啟動本機服務」按鈕要用的小幫手（測試用）
    [switch]$NoStart        # 裝完不啟動服務（測試用）
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$PKG = $PSScriptRoot
$VERSION = '1.0'
$TOTAL = 8

function Step($n, $msg) { Write-Host ''; Write-Host "[$n/$TOTAL] $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  OK  $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "      $msg" -ForegroundColor Gray }
function Warn($msg) { Write-Host "  !!  $msg" -ForegroundColor Yellow }

# 下載（curl.exe 是 Windows 內建的）：先存成 .part，斷線重跑會接著下載；下載完才改名，所以「檔案在」就代表完整。
# -Fresh：網址指向「最新版」（GitHub latest、目前的 Node LTS），隔天重跑時檔案可能已經換了，接著舊的 .part 下載會拼出壞檔：從頭下載
function Get-File($url, $out, [string]$what = '', [switch]$Fresh) {
    if (Test-Path $out) { Info "已經有了：$(Split-Path $out -Leaf)"; return }
    New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
    if ($what) { Info "下載 $what" }
    $part = "$out.part"
    if ($Fresh) { Remove-Item -Force $part -ErrorAction SilentlyContinue }
    for ($i = 1; $i -le 3; $i++) {
        & curl.exe -L --fail --retry 3 --retry-delay 3 -C - --progress-bar -o $part $url
        if ($LASTEXITCODE -eq 0) { Move-Item -Force $part $out; return }
        if ($LASTEXITCODE -eq 33) { Remove-Item -Force $part -ErrorAction SilentlyContinue }  # 伺服器不支援續傳：從頭來
        Warn "下載失敗（curl 代碼 $LASTEXITCODE），第 $i 次重試…"
        Start-Sleep -Seconds 3
    }
    throw "下載失敗：$url"
}

# GitHub 最新版的附件：直接網址偶爾回 504，失敗就改走 API 拿附件網址
function Get-GitHubAsset($repo, $assetName, $out, $what) {
    if (Test-Path $out) { Info "已經有了：$(Split-Path $out -Leaf)"; return }
    try { Get-File "https://github.com/$repo/releases/latest/download/$assetName" $out $what -Fresh; return }
    catch { Warn "直接下載失敗，改用 GitHub API…" }
    $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'ytls-installer' }
    $a = $rel.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
    if (-not $a) { throw "GitHub $repo 最新版裡找不到 $assetName" }
    Get-File $a.browser_download_url $out $what -Fresh
}

# 照顯示卡建議裝哪一級。本機 AI 要：世代（compute capability）7.0 以上——GTX 16／RTX 20 起；GTX 10 系列的
# faster-whisper 不支援 float16，會退回 CPU（很慢）——而且顯存 6 GB 以上才放得下聽寫＋去人聲兩個模型（聽寫約 2.2 GB）。
# $lines：nvidia-smi 每張卡一行「名稱, 顯存 MiB[, compute_cap]」；有好幾張卡就看最好的那張
function Get-GpuAdvice([string[]]$lines) {
    $best = $null
    foreach ($l in $lines) {
        $p = @($l -split ',' | ForEach-Object { $_.Trim() })
        if ($p.Count -lt 2 -or -not $p[0] -or $p[0] -match 'not a valid|Failed|error') { continue }
        $mib = 0; [void][int]::TryParse(($p[1] -replace '[^\d]', ''), [ref]$mib)
        $cc = 0.0
        if ($p.Count -ge 3) { [void][double]::TryParse($p[2], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$cc) }
        if (-not $cc) {  # 舊驅動查不到世代：看名字（RTX、GTX 16 系列、資料中心卡算新；其他 GTX、GT、MX、舊 Quadro 算舊）
            if ($p[0] -match 'RTX|GTX 16\d\d|TITAN V|Tesla T4|\bA\d{1,4}\b|\bL\d{1,2}\b|H100') { $cc = 7.5 }
            elseif ($p[0] -match 'GTX|\bGT \d|MX ?\d|Quadro [KMP]|Tesla [KMP]') { $cc = 6.0 }
        }
        $c = [pscustomobject]@{ name = $p[0]; gb = [math]::Round($mib / 1024, 1); cc = $cc }
        $score = { param($x) $(if ($x.cc -ge 7) { 1000 } else { 0 }) + $x.gb }
        if (-not $best -or (& $score $c) -gt (& $score $best)) { $best = $c }
    }
    if (-not $best) { return [pscustomobject]@{ tier = 3; gpu = $null; why = '沒有 NVIDIA 顯示卡，本機 AI 只能用處理器跑（很慢），AI 聽寫用雲端' } }
    $gpu = "$($best.name)（$($best.gb) GB）"
    if (-not $best.cc) { return [pscustomobject]@{ tier = 3; gpu = $gpu; why = '認不出這張卡的世代，保險起見用雲端聽寫' } }
    if ($best.cc -lt 7) { return [pscustomobject]@{ tier = 3; gpu = $gpu; why = '這張卡比較舊，本機 AI 會退回處理器跑（很慢），AI 聽寫用雲端' } }
    if ($best.gb -lt 5.5) { return [pscustomobject]@{ tier = 3; gpu = $gpu; why = '顯存不到 6 GB，AI 去人聲可能跑不動（只要本機 AI 聽寫的話選 4 也可以）' } }
    return [pscustomobject]@{ tier = 4; gpu = $gpu; why = '夠跑本機 AI 聽寫和 AI 去人聲' }
}

function Expand-Zip($zip, $dest) {
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    try { Expand-Archive -Path $zip -DestinationPath $dest -Force }
    catch {
        $err = $_
        # 壓縮檔本身壞掉（下載不完整）才刪：留著的話之後每次都會被當成「已經有了」，刪掉下次重跑會重新下載。
        # 其他原因（磁碟滿了、檔案被防毒鎖住）不要刪好好的檔案，照實說
        $bad = $false
        for ($e = $err.Exception; $e; $e = $e.InnerException) { if ($e -is [IO.InvalidDataException]) { $bad = $true } }
        if (-not $bad) {
            try {
                Add-Type -AssemblyName System.IO.Compression.FileSystem
                $z = [IO.Compression.ZipFile]::OpenRead($zip); $null = $z.Entries.Count; $z.Dispose()
            } catch { $bad = $true }
        }
        if ($bad) {
            Remove-Item -Force $zip -ErrorAction SilentlyContinue
            throw "$(Split-Path $zip -Leaf) 壞掉了（下載不完整），已經刪掉；再雙擊一次「安裝.cmd」會重新下載"
        }
        throw "解壓縮 $(Split-Path $zip -Leaf) 失敗：$($err.Exception.Message)（磁碟空間夠嗎？）"
    }
}

# 執行外部程式、丟掉它的錯誤輸出：Windows PowerShell 5.1 在 ErrorActionPreference=Stop 時，
# 被轉向的錯誤輸出（例如 uv 印在 stderr 的「Clearing cache…」）會被當成例外，整個安裝就中斷了
function Invoke-Quiet($exe, [string[]]$argv) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $exe @argv 2>$null } finally { $ErrorActionPreference = $old }
}

function Invoke-Checked($exe, [string[]]$argv, $what) {
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { throw "$what 失敗（代碼 $LASTEXITCODE）" }
}

# 磁碟上真正的大小寫：Edge「載入解壓縮」用的是它，使用者打的大小寫不同時算出來的 ID 會對不上（「▶ 啟動本機服務」就不能用）
function Get-TrueCasePath($path) {
    $item = Get-Item -LiteralPath $path
    $names = @()
    while ($item.Parent) {
        $real = Get-ChildItem -LiteralPath $item.Parent.FullName -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq $item.Name } | Select-Object -First 1
        $names = @($(if ($real) { $real.Name } else { $item.Name })) + $names
        $item = $item.Parent
    }
    $root = $item.FullName.ToUpper()
    if (-not $names.Count) { return $root.TrimEnd('\') }
    return (Join-Path $root ($names -join '\'))
}

# Edge「載入解壓縮」的擴充功能 ID = 資料夾完整路徑（UTF-16）的 SHA-256 前 16 個位元組，0～f 換成 a～p
function Get-ExtensionId($path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $h = $sha.ComputeHash([Text.Encoding]::Unicode.GetBytes($path))
    -join ($h[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
}

Write-Host ''
Write-Host "  YT 歌詞字幕 v$VERSION 安裝程式" -ForegroundColor White
Write-Host '  （日文歌詞／字幕＋假名＋翻譯、畫面字幕 OCR、AI 聽寫、伴奏與升降 Key）' -ForegroundColor Gray

# ---------- 0. 安裝位置 ----------
# 之前裝過（更新、加功能）：預設裝回原本的資料夾，不然裝在別處的人更新時會多裝出一份。
# 從「啟動本機服務」小幫手的登錄找（<安裝資料夾>\app\native-host\*.json），那裡有安裝記號才算（開發用的資料夾不算）
function Get-InstallDirFromManifest($m) {
    if (-not $m) { return $null }
    try { $d = Split-Path (Split-Path (Split-Path $m -Parent) -Parent) -Parent } catch { return $null }
    if ($d -and (Test-Path -LiteralPath (Join-Path $d 'ytls-install.txt'))) { return $d }
    return $null
}
function Find-PreviousDir {
    foreach ($h in 'ytlyricsub.host', 'com.claude.ytls') {
        $m = (Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$h" -ErrorAction SilentlyContinue).'(default)'
        $d = Get-InstallDirFromManifest $m
        if ($d) { return $d }
    }
    return $null
}
if (-not $Dir) {
    $prev = Find-PreviousDir
    if ($prev) { $Dir = $prev }
    else {
        $Dir = Join-Path $env:LOCALAPPDATA 'YTLyricSub'
        if ($Dir -match '[^\x00-\x7F]') { $Dir = 'C:\YTLyricSub' }  # 使用者名稱有中文：部分工具對非英文路徑不穩，改裝到 C:\YTLyricSub
    }
    if (-not $Yes) {
        Write-Host ''
        Write-Host "  要裝到：$Dir" -ForegroundColor White
        if ($prev) { Write-Host '  （之前裝在這裡：更新、加功能都裝回這裡，下載過的東西不會重抓）' -ForegroundColor Gray }
        $ans = Read-Host '  直接按 Enter 用這個資料夾，或輸入其他資料夾（路徑請用英文）'
        if ($ans.Trim()) { $Dir = $ans.Trim().Trim('"') }
    }
}
# 指定的資料夾本來就有別的東西（例如 D:\AI、磁碟根目錄），而且不是之前裝過的：裝到裡面的 YTLyricSub 子資料夾，
# 不要跟別人的檔案混在一起（解除安裝時才不會動到同名的 tools、models 之類的資料夾）
$ours = 'app', 'tools', 'models', 'python', 'py-listen', 'py-ocr', 'uv-cache', 'downloads', 'install.log', 'ytls-install.txt', 'uninstall.ps1', '解除安裝.cmd'
if ((Test-Path -LiteralPath $Dir) -and -not (Test-Path -LiteralPath (Join-Path $Dir 'ytls-install.txt')) -and -not (Test-Path -LiteralPath (Join-Path $Dir 'app\ytls-config.json'))) {
    if (Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue | Where-Object { $ours -notcontains $_.Name } | Select-Object -First 1) {
        $Dir = Join-Path $Dir 'YTLyricSub'
        Info "這個資料夾裡已經有別的東西，改裝到裡面的子資料夾：$Dir"
    }
}
New-Item -ItemType Directory -Force $Dir | Out-Null
$Dir = Get-TrueCasePath ((Get-Item $Dir).FullName.TrimEnd('\'))
$logFile = Join-Path $Dir 'install.log'
try { Start-Transcript -Path $logFile -Append | Out-Null } catch { }

try {
    # 顯示卡：名稱、顯存、世代（compute capability；舊驅動查不到這一欄就只查前兩欄，世代看名字猜）
    $gpuLines = @()
    $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($smi) {
        $gpuLines = @(Invoke-Quiet $smi.Source @('--query-gpu=name,memory.total,compute_cap', '--format=csv,noheader,nounits'))
        if ($LASTEXITCODE -ne 0) { $gpuLines = @(Invoke-Quiet $smi.Source @('--query-gpu=name,memory.total', '--format=csv,noheader,nounits')) }
        $global:LASTEXITCODE = 0
    }
    $adv = Get-GpuAdvice $gpuLines
    $cuda = [bool]$adv.gpu  # 有 NVIDIA 顯示卡：選 4 時裝 CUDA 版的 PyTorch
    if ($adv.gpu) { Ok "顯示卡：$($adv.gpu)" } else { Info '找不到 NVIDIA 顯示卡。' }
    Info "建議裝等級 $($adv.tier)：$($adv.why)"

    # ---------- 要裝哪些功能（分級，數字大的包含小的）----------
    $cfgFile = Join-Path $Dir 'app\ytls-config.json'
    $prevTier = 0
    if (Test-Path -LiteralPath $cfgFile) {
        # 之前裝過：v1.0.56 以前的版本沒有分級，一律是全部（4）
        try { $pc = Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json; $prevTier = $(if ($pc.tier) { [int]$pc.tier } else { 4 }) } catch { $prevTier = 4 }
    }
    $suggest = $(if ($prevTier) { $prevTier } else { $adv.tier })
    if (-not $Tier) {
        $Tier = $suggest
        if (-not $Yes) {
            Write-Host ''
            Write-Host '  要裝哪些功能？數字大的包含前面的；之後想加，再跑一次安裝選大一點的就好。' -ForegroundColor White
            Write-Host '    1  歌詞、字幕、翻譯、假名（不用下載）'
            Write-Host '    2  ＋畫面上的字幕（OCR）                          下載約 0.2 GB'
            Write-Host '    3  ＋AI 聽寫（雲端，要自己申請免費金鑰）、伴奏（官方伴奏、升降 Key）'
            Write-Host '                                                       下載約 0.5 GB  ← 顯示卡不夠力選這個'
            Write-Host '    4  全部：＋本機 AI 聽寫、AI 去人聲               下載約 5 GB    ← RTX 顯示卡、顯存 6 GB 以上'
            Write-Host "  你的顯示卡：$(if ($adv.gpu) { $adv.gpu } else { '沒有 NVIDIA' }) → 建議 $($adv.tier)（$($adv.why)）" -ForegroundColor Gray
            $ans = Read-Host "  輸入 1～4（直接按 Enter＝$suggest）"
            if ($ans.Trim() -match '^[1-4]$') { $Tier = [int]$ans.Trim() }
        }
    }
    if ($Tier -ge 4 -and $adv.tier -lt 4 -and $prevTier -lt 4) {
        Warn "這張顯示卡跑本機 AI 可能很慢或跑不動（$($adv.why)）；照樣裝 4，用不順的話到擴充功能設定改用雲端聽寫。"
    }
    if ($prevTier -and $Tier -lt $prevTier) {
        Warn "這裡已經裝了等級 $prevTier：這次照樣更新等級 $prevTier（要變小請先執行「解除安裝.cmd」再重裝）。"
        $Tier = $prevTier
    }
    Ok "安裝等級 $Tier"

    $drive = (Get-Item $Dir).PSDrive
    $freeGB = [math]::Round($drive.Free / 1GB, 1)
    $needGB = @{ 1 = 0.1; 2 = 1; 3 = 2; 4 = 10 }[$Tier]
    if ($freeGB -lt $needGB) { Warn "$($drive.Name): 槽只剩 $freeGB GB，這一級安裝過程最多會用到約 $needGB GB。" }

    $app = Join-Path $Dir 'app'
    $tools = Join-Path $Dir 'tools'
    $models = Join-Path $Dir 'models'
    $dl = Join-Path $Dir 'downloads'
    $uv = Join-Path $tools 'uv\uv.exe'
    $ytdlp = Join-Path $tools 'yt-dlp\yt-dlp.exe'
    $node = Join-Path $tools 'node\node.exe'
    $ffmpeg = Join-Path $tools 'ffmpeg\bin\ffmpeg.exe'
    $whisper = Join-Path $models 'faster-whisper-large-v3-turbo'
    $roformer = Join-Path $models 'model_bs_roformer_ep_317_sdr_12.9755.ckpt'
    $pyListen = Join-Path $Dir 'py-listen\Scripts\python.exe'
    $pyOcr = Join-Path $Dir 'py-ocr\Scripts\python.exe'

    # ---------- 1. 擴充功能和服務的程式 ----------
    Step 1 '複製擴充功能和本機服務的程式'
    $src = Join-Path $PKG 'app'
    if (-not (Test-Path (Join-Path $src 'manifest.json'))) { throw "安裝包不完整：找不到 $src\manifest.json" }
    # 安裝資料夾的記號：解除安裝看到它才刪東西，而且只刪安裝程式放進去的那些（資料夾裡有別的東西不會被刪）
    [IO.File]::WriteAllText((Join-Path $Dir 'ytls-install.txt'), "YT 歌詞字幕的安裝資料夾（解除安裝用的記號，請不要刪）`r`n", (New-Object Text.UTF8Encoding $false))
    # 解除安裝程式一開始就放進去：後面哪一步失敗（已經下載了好幾 GB、排程工作也可能建好了），都能在安裝資料夾裡解除安裝
    Copy-Item -Force (Join-Path $PKG 'uninstall.ps1') (Join-Path $Dir 'uninstall.ps1')
    Copy-Item -Force (Join-Path $PKG '解除安裝.cmd') (Join-Path $Dir '解除安裝.cmd')
    # 更新時不要蓋掉使用者自己加過名字的 hotwords.txt
    $keep = @()
    if (Test-Path (Join-Path $app 'listen-server\hotwords.txt')) { $keep = @('/XF', 'hotwords.txt') }
    robocopy $src $app /E /NFL /NDL /NJH /NJS /NP /XD cache tmp __pycache__ @keep | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "複製程式失敗（robocopy 代碼 $LASTEXITCODE）" }
    $global:LASTEXITCODE = 0
    Ok "程式放在 $app"

    # ---------- 2. 工具 ----------
    Step 2 '下載工具：uv（等級 2 起）、yt-dlp、Node.js、ffmpeg（等級 3 起）'
    if ($Tier -lt 2) { Info '略過（等級 1 不用）' }
    if ($Tier -ge 2 -and -not (Test-Path $uv)) {
        Get-GitHubAsset 'astral-sh/uv' 'uv-x86_64-pc-windows-msvc.zip' (Join-Path $dl 'uv.zip') 'uv（Python 安裝工具）'
        Expand-Zip (Join-Path $dl 'uv.zip') (Split-Path $uv)
    }
    if ($Tier -ge 2) { Ok 'uv' }
    if ($Tier -ge 3) {
    if (Test-Path $ytdlp) {
        Invoke-Quiet $ytdlp @('-U')  # 已經裝過：更新到最新版（YouTube 常改版）
    } else {
        Get-GitHubAsset 'yt-dlp/yt-dlp' 'yt-dlp.exe' $ytdlp 'yt-dlp'
        # 不完整的 exe 會一直被當成「已經有了」：太小或不是執行檔就刪掉重來
        $head = [IO.File]::ReadAllBytes($ytdlp)
        if ($head.Length -lt 1MB -or $head[0] -ne 0x4D -or $head[1] -ne 0x5A) {
            Remove-Item -Force $ytdlp
            throw 'yt-dlp.exe 下載不完整，已經刪掉；再雙擊一次「安裝.cmd」會重新下載'
        }
    }
    Ok 'yt-dlp'
    if (-not (Test-Path $node)) {
        $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
        $lts = $idx | Where-Object { $_.lts -and ($_.files -contains 'win-x64-zip') } | Select-Object -First 1
        $name = "node-$($lts.version)-win-x64"
        Get-File "https://nodejs.org/dist/$($lts.version)/$name.zip" (Join-Path $dl 'node.zip') "Node.js $($lts.version)" -Fresh
        Expand-Zip (Join-Path $dl 'node.zip') (Join-Path $dl 'node-x')
        New-Item -ItemType Directory -Force (Join-Path $tools 'node') | Out-Null
        Copy-Item (Join-Path $dl "node-x\$name\node.exe") $node
        Remove-Item -Recurse -Force (Join-Path $dl 'node-x')
    }
    Ok 'Node.js'
    if (-not (Test-Path $ffmpeg)) {
        Get-GitHubAsset 'BtbN/FFmpeg-Builds' 'ffmpeg-master-latest-win64-gpl.zip' (Join-Path $dl 'ffmpeg.zip') 'ffmpeg（約 200 MB）'
        Expand-Zip (Join-Path $dl 'ffmpeg.zip') (Join-Path $dl 'ffmpeg-x')
        $inner = Get-ChildItem (Join-Path $dl 'ffmpeg-x') -Directory | Select-Object -First 1
        if (Test-Path (Join-Path $tools 'ffmpeg')) { Remove-Item -Recurse -Force (Join-Path $tools 'ffmpeg') }
        Move-Item $inner.FullName (Join-Path $tools 'ffmpeg')
        Remove-Item -Recurse -Force (Join-Path $dl 'ffmpeg-x')
    }
    $filters = Invoke-Quiet $ffmpeg @('-hide_banner', '-filters') | Out-String
    if ($filters -notmatch 'rubberband') { Warn '這個 ffmpeg 沒有 rubberband：升降 Key 會不能用（其他功能正常）。' } else { Ok 'ffmpeg（含 rubberband 變調）' }
    }

    # ---------- 3. Python 和套件 ----------
    Step 3 $(if ($Tier -ge 4) { '安裝 Python 3.12 和套件（PyTorch 約 2.5 GB，第一次要等比較久）' } else { '安裝 Python 3.12 和套件' })
    if ($Tier -lt 2) { Info '略過（等級 1 不用）' } else {
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $Dir 'python'
    $env:UV_CACHE_DIR = Join-Path $Dir 'uv-cache'
    $env:UV_LINK_MODE = 'copy'
    $env:UV_HTTP_TIMEOUT = '300'
    # 新版 uv（0.8 起）預設還會在 %USERPROFILE%\.local\bin 放 python3.12.exe、在登錄記一筆：都不要，東西只放在安裝資料夾裡
    # （舊版 uv 不認得這兩個變數，會直接忽略）
    $env:UV_PYTHON_INSTALL_BIN = '0'
    $env:UV_PYTHON_INSTALL_REGISTRY = '0'
    Invoke-Checked $uv @('python', 'install', '3.12') '安裝 Python'
    if (-not (Test-Path $pyOcr)) { Invoke-Checked $uv @('venv', (Join-Path $Dir 'py-ocr'), '--python', '3.12') '建立 OCR 的 Python 環境' }
    if ($Tier -ge 3 -and -not (Test-Path $pyListen)) { Invoke-Checked $uv @('venv', (Join-Path $Dir 'py-listen'), '--python', '3.12') '建立 AI 聽寫的 Python 環境' }
    if ($Tier -ge 4) {
        $torchIndex = 'https://download.pytorch.org/whl/cpu'
        if ($cuda) { $torchIndex = 'https://download.pytorch.org/whl/cu124' }
        Info 'PyTorch…'
        Invoke-Checked $uv @('pip', 'install', '--python', $pyListen, 'torch==2.6.0', '--index-url', $torchIndex) '安裝 PyTorch'
        Info 'AI 聽寫、去人聲要用的套件…'
        Invoke-Checked $uv @('pip', 'install', '--python', $pyListen, 'torch==2.6.0', 'faster-whisper==1.1.1', 'numpy<2.3', 'scipy', 'librosa',
            'soundfile', 'einops', 'rotary-embedding-torch', 'pyyaml', 'tqdm', 'packaging') '安裝 AI 聽寫套件'
    } elseif ($Tier -ge 3) {
        # 雲端聽寫、官方伴奏比對只要 numpy、scipy（不裝 PyTorch、Whisper）
        Info '雲端聽寫、伴奏比對要用的套件…'
        Invoke-Checked $uv @('pip', 'install', '--python', $pyListen, 'numpy<2.3', 'scipy') '安裝 AI 聽寫套件'
    }
    Info '畫面 OCR 要用的套件…'
    Invoke-Checked $uv @('pip', 'install', '--python', $pyOcr, 'rapidocr==3.10.0', 'onnxruntime-directml', 'opencv-python-headless', 'numpy') '安裝 OCR 套件'
    Ok 'Python 環境'
    }

    # ---------- 4. 模型 ----------
    Step 4 $(if ($Tier -ge 4) { '下載模型：Whisper large-v3-turbo（1.6 GB）、BS-RoFormer 去人聲（640 MB）、OCR' } else { '下載模型：OCR' })
    if ($Tier -lt 2) { Info '略過（等級 1 不用）' }
    if ($Tier -ge 4) {
        foreach ($f in 'config.json', 'preprocessor_config.json', 'tokenizer.json', 'vocabulary.json', 'model.bin') {
            Get-File "https://huggingface.co/mobiuslabsgmbh/faster-whisper-large-v3-turbo/resolve/main/$f" (Join-Path $whisper $f) "Whisper：$f"
        }
        Get-File 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/model_bs_roformer_ep_317_sdr_12.9755.ckpt' $roformer '去人聲模型'
    }
    if ($Tier -ge 2) {
        Info 'OCR 模型（RapidOCR 第一次用時自己下載，這裡先載一次）…'
        Invoke-Checked $pyOcr @('-c', 'from rapidocr import RapidOCR; RapidOCR()') '下載 OCR 模型'
        Ok '模型'
    }

    # ---------- 5. 設定檔 ----------
    Step 5 '寫入設定'
    # tier：擴充功能看它決定哪些功能要顯示「沒安裝」；服務看有沒有 whisper、roformer 決定能不能用本機聽寫、AI 去人聲
    $cfg = [ordered]@{ version = $VERSION; tier = $Tier }
    if ($Tier -ge 3) { $cfg['ytdlp'] = $ytdlp; $cfg['node'] = $node; $cfg['ffmpeg'] = $ffmpeg }
    if ($Tier -ge 4) { $cfg['whisper'] = $whisper; $cfg['roformer'] = $roformer }
    [IO.File]::WriteAllText((Join-Path $app 'ytls-config.json'), ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    Ok "$app\ytls-config.json"
    if ($Tier -ge 3) {
        Info '檢查 AI 聽寫環境能不能載入…'
        # 路徑用環境變數傳（直接貼進 Python 字串的話，路徑有單引號——例如使用者名稱 O'Brien——就會語法錯誤）
        $env:YTLS_APP = $app
        $check = "import os, sys; sys.path.insert(0, os.path.join(os.environ['YTLS_APP'], 'listen-server')); import paths; paths.setup_dll_path(); import numpy, scipy.signal; "
        if ($Tier -ge 4) { $check += "import torch, ctranslate2, faster_whisper; print('torch', torch.__version__, 'CUDA', torch.cuda.is_available(), 'CT2 GPU', ctranslate2.get_cuda_device_count())" }
        else { $check += "print('numpy', numpy.__version__, '本機聽寫', paths.LOCAL_OK, 'AI 去人聲', paths.SEP_OK)" }
        & $pyListen -c $check
        if ($LASTEXITCODE -ne 0) { throw 'AI 聽寫環境載入失敗（上面有錯誤訊息）' }
    }

    # ---------- 6. 開機自動啟動的服務 ----------
    $taskPath = '\YTLyricSub\'
    # 等級 2 起有 OCR 服務、等級 3 起有 AI 聽寫服務（伴奏也在裡面）
    $tasks = @(
        @{ tier = 2; port = 8766; name = 'YT 歌詞字幕 OCR 服務'; exe = (Join-Path $Dir 'py-ocr\Scripts\pythonw.exe'); script = "$app\ocr-server\ocr-server-paddle.py"; wd = "$app\ocr-server" },
        @{ tier = 3; port = 8767; name = 'YT 歌詞字幕 AI 聽寫服務'; exe = (Join-Path $Dir 'py-listen\Scripts\pythonw.exe'); script = "$app\listen-server\listen-server.py"; wd = "$app\listen-server" }
    ) | Where-Object { $Tier -ge $_.tier }
    Step 6 '建立開機自動啟動的服務（工作排程器）'
    if (-not $tasks) { Info '略過（等級 1 沒有本機服務）' } elseif ($NoTasks) { Info '略過（-NoTasks）' } else {
        $user = "$env:USERDOMAIN\$env:USERNAME"
        # v1.0.61 以前排程放在 \Claude\ 資料夾：只拿掉這兩個名字的工作，資料夾裡別的工作不動
        foreach ($n in 'YT 歌詞字幕 OCR 服務', 'YT 歌詞字幕 AI 聽寫服務') {
            $legacy = Get-ScheduledTask -TaskPath '\Claude\' -TaskName $n -ErrorAction SilentlyContinue
            if ($legacy) { Stop-ScheduledTask -InputObject $legacy -ErrorAction SilentlyContinue; Unregister-ScheduledTask -InputObject $legacy -Confirm:$false }
        }
        foreach ($t in $tasks) {
            $old = Get-ScheduledTask -TaskPath $taskPath -TaskName $t.name -ErrorAction SilentlyContinue
            if ($old) { Stop-ScheduledTask -InputObject $old -ErrorAction SilentlyContinue; Unregister-ScheduledTask -InputObject $old -Confirm:$false }
            $action = New-ScheduledTaskAction -Execute $t.exe -Argument ('"' + $t.script + '"') -WorkingDirectory $t.wd
            $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
            $trigger.Delay = 'PT1M'
            $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
            $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
            Register-ScheduledTask -TaskPath $taskPath -TaskName $t.name -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
            Ok $t.name
        }
    }

    # ---------- 7. 面板「▶ 啟動本機服務」按鈕 ----------
    Step 7 '註冊面板上「啟動本機服務」按鈕要用的小幫手'
    $extId = Get-ExtensionId $app
    if (-not $tasks) { Info '略過（等級 1 沒有本機服務）' } elseif ($NoNativeHost) { Info "略過（-NoNativeHost）；擴充功能 ID 會是 $extId" } else {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $app 'native-host\install.ps1') -ExtensionId $extId
        if ($LASTEXITCODE -ne 0) { Warn '小幫手註冊失敗：面板上的啟動按鈕不能用，但開機會自動啟動服務。' }
    }

    # ---------- 8. 啟動、清理 ----------
    Step 8 '啟動服務、清掉暫存'
    if ($tasks -and -not $NoStart -and -not $NoTasks) {
        foreach ($t in $tasks) { Start-ScheduledTask -TaskPath $taskPath -TaskName $t.name }
        $port = ($tasks | Select-Object -Last 1).port  # 最後一個（AI 聽寫，或只有 OCR 時的 OCR）回應了就算好了
        $ok = $false
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 500
            try { Invoke-WebRequest "http://127.0.0.1:$port/ping" -UseBasicParsing -TimeoutSec 2 -Headers @{ 'X-YTLS' = '1' } | Out-Null; $ok = $true; break } catch { }
        }
        if ($ok) { Ok '服務已啟動' } else { Warn '服務還沒回應，可能還在啟動；面板上可以按「▶ 啟動本機服務」。' }
    }
    if (Test-Path $uv) { Invoke-Quiet $uv @('cache', 'clean') | Out-Null }
    if (Test-Path $dl) { Remove-Item -Recurse -Force $dl }
    $bytes = (Get-ChildItem $Dir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    Ok ('安裝完成，共 ' + $(if ($bytes -ge 1GB) { '{0:N1} GB' -f ($bytes / 1GB) } else { '{0:N0} MB' -f ($bytes / 1MB) }))

    Write-Host ''
    Write-Host '  最後一步：把擴充功能載入 Edge（只要做一次）' -ForegroundColor White
    Write-Host '    1. 等一下會打開 Edge 的「擴充功能」頁面'
    Write-Host '    2. 打開左邊的「開發人員模式」'
    Write-Host '    3. 按「載入解壓縮」，選這個資料夾（路徑已經複製好，在選擇視窗的網址列按 Ctrl+V 就好）：'
    Write-Host "       $app" -ForegroundColor Yellow
    Write-Host '    4. 打開 YouTube 任一部影片，播放器右下角會有「詞」按鈕'
    if ($Tier -eq 3) {
        Write-Host ''
        Write-Host '  AI 聽寫用的是雲端（這一級沒有裝本機模型）：' -ForegroundColor White
        Write-Host '    點 Edge 工具列的擴充功能圖示 →「AI 聽寫」選「雲端」→ 照那裡寫的三個步驟申請免費的 Groq 金鑰、貼上、按「測試」'
    }
    if ($Tier -lt 4) {
        Write-Host ''
        Write-Host "  （這次裝的是等級 $Tier；之後想加功能，再雙擊一次「安裝.cmd」選大一點的數字就好，已經下載的不會重抓）" -ForegroundColor Gray
    }
    Write-Host ''
    Write-Host "  （擴充功能 ID 應該是 $extId；不一樣的話面板上的啟動按鈕會不能用，重跑一次安裝就好）" -ForegroundColor Gray
    Write-Host "  以後有新版：把新的安裝包解壓縮、再雙擊一次「安裝.cmd」，已下載的東西不會重抓。" -ForegroundColor Gray
    if (-not $Yes) { try { Set-Clipboard -Value $app } catch { } }  # -Yes（自動安裝、測試）不要動到剪貼簿
    if (-not $Yes) { Start-Process 'msedge.exe' 'edge://extensions/' -ErrorAction SilentlyContinue }
} catch {
    Write-Host ''
    Write-Host "  安裝失敗：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  詳細記錄在 $logFile 。網路問題的話，直接再雙擊一次「安裝.cmd」會從斷掉的地方接著做。" -ForegroundColor Red
    try { Stop-Transcript | Out-Null } catch { }
    exit 1
}
try { Stop-Transcript | Out-Null } catch { }
exit 0
