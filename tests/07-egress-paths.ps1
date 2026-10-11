# tests/07-egress-paths.ps1 — 三路径流量对照实验（最重要的一份证据）
#
# 回答一个核心问题：**Codex 到底把流量发到哪里去了？**
# 方法是：同一种启动方式，只改变网络条件，逐轮观测 Codex 进程的真实连接。
#
# ---------------------------------------------------------------------------
# 五轮对照
# ---------------------------------------------------------------------------
#   A. 直连（无代理参数、无环境变量）     → 预期随系统代理状态而变（见下）
#   B. --proxy-server 指向 Clash 7890     → 预期：全部走 7890
#   C. --proxy-server 指向我们的 17890     → 预期：全部走 17890，零直连零走 Clash
#   D. --proxy-server 指向死端口 17899     → 预期：0 条连接（代理不可用 → 登录页）
#   E. 无参数 + 环境变量指向 17890         → 预期：走直连（证明 Chromium 不读环境变量）
#
# ---------------------------------------------------------------------------
# ★ 必须在两种系统代理状态下各跑一遍 ★
# ---------------------------------------------------------------------------
#   这是本测试的关键：A / B 两轮的结论**取决于系统代理状态**，只跑一种状态得不到完整证据。
#
#   系统代理【关闭】时：
#     A 轮 = 纯直连外网            ← 证明"系统代理关着，它就直连"
#     B 轮 = 0 条连接              ← 因为 7890 没人监听
#
#   系统代理【开启 → Clash 7890】时：
#     A 轮 = 部分走 Clash + 部分直连  ← 证明"不给参数时它读系统代理"
#     B 轮 = 全部走 7890            ← 正常对照
#
#   C / D / E 三轮与系统代理状态【无关】，两轮结果应完全一致
#   —— 这本身就是一条重要证据：给参数时，系统代理不影响它。
#
# 所以脚本默认会：先让你把系统代理**关掉**、确认后跑一遍；
# 再让你把系统代理**打开（Clash）**、确认后跑第二遍；最后把两边并排对比。
#
# ⚠️ 本脚本会反复重启 Codex，结束后 Codex 是关闭状态。要恢复：.\codex-proxy.ps1 app
# ⚠️ 【本脚本不修改系统代理】，只读取它、并提示你手动改。
#
# ---------------------------------------------------------------------------
# 用法
# ---------------------------------------------------------------------------
#   pwsh -NoProfile -File tests\07-egress-paths.ps1
#       交互式双跑（推荐）：两次系统代理状态各跑一遍，并中途等你确认
#
#   pwsh -NoProfile -File tests\07-egress-paths.ps1 -Only C
#       只跑某一轮（不做系统代理交互；C/D/E 与系统代理无关，这样跑最省事）
#
#   pwsh -NoProfile -File tests\07-egress-paths.ps1 -NonInteractive
#       双跑但不等你确认 —— 当前系统代理状态是什么就按什么跑
#       （用于自动化；两次跑的结果会被标注为"同一状态"，对比意义有限）
param(
    [int]$WaitSec = 24,
    [string]$Only = 'all',         # all | A | B | C | D | E
    [switch]$NonInteractive
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$ROOT = Split-Path -Parent $PSScriptRoot
$OURS = 17890
$CLASH = 7890
$DEAD = 17899

# ---------------------------------------------------------------- 前置：环境
$pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
if (-not $pkg) { Write-Host '找不到 Codex 桌面应用（Get-AppxPackage 没结果）。' -ForegroundColor Red; exit 1 }
$DESKTOP = Join-Path $pkg.InstallLocation 'app\ChatGPT.exe'
if (-not (Test-Path -LiteralPath $DESKTOP)) { Write-Host "Codex 可执行文件不存在: $DESKTOP" -ForegroundColor Red; exit 1 }
$CLI = $null
$d = Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin" -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($d) { $CLI = Join-Path $d.FullName 'codex.exe' }

function Get-SysProxy {
    $s = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Enable = [int]$s.ProxyEnable; Server = [string]$s.ProxyServer }
}
function Test-PortLive([int]$Port) {
    return [bool](netstat -ano | Select-String 'LISTENING' | Select-String ":${Port}\b")
}

$sys = Get-SysProxy
$oursLive = Test-PortLive $OURS
$clashLive = Test-PortLive $CLASH

Write-Host '=== 07 三路径流量对照实验 ===' -ForegroundColor Yellow
Write-Host "Codex: $DESKTOP"
Write-Host "系统代理: ProxyEnable=$($sys.Enable) ProxyServer=$($sys.Server)"
Write-Host "Clash ${CLASH}    : $(if ($clashLive) { '在监听' } else { '未监听（B 轮会测到 0 条连接）' })"
Write-Host "我们的代理 ${OURS}: $(if ($oursLive) { '在监听 ✓' } else { '未监听' })"
Write-Host "死端口 ${DEAD}  : $(if (Test-PortLive $DEAD) { '⚠ 竟然在监听，换一个' } else { '确认无人监听 ✓' })"
Write-Host ''

# 前置校验：C 轮测的是"指定我们的代理"，17890 不监听的话这一轮等于在测死端口，
# 结论会完全无效（实测踩过一次：白跑一整轮还以为发现了异常）。
if (-not $oursLive -and ($Only -eq 'all' -or $Only -eq 'C')) {
    Write-Host '  ✗ 我们的代理 17890 没在监听，C 轮会退化成"测死端口"，结论无效。' -ForegroundColor Red
    Write-Host '    请先执行：.\codex-proxy.ps1 start     然后再跑本测试。' -ForegroundColor Red
    Write-Host '    （如果你只想跑 A/B/D/E，用 -Only A 之类指定单轮）' -ForegroundColor DarkGray
    exit 1
}

# ---------------------------------------------------------------- 交互：确认系统代理状态
function Wait-ProxyState {
    param(
        [string]$Phase,
        [int]$WantEnable,          # 1 = 要求开着，0 = 要求关着
        [string]$Why
    )
    $wantText = if ($WantEnable -eq 1) { '【开启】' } else { '【关闭】' }
    Write-Host ('=' * 72) -ForegroundColor Magenta
    Write-Host "  请把系统代理$wantText —— 第 $Phase 遍" -ForegroundColor Magenta
    Write-Host ('=' * 72) -ForegroundColor Magenta
    Write-Host "  为什么: $Why"
    Write-Host ''
    if ($WantEnable -eq 1) {
        Write-Host '  怎么开: 在 Clash Party 托盘菜单里打开「系统代理」开关' -ForegroundColor DarkGray
        Write-Host "          并确认 $CLASH 端口在监听（脚本会替你检查）" -ForegroundColor DarkGray
    } else {
        Write-Host '  怎么关: 在 Clash Party 托盘菜单里关闭「系统代理」开关' -ForegroundColor DarkGray
        Write-Host '          （关掉开关即可，不需要退出 Clash Party）' -ForegroundColor DarkGray
    }
    Write-Host ''

    if ($NonInteractive) {
        $cur = Get-SysProxy
        Write-Host "  -NonInteractive：不等确认，按当前状态（ProxyEnable=$($cur.Enable)）继续" -ForegroundColor DarkGray
        Write-Host ''
        return @{ Enable = $cur.Enable; Server = $cur.Server; Matched = ($cur.Enable -eq $WantEnable) }
    }

    for ($attempt = 1; $attempt -le 20; $attempt++) {
        $cur = Get-SysProxy
        $ok = ($cur.Enable -eq $WantEnable)
        $clashOk = if ($WantEnable -eq 1) { Test-PortLive $CLASH } else { $true }
        $mark = if ($ok) { '✓' } else { '✗' }
        Write-Host ("  当前: ProxyEnable=$($cur.Enable) ProxyServer=$($cur.Server)  $mark" +
            $(if ($WantEnable -eq 1) { "   Clash $CLASH 在监听: $(if ($clashOk) { '是 ✓' } else { '否 ✗' })" } else { '' }))
        if ($ok -and $clashOk) { Write-Host '  ✔ 状态正确，继续' -ForegroundColor Green; Write-Host ''; return @{ Enable = $cur.Enable; Server = $cur.Server; Matched = $true } }
        if ($ok -and -not $clashOk) {
            Write-Host "  ⚠ 系统代理已开，但 $CLASH 没人监听 —— 指向了死端口。" -ForegroundColor Red
            Write-Host '     这会让 A 轮结果无法解读（既不是纯直连，也不是走 Clash）。' -ForegroundColor Red
            Write-Host '     请启动 Clash Party（打开系统代理开关会自动带起内核）。' -ForegroundColor Red
        } else {
            Write-Host "  请$wantText系统代理，然后回车重新检查。" -ForegroundColor Yellow
        }
        Write-Host '  （输入 s 跳过等待，按当前状态继续；输入 q 退出）' -ForegroundColor DarkGray
        $ans = Read-Host '  回车=重新检查 / s=跳过 / q=退出'
        if ($ans -eq 'q') { Write-Host '  已退出。' -ForegroundColor DarkGray; exit 0 }
        if ($ans -eq 's') {
            Write-Host '  跳过等待，按当前状态继续（本次结果会标注为"状态不符"）。' -ForegroundColor Yellow
            Write-Host ''
            $cur2 = Get-SysProxy
            return @{ Enable = $cur2.Enable; Server = $cur2.Server; Matched = ($cur2.Enable -eq $WantEnable) }
        }
    }
    Write-Host '  重试次数用尽，按当前状态继续。' -ForegroundColor Yellow
    $cur3 = Get-SysProxy
    return @{ Enable = $cur3.Enable; Server = $cur3.Server; Matched = $false }
}

# ---------------------------------------------------------------- 被测量的两遍
function Stop-Codex {
    $ids = @(Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if ($ids.Count) { $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 5 }
    if ((@(Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue)).Count) {
        Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue |
            ForEach-Object { & powershell -NoProfile -NonInteractive -Command "Stop-Process -Id $($_.Id) -Force -ErrorAction SilentlyContinue" | Out-Null }
        Start-Sleep -Seconds 4
    }
    @(Get-Process -Name ChatGPT, Codex -ErrorAction SilentlyContinue).Count
}

function Run-Round($tag, $title, $extraArgs, $envProxy, $expect) {
    Write-Host ('=' * 72) -ForegroundColor Cyan
    Write-Host "  $tag. $title" -ForegroundColor Cyan
    Write-Host ('=' * 72) -ForegroundColor Cyan
    Write-Host "  参数    : $(if ($extraArgs) { $extraArgs -join ' ' } else { '(无)' })"
    Write-Host "  环境变量: $(if ($envProxy) { "HTTP(S)_PROXY=$envProxy" } else { '(无)' })"
    Write-Host "  预期    : $expect"

    Write-Host "  清理残留: $(Stop-Codex)"
    $dir = Join-Path $ROOT "run\exp-$tag"
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $DESKTOP
    foreach ($a in $extraArgs) { [void]$psi.ArgumentList.Add($a) }
    [void]$psi.ArgumentList.Add("--user-data-dir=$dir")
    [void]$psi.ArgumentList.Add('--no-first-run')
    $psi.UseShellExecute = $false
    if ($envProxy) {
        foreach ($k in 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY') { $psi.Environment[$k] = $envProxy }
        $psi.Environment['NO_PROXY'] = 'localhost,127.0.0.1,::1'
    }
    if ($CLI) { $psi.Environment['PATH'] = (Split-Path -Parent $CLI) + ';' + $env:PATH }
    [void][System.Diagnostics.Process]::Start($psi)

    $peak = @{}
    $pids = @{}
    for ($i = 1; $i -le [int]($WaitSec / 3); $i++) {
        Start-Sleep -Seconds 3
        $procs = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*exp-$tag*" })
        $ids = @($procs | Select-Object -ExpandProperty ProcessId)
        $ids | ForEach-Object { $pids[$_] = $true }
        if (-not $ids.Count) { Write-Host ("    {0,2}s (无进程)" -f ($i * 3)); continue }
        $g = @{}
        foreach ($p in $ids) {
            foreach ($c in (Get-NetTCPConnection -OwningProcess $p -State Established -ErrorAction SilentlyContinue)) {
                $isLoop = ($c.RemoteAddress -eq '127.0.0.1' -or $c.RemoteAddress -eq '::1')
                $k = if (-not $isLoop) { '直连外网' } elseif ($c.RemotePort -eq $OURS) { '我们的(17890)' } elseif ($c.RemotePort -eq $CLASH) { 'Clash(7890)' } elseif ($c.RemotePort -eq $DEAD) { "死端口($DEAD)" } else { "本机$($c.RemotePort)" }
                if (-not $g.ContainsKey($k)) { $g[$k] = 0 }
                $g[$k] = $g[$k] + 1
                if (-not $peak.ContainsKey($k)) { $peak[$k] = 0 }
                if ($g[$k] -gt $peak[$k]) { $peak[$k] = $g[$k] }
            }
        }
        Write-Host ("    {0,2}s 进程={1,-3} {2}" -f ($i * 3), $ids.Count, (($g.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '  '))
    }

    # user-data-dir 体积：完整界面 ≈ 90MB，只有壳 ≈ 15MB
    $sizeMB = 0
    if (Test-Path $dir) {
        $sizeMB = [math]::Round((Get-ChildItem $dir -Recurse -Force -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum / 1MB, 1)
    }
    Write-Host ''
    Write-Host "  --- $tag 轮结果 ---" -ForegroundColor Yellow
    if ($peak.Count) {
        foreach ($k in ($peak.Keys | Sort-Object)) {
            $color = if ($k -like '*直连*' -or $k -like '*Clash*') { 'Red' } else { 'Green' }
            Write-Host ("    [{0}] 峰值 {1} 条" -f $k, $peak[$k]) -ForegroundColor $color
        }
    } else { Write-Host '    (全程零连接)' -ForegroundColor Red }
    Write-Host ("    数据目录体积: {0} MB  ({1})" -f $sizeMB, $(if ($sizeMB -gt 50) { '界面资源已完整加载 → 主界面' } elseif ($sizeMB -gt 5) { '只有壳 → 停在登录页' } else { '几乎没写东西' }))
    Write-Host ''

    return [pscustomobject]@{ Tag = $tag; Title = $title; Peak = $peak; SizeMB = $sizeMB }
}

function Invoke-Scenario {
    param([string]$Phase, [hashtable]$ProxyState)

    Write-Host ('#' * 72) -ForegroundColor Magenta
    Write-Host ("#  第 $Phase 遍  ——  系统代理 " + $(if ($ProxyState.Enable -eq 1) { '【开启】' } else { '【关闭】' }) +
        $(if ($ProxyState.Matched) { '' } else { '（⚠ 实际状态与要求不符）' })) -ForegroundColor Magenta
    Write-Host ('#' * 72) -ForegroundColor Magenta
    Write-Host ''

    $out = @()
    if ($Only -in 'all', 'A') { $out += Run-Round "A$Phase" '直连（不给参数、不给环境变量）' @() $null $(if ($ProxyState.Enable -eq 1) { '走系统代理（部分 Clash + 部分直连）' } else { '纯直连外网，国内网络下会卡在连接页' }) }
    if ($Only -in 'all', 'B') { $out += Run-Round "B$Phase" "指定 Clash $CLASH" @("--proxy-server=127.0.0.1:$CLASH") $null "全部走 $CLASH" }
    if ($Only -in 'all', 'C') { $out += Run-Round "C$Phase" "指定我们的 $OURS" @("--proxy-server=127.0.0.1:$OURS") $null '全部走 17890，零直连、零走 Clash' }
    if ($Only -in 'all', 'D') { $out += Run-Round "D$Phase" "指定死端口 $DEAD" @("--proxy-server=127.0.0.1:$DEAD") $null '零连接（代理不可用 → 卡在登录页）' }
    if ($Only -in 'all', 'E') { $out += Run-Round "E$Phase" '无参数 + 环境变量指向我们的' @() "http://127.0.0.1:$OURS" '走直连（证明 Chromium 不读环境变量）' }
    return $out
}

# ---------------------------------------------------------------- 主流程
$states = @()

if ($Only -eq 'all' -and -not $NonInteractive) {
    # 交互式双跑：先关系统代理，再开
    $s1 = Wait-ProxyState -Phase 1 -WantEnable 0 -Why '要证明"系统代理关着时它直连"（A 轮结论取决于这个状态）'
    $states += [pscustomobject]@{ Phase = 1; State = $s1 }
    $r1 = Invoke-Scenario -Phase 1 -ProxyState $s1

    $s2 = Wait-ProxyState -Phase 2 -WantEnable 1 -Why '要证明"不给参数时它读系统代理"（A 轮会变成部分走 Clash）'
    $states += [pscustomobject]@{ Phase = 2; State = $s2 }
    $r2 = Invoke-Scenario -Phase 2 -ProxyState $s2

    $rounds = @($r1) + @($r2)
} else {
    # 单轮模式 / 非交互：按当前状态跑一遍
    if ($sys.Enable -eq 1 -and -not $clashLive -and ($Only -eq 'all' -or $Only -eq 'A')) {
        Write-Host "  ⚠ 警告：系统代理开着但 $CLASH 没人监听 —— 系统代理指向了一个死端口。" -ForegroundColor Red
        Write-Host "     这会让 A 轮的结果难以解读（既不是纯直连，也不是走 Clash）。" -ForegroundColor Red
        Write-Host "     建议：要么打开 Clash，要么把系统代理关掉，再跑本测试。" -ForegroundColor Red
        Write-Host ''
    }
    $s = @{ Enable = $sys.Enable; Server = $sys.Server; Matched = $true }
    $states += [pscustomobject]@{ Phase = 0; State = $s }
    $rounds = Invoke-Scenario -Phase 0 -ProxyState $s
}

# ---------------------------------------------------------------- 汇总
Write-Host ('=' * 72) -ForegroundColor Yellow
Write-Host '  汇总' -ForegroundColor Yellow
Write-Host ('=' * 72) -ForegroundColor Yellow
foreach ($st in $states) {
    Write-Host ("  第 $($st.Phase) 遍的系统代理状态: ProxyEnable=$($st.State.Enable) ProxyServer=$($st.State.Server)" +
        $(if ($st.State.Matched) { '' } else { '  ⚠ 与要求不符，该遍结论仅供参考' })) -ForegroundColor DarkGray
}
foreach ($r in $rounds) {
    $conn = if ($r.Peak.Count) { ($r.Peak.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join '  ' } else { '(零连接)' }
    Write-Host ''
    Write-Host ("  [$($r.Tag)] $($r.Title)") -ForegroundColor Yellow
    Write-Host ("      连接: $conn")
    Write-Host ("      体积: $($r.SizeMB) MB")
}

# ---- 双跑时给出并排对比与判读
#
# ★ 判读规则（这里早期写错过，务必看清）★
#
#   第一版规则是"C/D/E 两遍应完全一致"，结果实测报了假警：
#     [C] 关代理: 我们的(17890)=22   开代理: 我们的(17890)=54   ← 被判成"不同，请检查"
#   但这两遍的【去向完全一样，都是 17890】，差别只在【数量】。
#   数量为什么不同？因为第 1 遍界面没加载全（数据目录 41.7MB），第 2 遍加载了主界面
#   （53.2MB）—— 界面走得越远，连接自然越多。**数量不是判据，去向才是。**
#
#   还错了一条：E 轮被归进"与系统代理无关"那一类，但 E 是【无参数】启动，
#   Chromium 本来就跟随系统代理，所以两遍【本来就该不同】。
#   E 真正要证明的是"环境变量对界面无效"，判据是：**两遍都不出现 17890**。
#
#   所以正确的判读是：
#     A / B        —— 去向应【随】系统代理变化
#     C / D        —— 去向应【不随】系统代理变化（两遍去向相同）
#     E            —— 去向本就随系统代理变化；关键是绝不能出现 17890
#
#   另外用"去向集合"而不是"完整字符串"来判断 —— 数量差异不该影响结论。
if ($states.Count -ge 2) {
    Write-Host ''
    Write-Host '  --- 两遍并排对比（判据是【流量去向】，不是连接条数）---' -ForegroundColor Cyan
    Write-Host '      说明：连接条数会随"界面加载到哪一步"变化（停在登录页 vs 主界面），' -ForegroundColor DarkGray
    Write-Host '            所以条数不同不代表行为不同；关键看【走到了哪个端口】。' -ForegroundColor DarkGray
    Write-Host ''

    # 把连接分布格式化成字符串。注意：必须 select -First 1 把 Where-Object 的结果
    # 收成【单个对象】—— 直接比较集合会退化成数组比较，判断全乱。
    function Get-ConnText($round) {
        if ($null -eq $round) { return $null }
        if (-not $round.Peak -or $round.Peak.Count -eq 0) { return '零连接' }
        return (($round.Peak.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')
    }
    # 只要"去了哪些地方"（丢掉条数）
    function Get-DestSet($round) {
        if ($null -eq $round -or -not $round.Peak -or $round.Peak.Count -eq 0) { return @() }
        return @($round.Peak.Keys | Sort-Object)
    }
    function Test-WentTo($round, $port) {
        $d = Get-DestSet $round
        return [bool]($d | Where-Object { $_ -like "*($port)*" })
    }

    foreach ($tag in 'A', 'B', 'C', 'D', 'E') {
        $r1 = @($rounds | Where-Object { $_.Tag -eq "${tag}1" }) | Select-Object -First 1
        $r2 = @($rounds | Where-Object { $_.Tag -eq "${tag}2" }) | Select-Object -First 1
        if (-not $r1 -or -not $r2) { continue }
        $c1 = Get-ConnText $r1
        $c2 = Get-ConnText $r2
        $d1 = Get-DestSet $r1
        $d2 = Get-DestSet $r2
        # 去向是否相同（比较"去了哪些地方"，不比条数）
        $sameDest = (($d1 -join '|') -eq ($d2 -join '|'))

        $verdict = ''
        $hint = ''
        switch ($tag) {
            'A' {
                if ($sameDest) { $verdict = '⚠ 去向两遍相同 —— A 轮不给参数，本应跟随系统代理而变化，请确认系统代理真的切换了' }
                else { $verdict = '✓ 去向随系统代理变化（符合预期：不给参数时它读系统代理）' }
            }
            'B' {
                if ($sameDest) { $verdict = '⚠ 去向两遍相同 —— B 轮指定了 7890，本应两遍都走 7890；若关代理那遍是零连接，属正常（7890 没人监听）' }
                else { $verdict = '✓ 去向随系统代理变化（符合预期：关代理时 7890 没人监听 → 零连接）' }
            }
            'C' {
                if ($sameDest -and (Test-WentTo $r1 $OURS) -and -not (Test-WentTo $r1 $CLASH)) {
                    $verdict = "✓ 两遍去向相同且都只走 $OURS（符合预期：给参数时与系统代理无关，零直连零走 Clash）"
                } elseif (-not (Test-WentTo $r1 $OURS)) {
                    $verdict = "⚠ 关代理那遍没走 $OURS —— 这一轮的目的就是验证指定我们的代理能生效，请检查"
                } elseif (Test-WentTo $r1 $CLASH) {
                    $verdict = "⚠ 出现了走 Clash($CLASH) 的连接 —— 指定我们的代理时不应有，请检查"
                } else {
                    $verdict = '⚠ 两遍去向不同，请人工核对上面两行'
                }
            }
            'D' {
                if (-not $d1.Count -and -not $d2.Count) {
                    $verdict = "✓ 两遍都零连接（符合预期：死端口 $DEAD 不可用 → 卡在登录页）"
                } else {
                    $verdict = "⚠ 死端口那轮出现了连接 —— 有东西绕过了 --proxy-server，请检查"
                }
            }
            'E' {
                $e1ours = Test-WentTo $r1 $OURS
                $e2ours = Test-WentTo $r2 $OURS
                if ($e1ours -or $e2ours) {
                    $verdict = "⚠ 出现了走 $OURS 的连接 —— 但 E 轮没有给 --proxy-server，说明环境变量被界面读了（与预期相反，请检查）"
                } elseif ($sameDest) {
                    $verdict = '✓ 两遍去向相同且都没走我们的代理（环境变量对界面无效）'
                } else {
                    $verdict = '✓ 两遍都没走我们的代理（环境变量对界面无效）；去向随系统代理变化属预期（无参数时跟随系统代理）'
                }
            }
        }
        Write-Host ("    [$tag] 关系统代理: $c1")
        Write-Host ("         开系统代理: $c2")
        $vc = if ($verdict.StartsWith('✓')) { 'Green' } else { 'Yellow' }
        Write-Host "         $verdict" -ForegroundColor $vc
    }
}

Write-Host ''
Write-Host "  清理: $(Stop-Codex) 个残留进程"
Get-ChildItem (Join-Path $ROOT 'run') -Directory -Filter 'exp-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host ''
Write-Host '  恢复使用: .\codex-proxy.ps1 app' -ForegroundColor DarkGray
Write-Host '  期望结论: C 轮全部走 17890 且直连=0 走Clash=0；E 轮走直连（证明环境变量对界面无效）；' -ForegroundColor DarkGray
Write-Host '            A/B 两轮随系统代理状态变化，C/D/E 两遍完全一致' -ForegroundColor DarkGray
