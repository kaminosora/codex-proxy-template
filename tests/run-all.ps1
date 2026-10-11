# tests/run-all.ps1 — 依次跑全部测试脚本并汇总
#
# 用法：
#   pwsh -NoProfile -File tests\run-all.ps1              # 全部（默认）
#   pwsh -NoProfile -File tests\run-all.ps1 -SkipSlow    # 跳过耗时的（07 要重启 Codex 五次）
#   pwsh -NoProfile -File tests\run-all.ps1 -Only 01 -Only 08   # 只跑指定的（重复 -Only，命中最稳）
#   pwsh -NoProfile -File tests\run-all.ps1 -Only @('01','08')  # 同上，数组写法
#
# 每个脚本都会打印自己的结果；本脚本只负责调度与汇总。
# 注意：06 会起停守护进程、07 会反复重启 Codex，跑完请执行 .\codex-proxy.ps1 app 恢复使用。
param(
    [switch]$SkipSlow,
    [string[]]$Only = @()
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$HERE = $PSScriptRoot
$ROOT = Split-Path -Parent $HERE
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { $NODE = 'node' }

$suites = @(
    @{ Id = '01'; Kind = 'mjs'; File = '01-bridge.mjs';            Name = '协议自测（桥接 + 上游）';       Slow = $false; Need = '无' }
    @{ Id = '02'; Kind = 'mjs'; File = '02-ours-channel.mjs';      Name = '通道端到端（真实 OpenAI）';     Slow = $false; Need = '守护进程在运行' }
    @{ Id = '03'; Kind = 'mjs'; File = '03-fallback-isolation.mjs'; Name = '回落出口与 Clash Party 隔离性'; Slow = $true;  Need = 'Clash Party 订阅' }
    @{ Id = '04'; Kind = 'mjs'; File = '04-node-test.mjs';          Name = '回落节点延迟实测';              Slow = $true;  Need = 'Clash Party 订阅' }
    @{ Id = '05'; Kind = 'mjs'; File = '05-reaper.mjs';             Name = 'killTree 与孤儿回收';           Slow = $false; Need = '允许启动子进程' }
    @{ Id = '06'; Kind = 'ps1'; File = '06-process-lifecycle.ps1';  Name = '进程开关生命周期审计';          Slow = $true;  Need = '无' }
    @{ Id = '07'; Kind = 'ps1'; File = '07-egress-paths.ps1';       Name = '三路径流量对照实验';            Slow = $true;  Need = '守护进程在运行 + Codex 已安装' }
    @{ Id = '08'; Kind = 'ps1'; File = '08-codex-egress.ps1';       Name = 'Codex 流量归属审计（只读）';    Slow = $false; Need = 'Codex 正在运行' }
    @{ Id = '09'; Kind = 'ps1'; File = '09-server-recon.ps1';       Name = '服务器只读侦察';                Slow = $true;  Need = 'SSH 可达' }
    @{ Id = '10'; Kind = 'mjs'; File = '10-latency-switch.mjs';     Name = '延迟感知切换防抖动（纯逻辑）';  Slow = $false; Need = '无' }
    @{ Id = '11'; Kind = 'mjs'; File = '11-probe-overhead.mjs';     Name = '后台探测开销与安全性';          Slow = $false; Need = '无' }
    @{ Id = '12'; Kind = 'mjs'; File = '12-selection-rules.mjs';     Name = '出口选择规则（优先级/粘性/性能）';          Slow = $false; Need = '无' }
    @{ Id = '13'; Kind = 'mjs'; File = '13-uplink-accounting.mjs';   Name = '出口流量记账（切换时走哪条）';          Slow = $false; Need = '无' }
    @{ Id = '14'; Kind = 'mjs'; File = '14-yaml-typing.mjs';         Name = '订阅解析与 YAML 输出类型';              Slow = $false; Need = '无' }
    @{ Id = '15'; Kind = 'mjs'; File = '15-app-idempotent.mjs';       Name = 'app 命令幂等（不打断编辑）';            Slow = $false; Need = '无' }
    @{ Id = '16'; Kind = 'mjs'; File = '16-version-strategy.mjs';     Name = 'Codex 版本识别与选择策略';              Slow = $false; Need = '无' }
    @{ Id = '17'; Kind = 'mjs'; File = '17-doc-claims.mjs';          Name = '文档承诺 vs 代码实现一致性';            Slow = $false; Need = '无' }
    @{ Id = '18'; Kind = 'mjs'; File = '18-feature-inventory.mjs';  Name = '功能清单（文档提到的功能是否都实现了）'; Slow = $false; Need = '无' }
    @{ Id = '19'; Kind = 'mjs'; File = '19-output-contract.mjs';    Name = '命令输出契约与行为约定';                Slow = $false; Need = '无' }
    @{ Id = '20'; Kind = 'mjs'; File = '20-test-doc-consistency.mjs'; Name = 'README 预期结果 vs 真实断言数';        Slow = $true;  Need = '允许启动子进程' }
    @{ Id = '21'; Kind = 'mjs'; File = '21-doc-details.mjs';       Name = '文档细节（代码片段/锚点/文案归属）';      Slow = $false; Need = '无' }
)

# 注意：必须用 @() 包起来。只筛出一个套件时，Where-Object 返回的是【单个哈希表】，
# 而哈希表的 .Count 是【键的个数】（这里正好 6 个），会打印出"6 个套件"却只列 1 个。
# 套上 @() 强制成数组，.Count 才是元素个数。
# ★ 修一个真 bug：`-Only 01,08` 筛不出任何套件 ★
#
# 参数声明是 [string[]]$Only，但用 `pwsh -NoProfile -File tests\run-all.ps1 -Only 01,08`
# 调用时，PowerShell **不会**把 "01,08" 按逗号拆开 —— 整个字符串成了一个元素，
# 于是 `$Only -contains '01'` 永远为 false，筛出 0 个套件。
#
# 这个写法是 tests\README.md 里明确教的（"只跑指定的"），所以必须能用。
# 修法：拿到值后再按逗号/空格拆一次，两种调用方式都支持：
#   -Only 01,08        ← -File 方式（README 教的）
#   -Only 01,08 -SkipSlow
#   -Only @('01','08') ← 点源方式
# ---------------------------------------------------------------------------
$Only = @(
    $Only |
        ForEach-Object { "$_" -split '[,\s]+' } |
        Where-Object { $_ -ne '' } |
        ForEach-Object { $_.Trim() }
)
if ($Only.Count -gt 0) {
    Write-Host "  只跑指定套件: $($Only -join ', ')" -ForegroundColor DarkGray
}

$selected = @($suites | Where-Object {
    ($Only.Count -eq 0 -or $Only -contains $_.Id) -and (-not $SkipSlow -or -not $_.Slow)
})

Write-Host '======================================================================' -ForegroundColor Cyan
Write-Host '  Codex 专用代理 · 测试套件' -ForegroundColor Cyan
Write-Host '======================================================================' -ForegroundColor Cyan
Write-Host "项目目录: $ROOT"
Write-Host "本次运行: $($selected.Count) 个套件$(if ($SkipSlow) { '（已跳过耗时项）' })"
Write-Host ''
$selected | ForEach-Object { Write-Host ("  {0}  {1,-34} 需要: {2}" -f $_.Id, $_.Name, $_.Need) }
Write-Host ''

$summary = @()

# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 确保守护进程在跑（需要它的套件，**每个套件运行前**都会调一次）
#
# ★ 为什么是"每个套件之前"而不是"整轮开始之前" ★
#   **06 号套件跑完会把守护进程停掉**（它本来就专门测起停）。
#   早期只在整轮开始前拉一次，于是紧随其后的 07 发现 17890 没在监听、
#   直接报"结论无效"而不跑 —— 实测踩过（17 通过 / 1 失败，唯一失败就是 07）。
#   更早的版本还试图让用户自己记得先 start，那更不可靠。
#   改成逐套件检查后，06 无论怎么折腾都不影响后面的 07/08。
# ---------------------------------------------------------------------------
function Ensure-Daemon {
    param([string]$Why)
    $proxyPort = 17890
    $live = [bool](netstat -ano | Select-String 'LISTENING' | Select-String ":$proxyPort\b")
    if ($live) { return $true }

    Write-Host "  守护进程没在运行（$proxyPort 未监听），先启动它 —— $Why 需要它" -ForegroundColor DarkGray
    & node (Join-Path $ROOT 'codex-proxy.mjs') start *> $null
    # 等它真的开始监听（三出口全启要 10 秒以上，最多等 30 秒）
    for ($k = 0; $k -lt 60; $k++) {
        Start-Sleep -Milliseconds 500
        $live = [bool](netstat -ano | Select-String 'LISTENING' | Select-String ":$proxyPort\b")
        if ($live) { break }
    }
    if ($live) { Write-Host "  ✔ 守护进程已启动（$proxyPort 已监听）" -ForegroundColor DarkGray }
    else { Write-Host "  ⚠ 守护进程没能启动，需要它的套件会自行报错" -ForegroundColor Red }
    return $live
}

foreach ($s in $selected) {
    $p = Join-Path $HERE $s.File
    Write-Host ('=' * 70) -ForegroundColor Yellow
    Write-Host ("  [$($s.Id)] $($s.Name)") -ForegroundColor Yellow
    Write-Host ('=' * 70) -ForegroundColor Yellow

    if (-not (Test-Path -LiteralPath $p)) {
        Write-Host '  脚本不存在，跳过' -ForegroundColor Red
        $summary += [pscustomobject]@{ Id = $s.Id; Name = $s.Name; Exit = -1; Note = '脚本不存在' }
        continue
    }

    # ★ 逐套件确保守护进程在跑 ★
    #   必须在【每个】套件之前查，因为 06 会把守护进程停掉。
    #   06 自己不需要它（它专门测起停），所以排除掉。
    if ($s.Id -ne '06' -and ($s.Need -like '*守护进程*' -or $s.Id -in @('02', '07', '08'))) {
        $null = Ensure-Daemon -Why "[$($s.Id)] $($s.Name)"
    }

    $t0 = Get-Date
    if ($s.Kind -eq 'mjs') {
        & $NODE $p 2>&1 | ForEach-Object { Write-Host $_ }
        $code = $LASTEXITCODE
    } else {
        & pwsh -NoProfile -File $p 2>&1 | ForEach-Object { Write-Host $_ }
        $code = $LASTEXITCODE
    }
    $dt = [int]((Get-Date) - $t0).TotalSeconds

    # 从输出里抓 "N/M 通过" 之类的结论（尽力而为，抓不到就只报退出码）
    $note = ''
    $summary += [pscustomobject]@{ Id = $s.Id; Name = $s.Name; Exit = $code; Note = "$($dt)s" }
    Write-Host ''
}

Write-Host '======================================================================' -ForegroundColor Cyan
Write-Host '  汇总' -ForegroundColor Cyan
Write-Host '======================================================================' -ForegroundColor Cyan
foreach ($r in $summary) {
    $tag = if ($r.Exit -eq 0) { 'PASS' } elseif ($r.Exit -eq -1) { 'SKIP' } else { 'FAIL' }
    $color = if ($r.Exit -eq 0) { 'Green' } elseif ($r.Exit -eq -1) { 'DarkGray' } else { 'Red' }
    Write-Host ("  {0,-5} [{1}] {2,-34} {3}" -f $tag, $r.Id, $r.Name, $r.Note) -ForegroundColor $color
}

$fail = @($summary | Where-Object { $_.Exit -ne 0 -and $_.Exit -ne -1 })
$skip = @($summary | Where-Object { $_.Exit -eq -1 })
Write-Host ''
Write-Host "  通过 $((@($summary | Where-Object { $_.Exit -eq 0 })).Count) / 失败 $($fail.Count) / 跳过 $($skip.Count)"

Write-Host ''
Write-Host '  提示：06 会起停守护进程、07 会反复重启 Codex。' -ForegroundColor DarkGray
Write-Host '        跑完恢复使用：.\codex-proxy.ps1 app' -ForegroundColor DarkGray

exit $(if ($fail.Count -eq 0) { 0 } else { 1 })

