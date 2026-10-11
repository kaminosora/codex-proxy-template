# tests/08-codex-egress.ps1 — Codex 流量归属审计（只读，最常用）
#
# 怀疑"有流量绕过专用代理"时跑这个。它把 Codex 每一个进程的每一条已建立连接
# 按归属分类，明确标出有没有泄漏：
#     [专用代理(17890)]  ← 正常
#     [★Clash(7890)]     ← 泄漏（走了 Clash）
#     [★直连外网]        ← 泄漏（根本没走代理）
#
# 同时会列出各端口的进程归属，以及主进程的 --proxy-server 参数。
#
# 只读，不改任何东西。
#
# 用法： pwsh -NoProfile -File tests\08-codex-egress.ps1
# 预期（用 .\codex-proxy.ps1 app 启动时）：
#     [专用代理(17890)] N 条
#     [★直连外网]       0 条
#     [★Clash(7890)]    0 条
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$OURS = 17890
$CLASH_PORTS = @(7890, 7891, 7892)

Write-Host '=== 08 Codex 流量归属审计（只读）===' -ForegroundColor Yellow
Write-Host ''

Write-Host '--- 参照：本地代理端口与系统代理 ---'
foreach ($p in (@($OURS) + $CLASH_PORTS)) {
    $l = netstat -ano | Select-String 'LISTENING' | Select-String ":$p\b"
    $owner = if ($l -and $l.Line -match 'LISTENING\s+(\d+)') { $Matches[1] } else { $null }
    Write-Host ("  {0,-6} {1}{2}" -f $p, $(if ($l) { '在监听' } else { '未监听' }), $(if ($owner) { " (pid $owner)" } else { '' }))
}
$sys = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
Write-Host ("  系统代理: ProxyEnable={0} ProxyServer={1}" -f $sys.ProxyEnable, $sys.ProxyServer)
Write-Host ''

Write-Host '--- Codex 进程 ---'
$codex = @(Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if (-not $codex.Count) {
    Write-Host '  Codex 没有在运行。先执行：.\codex-proxy.ps1 app' -ForegroundColor Yellow
    exit 0
}
Write-Host "  共 $($codex.Count) 个进程: $($codex -join ', ')"
Write-Host ''

Write-Host '--- 主进程的启动参数 ---'
$mains = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' })
if ($mains.Count) {
    foreach ($m in $mains) {
        $hasOurs = $m.CommandLine -match "--proxy-server=127\.0\.0\.1:$OURS"
        $hasClash = $m.CommandLine -match '--proxy-server=127\.0\.0\.1:(7890|7891|7892)'
        $none = $m.CommandLine -notmatch '--proxy-server='
        $verdict = if ($hasOurs) { '✓ 指向我们的代理' } elseif ($hasClash) { '✗ 指向 Clash' } elseif ($none) { '✗ 没有 --proxy-server（走系统代理或直连）' } else { '? 指向别的地址' }
        Write-Host ("  PID {0}  {1}" -f $m.ProcessId, $verdict) -ForegroundColor $(if ($hasOurs) { 'Green' } else { 'Red' })
    }
} else { Write-Host '  没找到主进程（可能都是子进程）' }
Write-Host ''

Write-Host '--- 谁在连我们的代理 ---'
$on = Get-NetTCPConnection -LocalPort $OURS -State Established -ErrorAction SilentlyContinue
if ($on) {
    $on | Group-Object OwningProcess | ForEach-Object {
        $pr = Get-Process -Id $_.Name -ErrorAction SilentlyContinue
        $nm = if ($pr) { $pr.ProcessName } else { '?' }
        $tag = if ($codex -contains [int]$_.Name) { '  ← Codex' } else { '' }
        Write-Host ("  PID {0,-8} {1,-14} {2} 条{3}" -f $_.Name, $nm, $_.Count, $tag)
    }
} else { Write-Host '  （无连接）' }
Write-Host ''

Write-Host '--- 谁在连 Clash ---'
$anyClash = @()
foreach ($p in $CLASH_PORTS) {
    $anyClash += @(Get-NetTCPConnection -LocalPort $p -State Established -ErrorAction SilentlyContinue)
}
if ($anyClash.Count) {
    $anyClash | Group-Object OwningProcess | ForEach-Object {
        $pr = Get-Process -Id $_.Name -ErrorAction SilentlyContinue
        $nm = if ($pr) { $pr.ProcessName } else { '?' }
        $tag = if ($codex -contains [int]$_.Name) { '  ← ★Codex 在连 Clash（不该有）' } else { '' }
        Write-Host ("  PID {0,-8} {1,-14} {2} 条{3}" -f $_.Name, $nm, $_.Count, $tag) -ForegroundColor $(if ($tag) { 'Red' } else { 'Gray' })
    }
} else { Write-Host '  （无连接）' }
Write-Host ''

Write-Host '--- Codex 每条连接的归属 ---'
$rows = @()
foreach ($p in $codex) {
    foreach ($c in (Get-NetTCPConnection -OwningProcess $p -State Established -ErrorAction SilentlyContinue)) {
        $isLoop = ($c.RemoteAddress -eq '127.0.0.1' -or $c.RemoteAddress -eq '::1')
        $k = if (-not $isLoop) { '★直连外网' }
             elseif ($c.RemotePort -eq $OURS) { '专用代理(17890)' }
             elseif ($CLASH_PORTS -contains $c.RemotePort) { '★Clash' }
             else { "本机其它($($c.RemotePort))" }
        $rows += [pscustomobject]@{
            PID    = $p
            分类   = $k
            远端   = if ($isLoop) { "127.0.0.1:$($c.RemotePort)" } else { "$($c.RemoteAddress):$($c.RemotePort)" }
        }
    }
}
if ($rows.Count) {
    $rows | Group-Object 分类 | Sort-Object Count -Descending | ForEach-Object {
        $color = if ($_.Name -like '★*') { 'Red' } else { 'Green' }
        Write-Host ("  [{0}] {1} 条" -f $_.Name, $_.Count) -ForegroundColor $color
        $_.Group | Group-Object 远端 | Sort-Object Count -Descending | Select-Object -First 10 | ForEach-Object {
            Write-Host ("      {0,-50} {1} 条" -f $_.Name, $_.Count)
        }
    }
} else {
    Write-Host '  （当前没有已建立的连接 —— Codex 空闲时是正常的）' -ForegroundColor DarkGray
}
Write-Host ''

Write-Host '--- 结论 ---' -ForegroundColor Yellow
$direct = @($rows | Where-Object { $_.分类 -eq '★直连外网' })
$clash = @($rows | Where-Object { $_.分类 -eq '★Clash' })
$ours = @($rows | Where-Object { $_.分类 -eq '专用代理(17890)' })
Write-Host ("  走专用代理 : {0} 条" -f $ours.Count)
if ($direct.Count -or $clash.Count) {
    Write-Host ("  直连外网   : {0} 条" -f $direct.Count) -ForegroundColor Red
    Write-Host ("  走 Clash   : {0} 条" -f $clash.Count) -ForegroundColor Red
    Write-Host '  → 存在泄漏！检查主进程是否带 --proxy-server=127.0.0.1:17890' -ForegroundColor Red
} else {
    Write-Host '  直连外网   : 0 条  ✓' -ForegroundColor Green
    Write-Host '  走 Clash   : 0 条  ✓' -ForegroundColor Green
    Write-Host '  → 全部走专用代理 ✓' -ForegroundColor Green
}
