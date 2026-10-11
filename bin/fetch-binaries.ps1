# ============================================================================
#  bin\fetch-binaries.ps1 — 自动补齐 bin\ 下的外部程序
#
#  这个仓库不包含大二进制（GitHub 对 >50MB 的文件会警告、>100MB 直接拒绝）。
#  本脚本负责把它们弄齐：
#
#     1. mihomo 内核 → 改名成 bin\codex-core.exe
#        · 优先从本机已装的 Clash Party 复制（它自带内核）
#        · 没有就从官方 GitHub 发布下载
#        · ★ 必须改名 ★ 理由见下（不改会打断 Clash Party）
#     2. xray 客户端 → bin\xray.exe（含配套 geoip.dat / geosite.dat）
#
#  用法：
#      .\bin\fetch-binaries.ps1                # 缺什么补什么
#      .\bin\fetch-binaries.ps1 -Force         # 已有的也重新获取
#      .\bin\fetch-binaries.ps1 -DryRun        # 只查找/只打印下载计划，不落盘
#      .\bin\fetch-binaries.ps1 -NoDownload    # 只用本机 Clash Party 的内核，不联网
#      .\bin\fetch-binaries.ps1 -Proxy http://127.0.0.1:7890
#
#  ★ 关于网络：本机可能上不了 GitHub。脚本会先探测直连，失败时自动走
#    127.0.0.1:7890 / 17890（Clash Party 与本工具的默认端口）。
# ============================================================================
param(
    [switch]$Force,
    [switch]$DryRun,
    [switch]$NoDownload,
    [string]$Proxy = ''
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$BIN  = $PSScriptRoot
$ROOT = Split-Path -Parent $BIN

function Head($t) {
    Write-Host ''
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * 62)) -ForegroundColor DarkGray
}
function Ok($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Info($t) { Write-Host "  $t" -ForegroundColor DarkGray }
function Warn($t) { Write-Host "  [警告] $t" -ForegroundColor Yellow }
function Err($t)  { Write-Host "  [失败] $t" -ForegroundColor Red }

# ---------------------------------------------------------------- 下载通道
#
# 先直连，失败再走本地代理。为什么需要：目标用户在国内，
# GitHub 直连经常不通，而他们多半装着 Clash Party（本机 7890）。
$script:UseProxy = $Proxy
function Resolve-Proxy {
    if ($script:UseProxy) { return }
    try {
        $null = Invoke-WebRequest -Uri 'https://api.github.com/zen' -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
        $script:UseProxy = '(direct)'
        Info 'GitHub 直连可用'
        return
    } catch { }
    foreach ($p in @('http://127.0.0.1:7890', 'http://127.0.0.1:17890')) {
        try {
            $null = Invoke-WebRequest -Uri 'https://api.github.com/zen' -Proxy $p -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
            $script:UseProxy = $p
            Info "GitHub 直连不通，改走代理 $p"
            return
        } catch { }
    }
    $script:UseProxy = '(direct)'
    Warn '无法确认 GitHub 可达（直连与本地代理都探测失败）—— 稍后下载可能失败'
}

function Get-Url {
    param([string]$Url, [string]$OutFile)
    $a = @{ Uri = $Url; OutFile = $OutFile; TimeoutSec = 900; UseBasicParsing = $true }
    if ($script:UseProxy -and $script:UseProxy -ne '(direct)') { $a.Proxy = $script:UseProxy }
    $old = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest @a -ErrorAction Stop; return $true }
    catch { Err "下载失败: $($_.Exception.Message)"; return $false }
    finally { $ProgressPreference = $old }
}

function Get-GhJson {
    param([string]$Url)
    $a = @{ Uri = $Url; TimeoutSec = 60; UseBasicParsing = $true; Headers = @{ 'User-Agent' = 'codex-proxy-setup' } }
    if ($script:UseProxy -and $script:UseProxy -ne '(direct)') { $a.Proxy = $script:UseProxy }
    try { return Invoke-RestMethod @a -ErrorAction Stop } catch { return $null }
}

function New-TempName {
    param([string]$Prefix, [string]$Ext)
    Join-Path $env:TEMP ("{0}-{1}{2}" -f $Prefix, [guid]::NewGuid().ToString('N').Substring(0, 8), $Ext)
}

Write-Host ''
Write-Host '=== 补齐 bin\ 下的外部程序 ===' -ForegroundColor Yellow
Write-Host "  项目目录: $ROOT"

# ================================================================ 1. mihomo 内核
Head '1/2  mihomo 内核 → bin\codex-core.exe'
$core = Join-Path $BIN 'codex-core.exe'
$needCore = $Force -or $DryRun -or -not (Test-Path -LiteralPath $core)

if (-not $needCore) {
    $mb = [math]::Round((Get-Item -LiteralPath $core).Length / 1MB, 1)
    Ok "已存在（$mb MB），跳过。想重新获取加 -Force"
} else {
    # ---- 来源 A：本机 Clash Party 自带的内核（首选）
    $src = $null
    $cands = @()
    foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($base) { $cands += (Join-Path $base 'Mihomo Party\Clash Party\resources\sidecar\mihomo.exe') }
    }
    if ($env:APPDATA) { $cands += (Join-Path $env:APPDATA 'mihomo-party\sidecar\mihomo.exe') }
    $cands += (Join-Path $BIN 'mihomo.exe')
    foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { $src = $c; break } }

    # ---- 来源 B：常见安装目录里有界搜索（Clash Party 装在非默认位置时）
    if (-not $src) {
        $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)
        foreach ($d in 'C', 'D', 'E', 'F') {
            $roots += "${d}:\"
            $roots += "${d}:\Program Files"
            $roots += "${d}:\Program Files (x86)"
        }
        $roots = $roots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
        Info '按惯例路径没找到，正在常见目录里搜 sidecar\mihomo.exe …'
        foreach ($r in $roots) {
            $hit = Get-ChildItem -LiteralPath $r -Recurse -Depth 4 -Filter 'mihomo.exe' -File -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($hit) { $src = $hit.FullName; break }
        }
    }

    if ($src) {
        Info "来源: $src"
        if ($DryRun) {
            Info "[DryRun] 会复制到: $core（并改名为 codex-core.exe）"
        } else {
            try {
                Copy-Item -LiteralPath $src -Destination $core -Force
                $mb = [math]::Round((Get-Item -LiteralPath $core).Length / 1MB, 1)
                Ok "已复制并改名为 codex-core.exe（$mb MB）"
                # 数据文件顺手带上（内核路由要用）
                foreach ($d in 'geoip.dat', 'geosite.dat') {
                    $dst = Join-Path $BIN $d
                    if ((Test-Path -LiteralPath $dst) -and -not $Force) { continue }
                    $s = Join-Path (Split-Path -Parent $src) $d
                    if (Test-Path -LiteralPath $s) { Copy-Item -LiteralPath $s -Destination $dst -Force; Ok "已复制 $d" }
                }
            } catch { Err "复制失败: $($_.Exception.Message)" }
        }
    } else {
        # ---- 来源 C：官方 GitHub 发布
        if ($NoDownload) {
            Err '本机没找到 Clash Party 的内核，且指定了 -NoDownload'
            Write-Host "    手动下载内核后放到: $core" -ForegroundColor Yellow
            Write-Host '    ⚠️ 文件名必须是 codex-core.exe，不能叫 mihomo.exe（理由见 bin\README.md）' -ForegroundColor Yellow
        } else {
            Warn '本机没找到 Clash Party 的内核，改为从官方 GitHub 下载'
            Resolve-Proxy
            Info '查询 mihomo 最新发布…'
            $rel = Get-GhJson 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest'
            if (-not $rel) {
                Err '查询失败。可手动下载：https://github.com/MetaCubeX/mihomo/releases'
                Write-Host "    选 mihomo-windows-amd64-compatible-*.zip，解压后把 mihomo.exe" -ForegroundColor Yellow
                Write-Host "    改名成 codex-core.exe 放到: $BIN" -ForegroundColor Yellow
            } else {
                Info "最新版本: $($rel.tag_name)"
                # 优先 -compatible（不要求 CPU 支持特定指令集，兼容性最好）
                $asset = $null
                foreach ($n in @("mihomo-windows-amd64-compatible-$($rel.tag_name).zip",
                                 "mihomo-windows-amd64-$($rel.tag_name).zip")) {
                    $asset = $rel.assets | Where-Object { $_.name -eq $n } | Select-Object -First 1
                    if ($asset) { break }
                }
                if (-not $asset) {
                    $asset = $rel.assets | Where-Object { $_.name -like 'mihomo-windows-amd64*' } | Select-Object -First 1
                }
                if (-not $asset) {
                    Err '官方发布里没找到 Windows amd64 资源'
                } else {
                    Info "资源: $($asset.name)（$([math]::Round($asset.size / 1MB, 1)) MB）"
                    if ($DryRun) {
                        Info "[DryRun] 会下载: $($asset.browser_download_url)"
                        Info "[DryRun] 解压出 mihomo.exe 后改名为: $core"
                    } else {
                        $tmp = New-TempName 'mihomo' '.zip'
                        if (Get-Url -Url $asset.browser_download_url -OutFile $tmp) {
                            $ex = New-TempName 'mihomo-x' ''
                            try {
                                Expand-Archive -LiteralPath $tmp -DestinationPath $ex -Force
                                $exe = Get-ChildItem -LiteralPath $ex -Recurse -Filter '*.exe' -File | Select-Object -First 1
                                if ($exe) {
                                    Copy-Item -LiteralPath $exe.FullName -Destination $core -Force
                                    $mb = [math]::Round((Get-Item -LiteralPath $core).Length / 1MB, 1)
                                    Ok "已下载并改名为 codex-core.exe（$mb MB，来自 $($rel.tag_name)）"
                                    foreach ($d in 'geoip.dat', 'geosite.dat') {
                                        $f = Get-ChildItem -LiteralPath $ex -Recurse -Filter $d -File -ErrorAction SilentlyContinue | Select-Object -First 1
                                        if ($f) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $BIN $d) -Force; Ok "已复制 $d" }
                                    }
                                } else { Err '压缩包里没找到 .exe' }
                            } catch { Err "解压失败: $($_.Exception.Message)" }
                            finally {
                                Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
                                Remove-Item -LiteralPath $ex -Recurse -Force -ErrorAction SilentlyContinue
                            }
                        } else { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
                    }
                }
            }
        }
    }
}

# ================================================================ 2. xray
Head '2/2  xray 与配套数据'
$xray = Join-Path $BIN 'xray.exe'

function Get-XrayFromRelease {
    Resolve-Proxy
    Info '查询 Xray 最新发布…'
    $rel = Get-GhJson 'https://api.github.com/repos/XTLS/Xray-core/releases/latest'
    if (-not $rel) { Err '查询失败'; return $false }
    Info "最新版本: $($rel.tag_name)"
    $asset = $rel.assets | Where-Object { $_.name -eq 'Xray-windows-64.zip' } | Select-Object -First 1
    if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -like 'Xray-windows-64*' } | Select-Object -First 1 }
    if (-not $asset) { Err '发布里没找到 Xray-windows-64.zip'; return $false }

    Info "资源: $($asset.name)（$([math]::Round($asset.size / 1MB, 1)) MB）"
    if ($DryRun) {
        Info "[DryRun] 会下载: $($asset.browser_download_url)"
        Info '[DryRun] 会解压出 xray.exe / geoip.dat / geosite.dat 到 bin\'
        return $true
    }
    $tmp = New-TempName 'xray' '.zip'
    if (-not (Get-Url -Url $asset.browser_download_url -OutFile $tmp)) {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        return $false
    }
    $ex = New-TempName 'xray-x' ''
    try {
        Expand-Archive -LiteralPath $tmp -DestinationPath $ex -Force
        $got = 0
        foreach ($n in 'xray.exe', 'geoip.dat', 'geosite.dat') {
            $f = Get-ChildItem -LiteralPath $ex -Recurse -Filter $n -File -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($f) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $BIN $n) -Force; Ok "已放置 $n"; $got++ }
        }
        if ($got) { Ok "来自 $($rel.tag_name)"; return $true }
        Err '压缩包里没找到预期文件'
        return $false
    } catch { Err "解压失败: $($_.Exception.Message)"; return $false }
    finally {
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $ex -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ((Test-Path -LiteralPath $xray) -and -not $Force) {
    $mb = [math]::Round((Get-Item -LiteralPath $xray).Length / 1MB, 1)
    Ok "xray.exe 已存在（$mb MB）"
    try {
        $v = & $xray version 2>&1 | Select-Object -First 1
        if ($v) { Info "版本: $v" }
    } catch { }
    foreach ($d in 'geoip.dat', 'geosite.dat') {
        if (Test-Path -LiteralPath (Join-Path $BIN $d)) { Ok "$d 已存在" }
        else { Warn "$d 缺失 —— xray 的路由规则可能报错（加 -Force 可重新获取）" }
    }
    if ($DryRun) { Info '（-DryRun：也打印一次下载计划）'; $null = Get-XrayFromRelease }
} elseif ($NoDownload) {
    Warn '没有 xray.exe，且指定了 -NoDownload'
    Write-Host '    手动下载（选 Xray-windows-64.zip）：https://github.com/XTLS/Xray-core/releases' -ForegroundColor Yellow
} else {
    $null = Get-XrayFromRelease
    if (-not (Test-Path -LiteralPath $xray)) {
        Warn '没有 xray.exe —— xray:jp 出口用不了（会只靠 ssh:jp 与回落出口）'
        Write-Host ''
        Write-Host '    手动下载（选 Xray-windows-64.zip）：' -ForegroundColor Yellow
        Write-Host '      https://github.com/XTLS/Xray-core/releases' -ForegroundColor Yellow
        Write-Host "    解压后把 xray.exe / geoip.dat / geosite.dat 放到: $BIN" -ForegroundColor Yellow
        Write-Host ''
        Write-Host '    注意：REALITY 公钥字段名新老版本不同（26.x 叫 password，旧版叫 publicKey）。' -ForegroundColor DarkGray
        Write-Host '          本项目两个都读，所以两种版本都能用。' -ForegroundColor DarkGray
    }
}

# ================================================================ 收尾
Head '完成'
Write-Host '  验证：'
Write-Host '    .\codex-proxy.ps1 start'
Write-Host '    .\codex-proxy.ps1 status      # 三个出口都应 OK'
Write-Host '    .\codex-proxy.ps1 check       # 出口 IP 应该是你服务器的 IP'
Write-Host ''
Write-Host '  ⚠️ 如果还没填配置里的占位符，先跑交互式引导：' -ForegroundColor Yellow
Write-Host '      .\setup.ps1' -ForegroundColor Yellow
Write-Host '    （它会一步步问你、自动验证，并把该填的都填上）' -ForegroundColor DarkGray
Write-Host ''
