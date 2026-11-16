# 介面語言：Windows 是簡體中文時，把腳本印到畫面上的字（Write-Host、Read-Host 的提示）轉成簡體。
# 用的是 lib\zhcn.json（跟擴充功能同一份表，tools\make-zhcn.py 產生）。繁體環境什麼都不做。
# 用法（在腳本開頭）：. <這支的路徑>   ；環境變數 YTLS_LANG=zh-TW／zh-CN 可以強制。
function Test-YtlsCN {
    if ($env:YTLS_LANG) { return $env:YTLS_LANG -eq 'zh-CN' }
    # 先看 Windows 介面語言；介面是英文之類的（不是中文），再看地區設定（大陸用英文版 Windows 的人，地區通常還是中國）
    $n = ''
    try { $n = (Get-UICulture).Name } catch { }
    if ($n -notmatch '^zh') { try { $n = (Get-Culture).Name } catch { } }
    return [bool]($n -match '^zh-(CN|SG|Hans)')
}

if (Test-YtlsCN) {
    $script:YtlsZhRounds = $null
    try {
        Add-Type -AssemblyName System.Web.Extensions
        $ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $ser.MaxJsonLength = 64MB
        $json = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'zhcn.json'), [Text.Encoding]::UTF8)
        $script:YtlsZhRounds = foreach ($t in $ser.DeserializeObject($json)['rounds']) {
            $max = 1; foreach ($k in $t.Keys) { if ($k.Length -gt $max) { $max = $k.Length } }
            , @{ map = $t; max = $max }
        }
    } catch { $script:YtlsZhRounds = $null } # 讀不到表就照原樣（繁體）顯示，不影響安裝

    # 檔名不轉：「再雙擊一次「安裝.cmd」」變成「安装.cmd」的話，照著找會找不到檔案（跟 lib\zhcn.js 同一條規則）
    $script:YtlsFileRe = '(「[^」\n]*\.(?:cmd|txt|ps1|log)」|[^\s「」（）()，。、：:；;]+\.(?:cmd|txt|ps1|log)\b)'
    function Convert-YtlsZh([string]$s) {
        if (-not $script:YtlsZhRounds -or -not $s) { return $s }
        $parts = [regex]::Split($s, $script:YtlsFileRe)
        return -join (0..($parts.Count - 1) | ForEach-Object { if ($_ % 2) { $parts[$_] } else { Convert-YtlsPlain $parts[$_] } })
    }
    function Convert-YtlsPlain([string]$s) {
        if (-not $s) { return $s }
        foreach ($r in $script:YtlsZhRounds) {
            $sb = New-Object System.Text.StringBuilder
            $i = 0
            while ($i -lt $s.Length) {
                $hit = $false
                for ($L = [Math]::Min($r.max, $s.Length - $i); $L -gt 0; $L--) {
                    $k = $s.Substring($i, $L)
                    if ($r.map.ContainsKey($k)) { [void]$sb.Append($r.map[$k]); $i += $L; $hit = $true; break }
                }
                if (-not $hit) { [void]$sb.Append($s[$i]); $i++ }
            }
            $s = $sb.ToString()
        }
        return $s
    }

    # 同名函式會蓋過內建的 cmdlet：把字轉好再交給真正的 Write-Host／Read-Host
    function Write-Host {
        param([Parameter(Position = 0)] $Object = '', $ForegroundColor, $BackgroundColor, [switch]$NoNewline)
        $p = @{}
        if ($PSBoundParameters.ContainsKey('ForegroundColor')) { $p.ForegroundColor = $ForegroundColor }
        if ($PSBoundParameters.ContainsKey('BackgroundColor')) { $p.BackgroundColor = $BackgroundColor }
        if ($NoNewline) { $p.NoNewline = $true }
        Microsoft.PowerShell.Utility\Write-Host (Convert-YtlsZh ([string]$Object)) @p
    }
    function Read-Host {
        param([Parameter(Position = 0)] $Prompt)
        if ($PSBoundParameters.ContainsKey('Prompt')) { Microsoft.PowerShell.Utility\Read-Host (Convert-YtlsZh ([string]$Prompt)) }
        else { Microsoft.PowerShell.Utility\Read-Host }
    }
}
