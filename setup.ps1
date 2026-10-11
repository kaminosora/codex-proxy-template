# ============================================================================
#  setup.ps1 — 初次运行的交互式配置引导
#
#  克隆这个仓库之后跑一次，它会一步步问你、把配置填好、把缺的程序下齐、
#  最后真的验证一遍能不能用。
#
#      .\setup.ps1                 # 交互式（推荐）
#      .\setup.ps1 -Check          # 只体检，不改任何东西
#      .\setup.ps1 -SkipBinaries   # 跳过二进制下载
#      .\setup.ps1 -Yes            # 尽量不问（仅用于已经填好的情况）
#
#  设计原则：
#    · 每一步都解释"这是什么、去哪拿、填错会怎样"
#    · 能自动检测的都先自动检测（不要让你白填）
#    · 每个值当场校验格式，不合规立刻说清哪里不对
#    · 最后一定跑一次真实验证，不许"填完就说成功"
# ============================================================================
param(
    [switch]$Check,
    [switch]$SkipBinaries,
    [switch]$Yes
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$ROOT       = $PSScriptRoot
$CONFIG     = Join-Path $ROOT 'codex-proxy.config.json'
$ENTRY      = Join-Path $ROOT 'codex-proxy.ps1'

# ---------------------------------------------------------------- 输出helpers
function Step($n, $t) {
    Write-Host ''
    Write-Host ('─' * 66) -ForegroundColor DarkGray
    Write-Host "  第 $n 步 · $t" -ForegroundColor Cyan
    Write-Host ('─' * 66) -ForegroundColor DarkGray
}
function Ok($t)    { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Bad($t)   { Write-Host "  [失败] $t" -ForegroundColor Red }
function Warn2($t) { Write-Host "  [注意] $t" -ForegroundColor Yellow }
function Note($t)  { Write-Host "  $t" -ForegroundColor DarkGray }
function Ask($q)   { Write-Host ''; Write-Host "  ? $q" -ForegroundColor White }

# 读一行（允许直接回车取默认）
function Read-Value {
    param([string]$Prompt, [string]$Default = '')
    $hint = if ($Default) { " [回车 = $Default]" } else { '' }
    Write-Host -NoNewline "    > $Prompt$hint : " -ForegroundColor Yellow
    $v = Read-Host
    if (-not $v -and $Default) { return $Default }
    return $v
}
function Read-YesNo {
    param([string]$Prompt, [bool]$Default = $true)
    $d = if ($Default) { 'Y/n' } else { 'y/N' }
    Write-Host -NoNewline "    > $Prompt [$d] : " -ForegroundColor Yellow
    $v = Read-Host
    if (-not $v) { return $Default }
    return ($v -match '^[yY]')
}

# ---------------------------------------------------------------- 占位符
# 与 make-template.ps1 的映射表对应。这里只负责"找出还没填的"。
$PLACEHOLDERS = @(
    'YOUR_SERVER_IP',
    'REPLACE_WITH_YOUR_REALITY_PUBLIC_KEY',
    'REPLACE_WITH_YOUR_SHORT_ID',
    'id_ed25519_your_server',
    'YOUR_NAME',
    '00000000-0000-0000-0000-000000000000',
    'C:\codex-proxy'
)

function Get-Config { return Get-Content -LiteralPath $CONFIG -Raw | ConvertFrom-Json }
function Save-Config($cfg) {
    # 保持 2 空格缩进，和原文件一致；用 .NET 直接写（避免 Set-Content 的各种坑）
    $json = $cfg | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($CONFIG, $json)
}

function Get-PendingPlaceholders {
    $txt = Get-Content -LiteralPath $CONFIG -Raw
    $found = @()
    foreach ($p in $PLACEHOLDERS) { if ($txt.Contains($p)) { $found += $p } }
    return $found
}

# ---------------------------------------------------------------- 开场
Write-Host ''
Write-Host '======================================================================' -ForegroundColor Yellow
Write-Host '  Codex 专用代理 · 初次运行配置引导' -ForegroundColor Yellow
Write-Host '======================================================================' -ForegroundColor Yellow
Note "项目目录: $ROOT"
if ($Check) { Warn2 '当前是 -Check 模式：只体检，不改任何东西' }

# ================================================================ 0. 环境
Step 0 '环境检查（PowerShell / Node.js / 文件是否齐全）'
$envOk = $true

$psv = $PSVersionTable.PSVersion
if ($psv.Major -ge 7) { Ok "PowerShell $psv" }
else { Bad "PowerShell $psv —— 建议用 pwsh 7（Windows PowerShell 5.1 可能缺东西）"; $envOk = $false }

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if ($nodeExe) {
    $nv = (& node --version 2>&1) -join ''
    if ($nv -match 'v(\d+)' -and [int]$Matches[1] -ge 18) { Ok "Node.js $nv（$nodeExe）" }
    else { Bad "Node.js $nv 版本过低 —— 需要 18+（用到 ESM 与 fetch）"; $envOk = $false }
} else {
    Bad '找不到 node —— 请先装 Node.js 18+：https://nodejs.org/'
    $envOk = $false
}

foreach ($f in 'codex-proxy.mjs', 'codex-proxy.ps1', 'codex-proxy.config.json') {
    if (Test-Path -LiteralPath (Join-Path $ROOT $f)) { Ok "存在 $f" }
    else { Bad "缺少 $f —— 仓库不完整？"; $envOk = $false }
}

if (-not $envOk) {
    Write-Host ''
    Bad '环境检查没过，先把上面的问题解决再跑本引导。'
    exit 1
}

# ================================================================ 1. 现状
Step 1 '当前配置状态'

$cfg = Get-Config
$pending = Get-PendingPlaceholders
$sshId = $cfg.uplinks.ssh.identityFile

if ($pending.Count -eq 0) {
    Ok '配置里没有未填的占位符'
} else {
    Warn2 "还有 $($pending.Count) 个占位符没填："
    foreach ($p in $pending) { Note "      · $p" }
}
Note ''
Note "  SSH 出口     : enabled=$($cfg.uplinks.ssh.enabled)  host=$($cfg.uplinks.ssh.host)"
Note "  xray 出口    : enabled=$($cfg.uplinks.xray.enabled)  server=$($cfg.uplinks.xray.server)"
Note "  机场回落     : enabled=$($cfg.uplinks.clashParty.enabled)  dataDir=$($cfg.uplinks.clashParty.dataDir)"
Note ''
Note '  bin\ 里的外部程序：'
foreach ($b in 'xray.exe', 'codex-core.exe') {
    $p = Join-Path $ROOT "bin\$b"
    if (Test-Path -LiteralPath $p) { Ok "    $b（$([math]::Round((Get-Item -LiteralPath $p).Length/1MB,1)) MB）" }
    else { Warn2 "    缺 $b" }
}

if ($Check) {
    Write-Host ''
    Write-Host '  --- 体检结束（-Check 模式，未做任何修改）---' -ForegroundColor DarkGray
    if ($pending.Count) { Note '要开始配置，去掉 -Check 再跑一次：.\setup.ps1' }
    exit 0
}

# ================================================================ 2. 选出口
Step 2 '你要用哪几个出口？'
Write-Host ''
Write-Host '  三个出口的定位（可以只要一部分）：' -ForegroundColor Gray
Write-Host '    1. ssh:jp      用 ssh -D 动态转发到你的服务器。**服务器不需要任何改动**，' -ForegroundColor Gray
Write-Host '                   只要有 SSH 账号 + 你的公钥。最省事，建议留着。' -ForegroundColor Gray
Write-Host '    2. xray:jp     走服务器 443 上的 VLESS+REALITY。需要服务器已配好那个入站。' -ForegroundColor Gray
Write-Host '                   抗干扰更好，但配置项多（UUID / 公钥 / shortId）。' -ForegroundColor Gray
Write-Host '    3. clash-party 机场节点回落（独立 mihomo 实例）。需要本机装着 Clash Party' -ForegroundColor Gray
Write-Host '                   并且它至少运行过一次（这样才有订阅文件）。' -ForegroundColor Gray

if (-not $Yes) {
    Ask '你打算用哪些出口？（只填数字，例如 1 或 1,2 或 1,2,3）'
    Note "  当前设置：ssh=$($cfg.uplinks.ssh.enabled) xray=$($cfg.uplinks.xray.enabled) clash=$($cfg.uplinks.clashParty.enabled)"
    $pick = Read-Value '选择' (@('1','2','3') | Where-Object {
        ($_ -eq '1' -and $cfg.uplinks.ssh.enabled) -or
        ($_ -eq '2' -and $cfg.uplinks.xray.enabled) -or
        ($_ -eq '3' -and $cfg.uplinks.clashParty.enabled) } ) -join ','
    $useSsh  = $pick -match '1'
    $useXray = $pick -match '2'
    $useClash = $pick -match '3'
} else {
    $useSsh = $cfg.uplinks.ssh.enabled
    $useXray = $cfg.uplinks.xray.enabled
    $useClash = $cfg.uplinks.clashParty.enabled
}
if (-not ($useSsh -or $useXray -or $useClash)) {
    Bad '一个出口都没选 —— 那样没有出口可用，桥接会直接拒绝连接。'
    Note '至少要留一个。重跑本引导重新选。'
    exit 1
}
$cfg.uplinks.ssh.enabled = [bool]$useSsh
$cfg.uplinks.xray.enabled = [bool]$useXray
$cfg.uplinks.clashParty.enabled = [bool]$useClash
Ok "将启用：$(if ($useSsh) { 'ssh:jp ' })$(if ($useXray) { 'xray:jp ' })$(if ($useClash) { 'clash-party' })"

# ================================================================ 3. 服务器
$serverIp = ''
if ($useSsh -or $useXray) {
    Step 3 '你的服务器地址'
    Write-Host ''
    Write-Host '  这是你 VPS 的公网 IP（IPv4）。ssh:jp 与 xray:jp 都连它。' -ForegroundColor Gray
    Write-Host '  在服务器上执行 `curl -4 ifconfig.me` 就能看到，或者问你买 VPS 的地方。' -ForegroundColor Gray

    $cur = $cfg.uplinks.ssh.host
    if ($cur -and $cur -notmatch '^YOUR_') { Note "  当前值: $cur" }
    while ($true) {
        $serverIp = Read-Value '服务器公网 IPv4' ($(if ($cur -match '^\d+\.\d+\.\d+\.\d+$') { $cur } else { '' }))
        if ($serverIp -match '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$' -and
            ($serverIp -split '\.' | Where-Object { [int]$_ -gt 255 }).Count -eq 0) {
            Ok "服务器: $serverIp"
            break
        }
        Bad "「$serverIp」不是合法的 IPv4，例如 203.0.113.10。再试一次（Ctrl+C 可退出）"
    }
    $cfg.uplinks.ssh.host = $serverIp
    $cfg.uplinks.xray.server = $serverIp
}

# ================================================================ 4. SSH
if ($useSsh) {
    Step 4 'SSH 出口（私钥）'
    Write-Host ''
    Write-Host '  服务器上要做的只有一件事：把你的**公钥**加到 ~/.ssh/authorized_keys。' -ForegroundColor Gray
    Write-Host '  （本机不需要跑 ssh-agent —— 脚本会直接用私钥文件认证）' -ForegroundColor Gray
    Write-Host ''
    Write-Host '  私钥文件放在 %USERPROFILE%\.ssh\ 下。常见的名字：' -ForegroundColor Gray
    Write-Host '      id_ed25519     id_rsa     id_ed25519_your_server' -ForegroundColor DarkGray

    $sshDir = Join-Path $env:USERPROFILE '.ssh'
    $found = @()
    if (Test-Path -LiteralPath $sshDir) {
        $found = @(Get-ChildItem -LiteralPath $sshDir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notlike '*.pub' -and $_.Name -notin 'known_hosts', 'known_hosts.old', 'config', 'agent.env' -and $_.Extension -ne '.txt' } |
            ForEach-Object { $_.Name })
    }
    if ($found.Count) {
        Ok "在 $sshDir 找到这些私钥：$($found -join '、')"
    } else {
        Warn2 "$sshDir 下没找到私钥文件"
    }

    $curId = $cfg.uplinks.ssh.identityFile
    if ($curId -and $curId -notmatch 'YOUR_NAME|id_ed25519_your_server') { Note "  当前值: $curId" }

    while ($true) {
        $name = Read-Value '私钥文件名' ($(if ($found.Count -eq 1) { $found[0] } elseif ($found -contains 'id_ed25519') { 'id_ed25519' } else { '' }))
        if (-not $name) { Bad '必须给个文件名'; continue }
        $full = if ($name -match '[\\/]') { $name } else { Join-Path $sshDir $name }
        if (Test-Path -LiteralPath $full) {
            $cfg.uplinks.ssh.identityFile = $full
            Ok "私钥: $full"
            break
        }
        Bad "找不到「$full」"
        if ($found.Count) { Note "    这个目录下有的是：$($found -join '、')" }
        Note '    想用别的路径就直接写完整路径（可以是 .\ 开头的相对路径）'
    }

    # 顺手验证能不能连（不依赖 ssh-agent）
    Write-Host ''
    Note '  正在测试能否用这个私钥连上服务器（不经过 ssh-agent）…'
    $test = & ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new `
        -i $cfg.uplinks.ssh.identityFile "$($cfg.uplinks.ssh.user)@$serverIp" "echo SSH_OK" 2>&1
    if (($test -join ' ') -match 'SSH_OK') {
        Ok 'SSH 连通性验证通过'
    } else {
        Warn2 '这次没连上（不影响保存配置）。原因通常是：'
        Note '      · 公钥还没加到服务器的 ~/.ssh/authorized_keys'
        Note '      · 服务器 IP 或用户名不对（当前用户名：' + $cfg.uplinks.ssh.user + '）'
        Note '      · 本机防火墙/网络问题'
        Note "    实际报错：" + (($test | Select-Object -First 2) -join ' | ')
        if (-not $Yes) {
            Ask '要现在重试一次吗？'
            if (Read-YesNo '重试' $false) {
                $test2 = & ssh -o BatchMode=yes -o ConnectTimeout=8 -i $cfg.uplinks.ssh.identityFile `
                    "$($cfg.uplinks.ssh.user)@$serverIp" "echo SSH_OK" 2>&1
                if (($test2 -join ' ') -match 'SSH_OK') { Ok '这次通过了' }
                else { Warn2 '还是不通 —— 先继续，配置存下来后你可以用 status 再看' }
            }
        }
    }
}

# ================================================================ 5. xray
if ($useXray) {
    Step 5 'xray 出口（UUID / REALITY 公钥 / shortId）'
    Write-Host ''
    Write-Host '  这三个值从**服务器上的 xray 配置**里拿。在服务器上执行：' -ForegroundColor Gray
    Write-Host ''
    Write-Host '    # UUID（clients 那一段的 id）' -ForegroundColor DarkGray
    Write-Host '    grep -A3 ''"clients"'' /usr/local/etc/xray/config.json' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '    # 公钥 / shortId（把 <私钥> 换成配置里的 privateKey）' -ForegroundColor DarkGray
    Write-Host '    xray x25519 -i "<私钥>"' -ForegroundColor DarkGray
    Write-Host '    grep -A5 ''shortIds'' /usr/local/etc/xray/config.json' -ForegroundColor DarkGray
    Write-Host ''
    Warn2 '最容易错的一点：要填的是【公钥】不是私钥。'
    Note '    填成私钥时 xray 会报 received real certificate (potential MITM or redirection)。'
    Note '    xray x25519 -i "<私钥>" 的输出里，Password (PublicKey) 那一行才是要填的。'
    Note ''
    Note '    另外字段名在新老 Xray 里不同：26.x 叫 password，旧版叫 publicKey。'
    Note '    本项目两个都读，所以填哪个位置都行。'

    # UUID
    while ($true) {
        $curU = $cfg.uplinks.xray.uuid
        $dflt = if ($curU -match '^[0-9a-fA-F-]{36}$' -and $curU -notmatch '^0{8}-') { $curU } else { '' }
        $u = Read-Value 'UUID' $dflt
        if ($u -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -and $u -notmatch '^0{8}-') {
            $cfg.uplinks.xray.uuid = $u; Ok "UUID: $u"; break
        }
        Bad "「$u」不像标准 UUID（形如 1234abcd-12ab-34cd-56ef-1234567890ab）"
    }

    # 公钥
    while ($true) {
        $curK = $cfg.uplinks.xray.password
        $dflt = if ($curK -and $curK -notmatch 'REPLACE_WITH') { $curK } else { '' }
        $k = Read-Value 'REALITY 公钥' $dflt
        if ($k -match '^[A-Za-z0-9_+/=-]{40,50}$' -and $k -notmatch 'REPLACE_WITH') {
            $cfg.uplinks.xray.password = $k
            # 两个字段名都写上，兼容新老 Xray
            $cfg.uplinks.xray | Add-Member -NotePropertyName publicKey -NotePropertyValue $k -Force
            Ok 'REALITY 公钥已记录（password 与 publicKey 两个字段都写了，兼容新老 Xray）'
            break
        }
        Bad '公钥应该是 43~44 个字符的 base64url 串（含 - 和 _）'
        Note '    提示：xray x25519 -i "<私钥>" 输出里的 Password (PublicKey)'
    }

    # shortId
    $curS = $cfg.uplinks.xray.shortId
    $dflt = if ($curS -and $curS -notmatch 'REPLACE_WITH') { $curS } else { '' }
    $s = Read-Value 'shortId（服务器 shortIds 里的一个；不知道就回车，多数配置是空串或 16 位十六进制）' $dflt
    if ($s -match '^[0-9a-fA-F]{0,16}$') { $cfg.uplinks.xray.shortId = $s; Ok "shortId: $(if ($s) { $s } else { '(空)' })" }
    else { Warn2 "「$s」不是 16 位以内的十六进制 —— 已照样保存，若连不上再回来改" ; $cfg.uplinks.xray.shortId = $s }

    Note ''
    Note "  另外这两个字段通常不用改（服务器上的 REALITY 目标）："
    Note "    dest / sni = $($cfg.uplinks.xray.sni)"
}

# ================================================================ 6. 机场回落
if ($useClash) {
    Step 6 '机场回落出口（Clash Party 数据目录）'
    Write-Host ''
    Write-Host '  这个出口**只读** Clash Party 的订阅文件，不会改它任何东西。' -ForegroundColor Gray
    Write-Host '  前提：本机装着 Clash Party，并且**至少启动过一次**（这样才有 profile.yaml / profiles\*.yaml）。' -ForegroundColor Gray

    $guess = Join-Path $env:APPDATA 'mihomo-party'
    while ($true) {
        $curD = $cfg.uplinks.clashParty.dataDir
        $dflt = if ($curD -and $curD -notmatch 'YOUR_NAME') { $curD } else { $guess }
        $d = Read-Value 'Clash Party 数据目录' $dflt
        if (-not (Test-Path -LiteralPath $d)) {
            Bad "目录不存在：$d"
            Note "    默认位置是 $guess"
            if (-not $Yes) { Ask '要放弃这个出口吗？'; if (Read-YesNo '放弃（改用别的出口）' $false) { $cfg.uplinks.clashParty.enabled = $false; Warn2 '已关闭 clash-party 出口'; break } }
            continue
        }
        $cfg.uplinks.clashParty.dataDir = $d
        # 找订阅
        $prof = Join-Path $d 'profiles'
        $subs = @()
        if (Test-Path -LiteralPath $prof) { $subs = @(Get-ChildItem -LiteralPath $prof -Filter '*.yaml' -File -ErrorAction SilentlyContinue) }
        if ($subs.Count) {
            Ok "数据目录: $d（$($subs.Count) 个订阅文件）"
            break
        }
        Warn2 "目录存在，但 profiles\ 下没有 .yaml 订阅文件"
        Note '    多半是 Clash Party 还没成功拉到订阅 —— 打开它跑一次再回来。'
        if ($Yes) { break }
        Ask '要继续（先留着，之后补）还是放弃这个出口？'
        if (Read-YesNo '放弃这个出口' $false) { $cfg.uplinks.clashParty.enabled = $false; Warn2 '已关闭 clash-party 出口'; break }
        Note '    好的，先留着，继续。'
        break
    }
}

# ================================================================ 7. 保存
Step 7 '保存配置'
Save-Config $cfg
$left = Get-PendingPlaceholders
if ($left.Count -eq 0) { Ok '配置已保存，占位符全部填完' }
else { Warn2 "配置已保存，但还剩 $($left.Count) 个占位符：$($left -join '、')" ; Note '    （多半来自你没启用的出口，或文档里的示例路径 —— 不影响使用）' }

# ================================================================ 8. 二进制
if (-not $SkipBinaries) {
    Step 8 '补齐外部程序（mihomo 内核 / xray）'
    $needXray = $cfg.uplinks.xray.enabled -and -not (Test-Path -LiteralPath (Join-Path $ROOT 'bin\xray.exe'))
    $needCore = $cfg.uplinks.clashParty.enabled -and -not (Test-Path -LiteralPath (Join-Path $ROOT 'bin\codex-core.exe'))
    if (-not $needXray -and -not $needCore) {
        Ok '需要的程序都在，跳过'
    } else {
        Note "  缺：$(if ($needXray) { 'xray.exe ' })$(if ($needCore) { 'codex-core.exe' })"
        Note '  正在跑 bin\fetch-binaries.ps1（会从 Clash Party 复制内核，或从官方 GitHub 下载）'
        Write-Host ''
        & pwsh -NoProfile -File (Join-Path $ROOT 'bin\fetch-binaries.ps1')
    }
}

# ================================================================ 9. 验证
Step 9 '真实验证（起一遍，看看通不通）'
if (-not $Yes) {
    Ask '要现在启动并验证吗？（它会起守护进程、跑一次出口 IP 检查）'
    if (-not (Read-YesNo '开始验证' $true)) {
        Note '  跳过验证。你随时可以自己跑：'
        Note '    .\codex-proxy.ps1 start'
        Note '    .\codex-proxy.ps1 check'
        exit 0
    }
}

Write-Host ''
Note '  启动守护进程（三个出口全启要 10~20 秒）…'
& pwsh -NoProfile -File $ENTRY start 2>&1 | ForEach-Object { Write-Host "    $_" }

# ★ 等它真的就绪，而不是死等固定秒数 ★
#   踩过：原来只 Start-Sleep 4 秒就查 status，三出口还没全启完，
#   于是显示"状态：未运行" —— 假失败，而后面 check 明明是通的（说明它活着）。
#   改成轮询就绪标志：端口在听 + 状态文件说正在运行。
function Test-DaemonReady {
    $live = [bool](netstat -ano | Select-String 'LISTENING' | Select-String ':17890\b')
    if (-not $live) { return $false }
    $out = & pwsh -NoProfile -File $ENTRY status 2>&1
    return [bool](($out -join ' ') -match '状态：运行中')
}
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 750
    if (Test-DaemonReady) { $ready = $true; break }
}
if ($ready) { Ok '守护进程已就绪' }
else { Warn2 '守护进程还没报就绪（可能三个出口都还没起来）—— 下面照常看结果' }

Write-Host ''
Note '  各出口健康度：'
& pwsh -NoProfile -File $ENTRY status 2>&1 | Select-Object -First 12 | ForEach-Object { Write-Host "    $_" }

Write-Host ''
Note '  实测出口 IP：'
$chk = & pwsh -NoProfile -File $ENTRY check 2>&1
$chk | Select-Object -First 12 | ForEach-Object { Write-Host "    $_" }

$ipLine = ($chk | Select-String 'ipify|出口 IP') -join ' '
Write-Host ''
if ($ipLine -match '(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})') {
    $got = $Matches[1]
    if ($serverIp -and $got -eq $serverIp) {
        Ok "出口 IP = $got（就是你服务器的 IP）—— 配置成功"
    } else {
        Warn2 "出口 IP = $got"
        Note "    这和你的服务器 IP（$serverIp）不同 —— 说明当前用的是别的出口（例如机场回落），"
        Note '    或者 ssh/xray 没连上。用 .\codex-proxy.ps1 status 看哪条 DOWN，再按 logs\ 里的日志排查。'
    }
} else {
    Warn2 '没能从 check 输出里读到出口 IP —— 手动看一眼上面的输出。'
}

# ================================================================ 收尾
Write-Host ''
Write-Host '======================================================================' -ForegroundColor Yellow
Write-Host '  完成' -ForegroundColor Yellow
Write-Host '======================================================================' -ForegroundColor Yellow
Write-Host ''
Write-Host '  日常使用：' -ForegroundColor Gray
Write-Host '    .\codex-proxy.ps1 app        起代理 + 带代理启动 Codex 桌面版' -ForegroundColor Gray
Write-Host '    .\codex-proxy.ps1 cli        在当前终端用 codex 命令行版' -ForegroundColor Gray
Write-Host '    .\codex-proxy.ps1 down       全部关掉' -ForegroundColor Gray
Write-Host ''
Write-Host '  出问题看：' -ForegroundColor Gray
Write-Host '    .\codex-proxy.ps1 status     各出口健康度与延迟' -ForegroundColor Gray
Write-Host '    .\codex-proxy.ps1 logs       最近日志' -ForegroundColor Gray
Write-Host '    故障排查与说明.md 第一节     速查表（按现象查）' -ForegroundColor Gray
Write-Host ''
Write-Host '  想重新配置：重跑 .\setup.ps1（它会读当前值当默认，不用全部重填）' -ForegroundColor DarkGray
Write-Host ''
