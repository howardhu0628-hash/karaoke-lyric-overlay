# YT 歌詞字幕：本機 OCR 服務（用 Windows 內建的日文 OCR，不需要安裝任何東西）
# 只聽 localhost:8766，只接受擴充功能（chrome-extension:// 來源）的請求。
# 用法：雙擊「啟動 OCR 服務.cmd」，或 powershell -ExecutionPolicy Bypass -File ocr-server.ps1
param([int]$Port = 8766, [string]$Lang = 'ja')

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

# WinRT 非同步 → .NET Task
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $null = $task.Wait(-1)
    $task.Result
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($Lang))
if (-not $engine) { Write-Host "這台電腦沒有 $Lang 的 OCR 語言套件。" -ForegroundColor Red; exit 1 }

function Invoke-Ocr([byte[]]$bytes, [double]$scale = 1) {
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if ($scale -ne 1) {
        # 放大後再辨識：細字、小字會讀得比較準（座標最後換算回原圖）
        $tf = New-Object Windows.Graphics.Imaging.BitmapTransform
        $tf.ScaledWidth = [uint32][math]::Min(9990, [math]::Round($decoder.PixelWidth * $scale))
        $tf.ScaledHeight = [uint32][math]::Min(9990, [math]::Round($decoder.PixelHeight * $scale))
        $tf.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
        $op = $decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
            $tf, [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation, [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)
        $bitmap = Await $op ([Windows.Graphics.Imaging.SoftwareBitmap])
    } else {
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    }
    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines = foreach ($line in $result.Lines) {
        $xs = $line.Words | ForEach-Object { $_.BoundingRect }
        $x0 = ($xs | Measure-Object -Property X -Minimum).Minimum
        $y0 = ($xs | Measure-Object -Property Y -Minimum).Minimum
        $x1 = ($xs | ForEach-Object { $_.X + $_.Width } | Measure-Object -Maximum).Maximum
        $y1 = ($xs | ForEach-Object { $_.Y + $_.Height } | Measure-Object -Maximum).Maximum
        # 日文 OCR 會在每個字之間插空白，把 CJK 字之間的空白拿掉
        $text = ($line.Words | ForEach-Object { $_.Text }) -join ' '
        $text = [regex]::Replace($text, '(?<=[\p{IsCJKUnifiedIdeographs}\p{IsHiragana}\p{IsKatakana}ー々〆、。「」『』！？]) (?=[\p{IsCJKUnifiedIdeographs}\p{IsHiragana}\p{IsKatakana}ー々〆、。「」『』！？])', '')
        [ordered]@{ text = $text; x = [int]($x0 / $scale); y = [int]($y0 / $scale); w = [int](($x1 - $x0) / $scale); h = [int](($y1 - $y0) / $scale) }
    }
    $bitmap.Dispose(); $ms.Dispose()
    , @($lines)
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { Write-Host "無法開在 localhost:$Port（可能已經有一個在跑）：$($_.Exception.Message)" -ForegroundColor Red; exit 1 }
Write-Host "YT 歌詞字幕 OCR 服務已啟動：http://localhost:$Port （語言：$Lang）。關掉這個視窗就會停止。" -ForegroundColor Green

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request; $res = $ctx.Response
    try {
        $origin = $req.Headers['Origin']
        $allowed = (-not $origin) -or $origin.StartsWith('chrome-extension://') -or $origin.StartsWith('extension://') -or $origin.StartsWith('http://localhost:8765')
        if ($allowed -and $origin) {
            $res.Headers['Access-Control-Allow-Origin'] = $origin
            $res.Headers['Access-Control-Allow-Headers'] = 'content-type, x-ytls'
            $res.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
            $res.Headers['Access-Control-Allow-Private-Network'] = 'true'
        }
        if (-not $allowed) { $res.StatusCode = 403 }
        elseif ($req.HttpMethod -eq 'OPTIONS') { $res.StatusCode = 204 }
        elseif ($req.HttpMethod -eq 'GET' -and $req.Url.AbsolutePath -eq '/ping') {
            $body = [System.Text.Encoding]::UTF8.GetBytes('{"ok":true,"lang":"' + $Lang + '"}')
            $res.ContentType = 'application/json; charset=utf-8'; $res.OutputStream.Write($body, 0, $body.Length)
        }
        elseif ($req.HttpMethod -eq 'POST' -and $req.Url.AbsolutePath -eq '/ocr' -and $req.Headers['X-YTLS'] -eq '1') {
            $buf = New-Object System.IO.MemoryStream
            $req.InputStream.CopyTo($buf)
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $scale = 1.0; if ($req.QueryString["scale"]) { $scale = [math]::Max(0.25, [math]::Min(3, [double]$req.QueryString["scale"])) }
            $lines = Invoke-Ocr $buf.ToArray() $scale
            $json = [ordered]@{ ok = $true; ms = $sw.ElapsedMilliseconds; lines = $lines } | ConvertTo-Json -Depth 4 -Compress
            $body = [System.Text.Encoding]::UTF8.GetBytes($json)
            $res.ContentType = 'application/json; charset=utf-8'; $res.OutputStream.Write($body, 0, $body.Length)
        }
        else { $res.StatusCode = 404 }
    } catch {
        $res.StatusCode = 500
        $body = [System.Text.Encoding]::UTF8.GetBytes('{"ok":false,"error":' + (ConvertTo-Json "$($_.Exception.Message)") + '}')
        try { $res.OutputStream.Write($body, 0, $body.Length) } catch {}
    } finally { try { $res.Close() } catch {} }
}
