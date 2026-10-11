# tests/06-process-lifecycle.ps1 — 进程开关生命周期审计（9 项）
#
# 这个脚本回答一个很实在的问题：**反复 start / stop 之后，有没有孤儿残留？**
# 它自己会起停守护进程，所以运行期间 Codex 的代理会短暂中断。
#
# 检查项：
#   1) 全新状态下 start 能起来，4 个端口都在监听
#   2) 重复 start 是幂等的（不会起第二个守护进程）
#   3) stop 之后守护进程退出
#   4) stop 之后 4 个端口全部释放
#   5) stop 之后没有孤儿子进程（ssh / xray / mihomo）
#   6) 强杀守护进程后，start 能自动认领并清理残留
#   7) 最终状态干净（端口全释放、无孤儿）
#
# 用法： pwsh -NoProfile -File tests\06-process-lifecycle.ps1
# 预期： 7/7 通过
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$ROOT = Split-Path -Parent $PSScriptRoot
$PROXY = Join-Path $ROOT 'codex-proxy.mjs'
$PORTS = 17890, 17891, 17892, 17893

$results = @()
function Check($name, $ok, $detail = '') {
    $script:results += [pscustomobject]@{ Name = $name; Ok = [bool]$ok; Detail = $detail }
    $tag = if ($ok) { '[OK]  ' } else { '[FAIL]' }
    $color = if ($ok) { 'Green' } else { 'Red' }
    Write-Host "  $tag $name$(if ($detail) { '  — ' + $detail })" -ForegroundColor $color
}
function Step($s) { Write-Host "--> $s" -ForegroundColor Cyan }

function ListeningPorts {
    @(netstat -ano | Select-String 'LISTENING' |
        ForEach-Object { if ($_.Line -match ':(\d+)\s+\S+\s+LISTENING\s+(\d+)') { [pscustomobject]@{ Port = [int]$Matches[1]; Pid = [int]$Matches[2] } } } |
        Where-Object { $PORTS -contains $_.Port })
}
function OrphanChildren {
    # 我们的三个出口子进程名
    #
    # ★ 必须排除"测试开始前就已经存在的同名进程" ★
    #   踩过的坑：**Clash Party 自己的内核进程名就是 mihomo**。用户开着 Clash Party
    #   跑本测试时，检查项 5 会把它报成"残留: mihomo#3844"，然后 7 也跟着挂 —— 两个
    #   假失败，看起来像我们 stop 之后留了孤儿，其实那是人家的进程。
    #
    #   做法：在测试开头（我们还没起任何东西时）先给同名进程拍个 PID 快照，
    #   之后只把"不在快照里的"算作孤儿。这样既不误报，也不放松判据。
    @(Get-Process -Name xray, mihomo, ssh -ErrorAction SilentlyContinue |
        Where-Object { -not $Script:PreexistingPids.Contains($_.Id) })
}
function SnapshotPreexisting {
    $Script:PreexistingPids = @{}
    foreach ($p in @(Get-Process -Name xray, mihomo, ssh -ErrorAction SilentlyContinue)) {
        $Script:PreexistingPids[$p.Id] = $p.ProcessName
    }
    if ($Script:PreexistingPids.Count) {
        $desc = ($Script:PreexistingPids.GetEnumerator() | ForEach-Object { "$($_.Value)#$($_.Key)" }) -join ', '
        Write-Host "  说明：测试开始前已有同名进程（会排除，不算我们的孤儿）：$desc" -ForegroundColor DarkGray
        Write-Host '        （多半是 Clash Party 自己的内核，它的进程名就是 mihomo）' -ForegroundColor DarkGray
    }
}
function DaemonOf {
    $c = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*codex-proxy.mjs*daemon*" }
    @($c)
}

Write-Host '=== 06 进程开关生命周期审计 ===' -ForegroundColor Yellow
Write-Host "项目目录: $ROOT`n"

# ★ 先拍快照，再动任何东西 ★
#   必须在第一次 start 之前调用 —— 那时还存在的同名进程都是"别人的"。
SnapshotPreexisting

# ---------------------------------------------------------------- 1
Step '1. 干净状态下 start'
& node $PROXY stop 2>&1 | Out-Null
Start-Sleep -Seconds 2
& node $PROXY start 2>&1 | Out-Null
Start-Sleep -Seconds 3
$l = ListeningPorts
$daemons = DaemonOf
Check 'start 后守护进程存在' ($daemons.Count -eq 1) "找到 $($daemons.Count) 个守护进程"
Check '四个端口都在监听' ($l.Count -eq 4) "监听 $($l.Count)/4: $((($l | ForEach-Object { $_.Port }) -join ', '))"

# ---------------------------------------------------------------- 2
Step '2. 重复 start 的幂等性'
& node $PROXY start 2>&1 | Out-Null
Start-Sleep -Seconds 3
$daemons2 = DaemonOf
Check '重复 start 不会起第二个守护进程' ($daemons2.Count -eq 1) "守护进程数 $($daemons2.Count)"

# ---------------------------------------------------------------- 3
Step '3. stop 能优雅退出'
$t0 = Get-Date
& node $PROXY stop 2>&1 | Out-Null
$dt = [int]((Get-Date) - $t0).TotalMilliseconds
Start-Sleep -Seconds 2
$daemons3 = DaemonOf
Check 'stop 后守护进程已退出' ($daemons3.Count -eq 0) "剩余 $($daemons3.Count) 个（耗时 ${dt}ms）"
Check 'stop 在 15 秒内完成' ($dt -lt 15000) "${dt}ms"

# ---------------------------------------------------------------- 4
Step '4. stop 后端口释放'
$l4 = ListeningPorts
Check '四个端口全部释放' ($l4.Count -eq 0) "仍占用: $((($l4 | ForEach-Object { "$($_.Port)(pid $($_.Pid))" }) -join ', '))"

# ---------------------------------------------------------------- 5
Step '5. stop 后无孤儿子进程'
$orphans = OrphanChildren
Check '没有 xray / mihomo / ssh 孤儿' ($orphans.Count -eq 0) $(if ($orphans.Count) { "残留: " + (($orphans | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join ', ') } else { '' })

# ---------------------------------------------------------------- 6
Step '6. 强杀守护进程后能否自动恢复'
& node $PROXY start 2>&1 | Out-Null
Start-Sleep -Seconds 3
$d = DaemonOf
if ($d.Count -eq 1) {
    Stop-Process -Id $d[0].ProcessId -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    $left = ListeningPorts
    Write-Host "    强杀后仍占用的端口: $((($left | ForEach-Object { $_.Port }) -join ', '))" -ForegroundColor DarkGray
    & node $PROXY start 2>&1 | Out-Null
    Start-Sleep -Seconds 4
    $l6 = ListeningPorts
    $d6 = DaemonOf
    Check '强杀后 start 能自动认领并清理残留' ($d6.Count -eq 1 -and $l6.Count -eq 4) "守护进程 $($d6.Count) 个，监听 $($l6.Count)/4"
} else {
    Check '强杀后 start 能自动认领并清理残留' $false "前置步骤没拿到唯一的守护进程"
}

# ---------------------------------------------------------------- 7
Step '7. 最终状态干净'
& node $PROXY stop 2>&1 | Out-Null
Start-Sleep -Seconds 2
$l7 = ListeningPorts
$o7 = @(OrphanChildren)
$d7 = DaemonOf
Check '最终端口全释放、无守护进程、无孤儿' ($l7.Count -eq 0 -and $o7.Count -eq 0 -and $d7.Count -eq 0) `
    "端口 $($l7.Count) 个，孤儿 $($o7.Count) 个，守护进程 $($d7.Count) 个"

# ---------------------------------------------------------------- 汇总
Write-Host ''
Write-Host '=== 汇总 ===' -ForegroundColor Yellow
$pass = @($results | Where-Object { $_.Ok }).Count
Write-Host "$pass/$($results.Count) 通过"
foreach ($r in ($results | Where-Object { -not $_.Ok })) { Write-Host "  未通过: $($r.Name) — $($r.Detail)" -ForegroundColor Red }

Write-Host ''
Write-Host '注：本脚本结束时守护进程是停止状态。要恢复使用：.\codex-proxy.ps1 start' -ForegroundColor DarkGray
exit $(if ($pass -eq $results.Count) { 0 } else { 1 })
