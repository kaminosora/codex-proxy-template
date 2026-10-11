# bin/fetch-binaries.ps1 — 补齐 bin\ 下的外部程序（它们不进 git 仓库）
#
# 用途：换台机器、或别人克隆了仓库之后，把缺的外部程序补回来。
#
#   .\bin\fetch-binaries.ps1              # 缺什么补什么
#   .\bin\fetch-binaries.ps1 -Force       # 已存在也重新复制内核
#   .\bin\fetch-binaries.ps1 -DryRun      # 只找、不复制（先看看它会做什么）
#
# 关于 mihomo 内核为什么必须改名：见同目录的 README.md（不改名会打断 Clash Party）。
param(
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$BIN = $PSScriptRoot
$ROOT = Split-Path -Parent $BIN

function Write-Head2($t) {
    Write-Host ''
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * 60)) -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '=== 补齐 bin\ 下的外部程序 ===' -ForegroundColor Yellow
Write-Host "  项目目录: $ROOT"

# ---------------------------------------------------------------- 1. mihomo 内核（改名副本）
Write-Head2 '1/2  mihomo 内核 → bin\codex-core.exe'
$core = Join-Path $BIN 'codex-core.exe'
if ((Test-Path -LiteralPath $core) -and -not $Force -and -not $DryRun) {
    $mb = [math]::Round((Get-Item -LiteralPath $core).Length / 1MB, 1)
    Write-Host "  已存在（$mb MB），跳过。想重新复制加 -Force" -ForegroundColor Green
    if ($DryRun) { Write-Host "  （-DryRun 也会重新走一遍查找）" -ForegroundColor DarkGray }
} else {
    # Clash Party 自带内核的候选路径。
    # ★ 不要写死某台机器的安装路径 ★
    #   早期这里硬编码了一条 `D:\Program Files\...`（作者机器上的位置），
    #   对别人毫无用处。改成：先按惯例路径猜 + 再在常见根目录下递归搜一遍。
    $cands = @()
    foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($base) { $cands += (Join-Path $base 'Mihomo Party\Clash Party\resources\sidecar\mihomo.exe') }
    }
    # 也接受数据目录下的 sidecar（有些版本放这儿）
    if ($env:APPDATA) { $cands += (Join-Path $env:APPDATA 'mihomo-party\sidecar\mihomo.exe') }
    # 还接受"内核就叫 mihomo.exe 且已经在本 bin 目录"的情况（用户手动放的）
    $cands += (Join-Path $BIN 'mihomo.exe')

    $src = $null
    foreach ($c in $cands) { if ($c -and (Test-Path -LiteralPath $c)) { $src = $c; break } }

    # 兜底：在常见安装根目录里搜 sidecar\mihomo.exe（深度限制，避免全盘扫）
    if (-not $src) {
        $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA, 'D:\Program Files', 'D:\', 'E:\Program Files') |
            Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
        Write-Host '  按惯例路径没找到，正在常见目录里搜 sidecar\mihomo.exe …' -ForegroundColor DarkGray
        foreach ($r in $roots) {
            $hit = Get-ChildItem -LiteralPath $r -Recurse -Depth 4 -Filter 'mihomo.exe' -File -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($hit) { $src = $hit.FullName; break }
        }
    }

    if (-not $src) {
        Write-Host '  ✗ 找不到 Clash Party 自带的 mihomo.exe。' -ForegroundColor Red
        Write-Host '    两种办法：' -ForegroundColor Yellow
        Write-Host '      ① 先安装 Clash Party（它自带的内核就在 sidecar 目录里），再跑一次本脚本' -ForegroundColor Yellow
        Write-Host '      ② 自己下一个 mihomo 内核（https://github.com/MetaCubeX/mihomo/releases），' -ForegroundColor Yellow
        Write-Host "         把 mihomo.exe 放到 $core" -ForegroundColor Yellow
        Write-Host '    ⚠️ 文件名必须是 codex-core.exe，不能叫 mihomo.exe —— 理由见 bin\README.md' -ForegroundColor Yellow
    } else {
        Write-Host "  来源: $src"
        try {
            if ($DryRun) {
                Write-Host "  [DryRun] 会复制：$src" -ForegroundColor DarkGray
                Write-Host "  [DryRun] 目标：$core" -ForegroundColor DarkGray
            } else {
            Copy-Item -LiteralPath $src -Destination $core -Force
            $mb = [math]::Round((Get-Item -LiteralPath $core).Length / 1MB, 1)
            Write-Host "  ✔ 已复制并改名为 codex-core.exe（$mb MB）" -ForegroundColor Green
            }
        } catch {
            Write-Host "  ✗ 复制失败: $($_.Exception.Message)" -ForegroundColor Red
        }
    }

    # geoip/geosite 顺手从 Clash Party 的 sidecar 目录一起拿（内核路由要用）
    foreach ($f in 'geoip.dat', 'geosite.dat') {
        $dst = Join-Path $BIN $f
        if ((Test-Path -LiteralPath $dst) -and -not $Force) { continue }
        foreach ($c in $cands) {
            $s = Join-Path (Split-Path -Parent $c) $f
            if (Test-Path -LiteralPath $s) {
                try { Copy-Item -LiteralPath $s -Destination $dst -Force; Write-Host "  ✔ 已复制 $f" -ForegroundColor Green } catch { }
                break
            }
        }
    }
}

# ---------------------------------------------------------------- 2. xray
Write-Head2 '2/2  xray 与配套数据'
$xray = Join-Path $BIN 'xray.exe'
if (Test-Path -LiteralPath $xray) {
    $mb = [math]::Round((Get-Item -LiteralPath $xray).Length / 1MB, 1)
    Write-Host "  ✔ xray.exe 已存在（$mb MB）" -ForegroundColor Green
    # 顺手报一下版本，便于跟服务器对照
    try {
        $v = & $xray version 2>&1 | Select-Object -First 1
        if ($v) { Write-Host "    版本: $v" -ForegroundColor DarkGray }
    } catch { }
    foreach ($f in 'geoip.dat', 'geosite.dat') {
        $p = Join-Path $BIN $f
        if (Test-Path -LiteralPath $p) {
            Write-Host "  ✔ $f 已存在" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ $f 缺失 —— xray 的路由规则可能报错，从同一个压缩包里拿" -ForegroundColor Yellow
        }
    }
} else {
    Write-Host '  ⚠ 没有 xray.exe —— 用不了 xray:jp 出口（会只靠 ssh:jp 与回落出口）' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    下载（选 Xray-windows-64.zip）:' -ForegroundColor Yellow
    Write-Host '      https://github.com/XTLS/Xray-core/releases' -ForegroundColor Yellow
    Write-Host '    解压后把 xray.exe / geoip.dat / geosite.dat 一起放到:' -ForegroundColor Yellow
    Write-Host "      $BIN" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    注意：REALITY 公钥字段名新老版本不同（26.x 叫 password，旧版叫 publicKey）。' -ForegroundColor DarkGray
    Write-Host '          本项目两个都读，所以两种版本都能用。' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 收尾
Write-Head2 '完成'
Write-Host '  验证：'
Write-Host '    .\codex-proxy.ps1 start'
Write-Host '    .\codex-proxy.ps1 status      # 三个出口都应 OK'
Write-Host '    .\codex-proxy.ps1 check       # 出口 IP 应该是你服务器的 IP'
Write-Host ''
