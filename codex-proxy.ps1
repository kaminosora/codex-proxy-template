#Requires -Version 5.1
<#
.SYNOPSIS
    Codex 专用代理开关 —— 只让 Codex 走日本服务器，其它应用完全不受影响。

.DESCRIPTION
    本脚本不会修改系统代理设置（Windows 的"Internet 选项 → 代理"保持你原来的状态），
    也不会碰正在运行的 Clash Party。它只做两件事：
      1. 起一个本地代理 127.0.0.1:17890（挂在 SSH 隧道 / xray / Clash Party 节点上）；
      2. 用环境变量把 Codex 这一个进程指到这个本地代理。

.EXAMPLE
    .\codex-proxy.ps1 start          启动守护进程
    .\codex-proxy.ps1 app            重启 Codex 桌面应用并挂上代理
    .\codex-proxy.ps1 cli            在挂好代理的终端里跑 codex CLI
    .\codex-proxy.ps1 check          实测出口 IP（应为你日本服务器的 IP）
    .\codex-proxy.ps1 status         查看各出口健康状态
    .\codex-proxy.ps1 conns          看每条活动连接走哪个出口（多路径并行的证据）
    .\codex-proxy.ps1 speed          实测三个出口的真实延迟与下载速度
    .\codex-proxy.ps1 best           立刻切到实测延迟最低的出口
    .\codex-proxy.ps1 stop           停止
    .\codex-proxy.ps1 test           跑本地协议自测（不需要外网）
    .\codex-proxy.ps1 tests          跑全部测试套件
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'down', 'restart', 'status', 'conns', 'check', 'app', 'cli', 'env', 'nodes', 'node-test', 'speed', 'best', 'use', 'auto', 'resolve', 'logs', 'test', 'tests', 'help')]
    [string]$Action = 'start',

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$root       = $PSScriptRoot
$entry      = Join-Path $root 'codex-proxy.mjs'
$configFile = Join-Path $root 'codex-proxy.config.json'
$logDir     = Join-Path $root 'logs'

function Write-Head($t) { Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "  [OK]   $t" -ForegroundColor Green }
function Write-Warn2($t){ Write-Host "  [警告] $t" -ForegroundColor Yellow }
function Write-Err2($t) { Write-Host "  [失败] $t" -ForegroundColor Red }

# ---------------------------------------------------------------- 环境准备

if (-not (Test-Path -LiteralPath $entry)) { throw "找不到 $entry" }

$config     = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$listenPort = $config.listen.port
$sshCfg     = $config.uplinks.ssh

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
    )
    $nodeExe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $nodeExe) { throw '找不到 node.exe，请先安装 Node.js 或把 node 加进 PATH。' }

<#
  调用 node 主程序。

  两个 PowerShell 坑，都已实测踩过，别再改回去：
  1) 参数必须用变量拼接后 splat：`& $nodeExe @(@($entry) + @($Arguments))`。
     写成 `Invoke-Proxy @('status')` 会被当成变量名，参数静默变空值。
  2) 返回一个对象（输出行 + 退出码），调用方**必须**用 `Show-Result` 打印，
     绝不能写成 `$null = Invoke-Proxy ...`：
     在 PowerShell 7 里，`$null = <函数调用>` 会把函数内部原生命令的输出也一起捕获并丢弃，
     结果就是 node 明明跑了、屏幕上却什么都没有。
#>
function Invoke-Proxy {
    param([string[]]$Arguments)
    $lines = & $nodeExe @(@($entry) + @($Arguments)) 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{
        Lines  = @($lines)
        ExitCode = $LASTEXITCODE
    }
}

function Show-Result {
    param($Result, [switch]$Quiet)
    if (-not $Quiet -and $Result.Lines) { $Result.Lines | ForEach-Object { Write-Host $_ } }
    return $Result.ExitCode
}

<#
  在 PowerShell 这一侧解析 Codex 桌面应用的路径，并以参数传给 node。

  为什么要在两边都做：Node 端那一套（查进程 → 查注册表 → Get-AppxPackage）依赖派生子进程
  并读回输出，在某些受限环境里拿不到输出，就会解析失败。PowerShell 这一侧是"原生"执行，
  最可靠，所以这里解析成功就优先用它。

  为什么要看"是否注册"：Codex 是 MSIX 应用，自动更新时 MSIX 会**先把新版本文件写进 WindowsApps**，
  注册晚一步完成。磁盘上因此可能出现比"已注册版本"更新的目录——那是更新半成品，直接跑不起来。
  所以必须用 Get-AppxPackage（只返回已注册的包）来挑，而不是按目录名排序。
#>
function Resolve-CodexDesktopExe {
    param([string]$Prefer = $null)

    # 版本选择策略（对应配置 codex.desktopPrefer，也可用 app --prefer <策略> 临时覆盖）
    #   registered（默认）—— 已注册的包里版本最高的那个。**等价于你双击桌面快捷方式拿到的版本**，
    #                       所以更新之后不需要改任何配置。
    #   newest           —— 磁盘上版本号最大的那个（可能包含尚未注册完成的更新半成品，风险自担）。
    #   running          —— 正在运行的那个实例，最贴近"你现在实际在用的"。
    if (-not $Prefer) { $Prefer = $config.codex.desktopPrefer }
    if (-not $Prefer) { $Prefer = 'registered' }
    $Prefer = ([string]$Prefer).ToLowerInvariant()

    # 显式写死了路径就用它（配置优先于策略）
    if ($config.codex.desktopExe -and (Test-Path -LiteralPath $config.codex.desktopExe)) {
        return (New-CodexDesktopInfo -Path $config.codex.desktopExe -Source 'config')
    }

    # ---- running：从正在运行的进程反查
    if ($Prefer -eq 'running') {
        $running = Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty Path -ErrorAction SilentlyContinue |
            Where-Object { $_ -like '*WindowsApps*ChatGPT.exe' } | Select-Object -First 1
        if ($running -and (Test-Path -LiteralPath $running)) {
            return (New-CodexDesktopInfo -Path $running -Source 'running')
        }
        # 没有在跑的实例就退回 registered（而不是直接失败）
        Write-Host '  （策略 running：没找到正在运行的实例，退回 registered）' -ForegroundColor DarkGray
        $Prefer = 'registered'
    }

    # ---- newest：磁盘上版本号最大的（包含未注册目录）
    if ($Prefer -eq 'newest') {
        $dirs = Get-ChildItem 'C:\Program Files\WindowsApps' -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending
        foreach ($d in $dirs) {
            $p = Join-Path $d.FullName 'app\ChatGPT.exe'
            if (Test-Path -LiteralPath $p) {
                return (New-CodexDesktopInfo -Path $p -Source 'newest（磁盘上版本号最大，可能是未注册的更新半成品）')
            }
        }
        Write-Host '  （策略 newest：磁盘上没找到，退回 registered）' -ForegroundColor DarkGray
        $Prefer = 'registered'
    }

    # ---- registered（默认）：只认【已注册】的包
    # 为什么必须用 Get-AppxPackage 而不是按目录名排序：更新时磁盘目录先落地、注册晚一步完成，
    # 磁盘上因此可能出现比"已注册版本"更新的目录 —— 那是更新半成品，直接跑不起来。
    try {
        $pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
            Sort-Object Version -Descending | Select-Object -First 1
        if ($pkg) {
            $p = Join-Path $pkg.InstallLocation 'app\ChatGPT.exe'
            if (Test-Path -LiteralPath $p) {
                return (New-CodexDesktopInfo -Path $p -Source 'registered' -Version $pkg.Version)
            }
        }
    } catch { }

    # 注册表里的已注册包（Get-AppxPackage 不可用时的等价来源）
    try {
        $names = Get-ChildItem 'HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages' -ErrorAction Stop |
            Where-Object { $_.PSChildName -like 'OpenAI.Codex_*' } |
            Select-Object -ExpandProperty PSChildName
        foreach ($n in ($names | Sort-Object -Descending)) {
            $p = Join-Path 'C:\Program Files\WindowsApps' (Join-Path $n 'app\ChatGPT.exe')
            if (Test-Path -LiteralPath $p) {
                return (New-CodexDesktopInfo -Path $p -Source 'registry')
            }
        }
    } catch { }

    # 兜底：列目录取最大（可能落到未注册的半成品，所以放最后并明确标注）
    $d = Get-ChildItem 'C:\Program Files\WindowsApps' -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($d) {
        $p = Join-Path $d.FullName 'app\ChatGPT.exe'
        if (Test-Path -LiteralPath $p) {
            return (New-CodexDesktopInfo -Path $p -Source '兜底（未确认是否已注册）')
        }
    }
    return $null
}

<#
  读包清单，拿到"双击桌面图标会启动什么"的权威信息。

  为什么需要：桌面上的 codex.lnk 是【AUMID 型快捷方式】——它的 TargetPath 是空的，
  由 Windows 通过包注册表解析成 `PackageFamilyName!AppId`。
  所以"双击图标启动的是哪个 exe"，权威来源是 AppxManifest.xml 里
  `<Application Id="App" Executable="app/ChatGPT.exe">` 这一行，
  而不是我们猜的那个路径。

  返回 @{ Aumid; Executable; Version; PackageDir } 或 $null
#>
function Get-CodexShortcutTarget {
    $dirs = @(Get-ChildItem 'C:\Program Files\WindowsApps' -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending)
    foreach ($d in $dirs) {
        $mf = Join-Path $d.FullName 'AppxManifest.xml'
        if (-not (Test-Path -LiteralPath $mf)) { continue }
        try {
            [xml]$xml = Get-Content -LiteralPath $mf -Raw
            # 找 Id="App" 的那个 Application（快捷方式用的就是它）
            $app = $xml.Package.Applications.Application | Where-Object { $_.Id -eq 'App' } | Select-Object -First 1
            if (-not $app) { continue }
            $exe = [string]$app.Executable
            if (-not $exe) { continue }
            # 目录名格式：<Identity Name>_<Version>_<Arch>__<PublisherId>
            #   例：OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0
            #       └ Identity Name ┘ └ Version ┘ └Arch┘ └ PublisherId ┘
            # 注意版本号本身的字符集与架构段有重叠，所以用 [0-9.] 限定版本，
            # PublisherId 取 "__"【之后】的那段（早期用 (.+)$ 会把 "x64__" 一起吃进去）。
            $m = [regex]::Match($d.Name, '^(.+?)_([0-9]+(?:\.[0-9]+)+)_[^_]+__(.+)$')
            $ver = if ($m.Success) { $m.Groups[2].Value } else { '未知' }
            # ★ AUMID = PackageFamilyName!AppId，PackageFamilyName = <Identity Name>_<PublisherId> ★
            #   不能直接用目录名的哈希段，那样会少掉包名前缀，跟快捷方式里的对不上。
            $idName = [string]$xml.Package.Identity.Name
            $pubId = if ($m.Success) { $m.Groups[3].Value } else { '' }
            $fam = if ($idName -and $pubId) { "${idName}_${pubId}" } else { $pubId }
            return [pscustomobject]@{
                Aumid      = "$fam!$($app.Id)"
                Executable = $exe.Replace('/', '\')
                ExePath    = Join-Path $d.FullName ($exe.Replace('/', '\'))
                Version    = $ver
                PackageDir = $d.FullName
            }
        } catch { }
    }
    return $null
}

<#
  读桌面上的 codex 快捷方式，看它的 AUMID 指向哪个包族。
  用来对照"快捷方式 → 包族"与我们"选中的版本 → 包族"是否一致。
#>
function Get-DesktopShortcutAumid {
    $cands = @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'codex.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codex.lnk'),
        (Join-Path $env:PUBLIC 'Desktop\codex.lnk'),
        (Join-Path $env:PUBLIC 'Desktop\Codex.lnk')
    )
    foreach ($c in $cands) {
        if (-not (Test-Path -LiteralPath $c)) { continue }
        try {
            # .lnk 里的 AUMID 是 UTF-16LE 存的，直接扫字符串
            $bytes = [System.IO.File]::ReadAllBytes($c)
            $sb = New-Object System.Text.StringBuilder
            for ($i = 0; $i -lt $bytes.Length - 1; $i += 2) {
                $ch = [char]($bytes[$i] -bor ($bytes[$i + 1] -shl 8))
                if ($ch -ge ' ' -and $ch -lt [char]127) { [void]$sb.Append($ch) }
                else { [void]$sb.Append("`n") }
            }
            $text = $sb.ToString()
            $m = [regex]::Match($text, '(OpenAI\.Codex_[A-Za-z0-9]+![A-Za-z0-9]+)')
            if ($m.Success) { return [pscustomobject]@{ Path = $c; Aumid = $m.Groups[1].Value } }
        } catch { }
    }
    return $null
}

<#
  把"路径 + 版本 + 来源"打包成一个对象，供 app/resolve 打印。
  版本号优先从路径里的包目录名解析（OpenAI.Codex_26.1007.2314.0_x64__hash），
  拿不到就用调用方传进来的（Get-AppxPackage 的 Version）。
#>
function New-CodexDesktopInfo {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Source = '',
        [string]$Version = ''
    )
    if (-not $Version) {
        $m = [regex]::Match($Path, 'OpenAI\.Codex_([0-9]+(?:\.[0-9]+)+)_')
        if ($m.Success) { $Version = $m.Groups[1].Value }
    }
    if (-not $Version) { $Version = '未知' }
    return [pscustomobject]@{ Path = $Path; Version = $Version; Source = $Source }
}

<#
  列出磁盘上所有 OpenAI.Codex 包目录及其版本，标注哪些是已注册的。
  用于 resolve：让你一眼看出"装了哪些版本、脚本会选哪个"。
#>
function Get-CodexInstalledVersions {
    $registered = @()
    try {
        $registered = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop |
            ForEach-Object { [string]$_.Version })
    } catch { }

    $out = @()
    foreach ($d in (Get-ChildItem 'C:\Program Files\WindowsApps' -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending)) {
        $m = [regex]::Match($d.Name, 'OpenAI\.Codex_([0-9]+(?:\.[0-9]+)+)_')
        $ver = if ($m.Success) { $m.Groups[1].Value } else { '未知' }
        $exe = Join-Path $d.FullName 'app\ChatGPT.exe'
        $out += [pscustomobject]@{
            Version    = $ver
            Registered = ($registered -contains $ver)
            HasExe     = (Test-Path -LiteralPath $exe)
            Path       = $exe
        }
    }
    return $out
}

<#
  在 PowerShell 这一侧解析 Codex CLI 的路径。
  CLI 在 %LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe，通常不在 PATH 里。
#>
function Resolve-CodexCliExe {
    if ($config.codex.cliExe -and (Test-Path -LiteralPath $config.codex.cliExe)) {
        return $config.codex.cliExe
    }
    $fromPath = (Get-Command codex -ErrorAction SilentlyContinue).Source
    if ($fromPath -and (Test-Path -LiteralPath $fromPath)) { return $fromPath }

    $d = Get-ChildItem "$env:LOCALAPPDATA\OpenAI\Codex\bin" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($d) {
        $p = Join-Path $d.FullName 'codex.exe'
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

<#
  确保 SSH 私钥已经加载进 ssh-agent。
  目的：脚本后台运行时不需要交互输密码短语，也不会走密码认证
        （你服务器上开着 fail2ban，密码重试会有被封的风险）。
#>
function Ensure-SshKey {
    if (-not $sshCfg.enabled) { return }
    $key = $sshCfg.identityFile
    if (-not $key -or -not (Test-Path -LiteralPath $key)) { return }

    $svc = Get-Service ssh-agent -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -ne 'Running') {
        Write-Warn2 'ssh-agent 服务未运行，尝试启动…'
        try { Start-Service ssh-agent; Write-Ok 'ssh-agent 已启动' }
        catch { Write-Warn2 "无法启动 ssh-agent（$($_.Exception.Message)），将直接使用密钥文件" }
    }

    $loaded = $null
    try { $loaded = & ssh-add -l 2>&1 } catch { $loaded = $null }
    $fingerprint = $null
    $pub = "$key.pub"
    if (Test-Path -LiteralPath $pub) {
        $pubLine = (Get-Content -LiteralPath $pub -Raw).Trim()
        $b64 = ($pubLine -split '\s+')[1]
        if ($b64) {
            try {
                $bytes = [Convert]::FromBase64String($b64)
                $sha = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
                $fingerprint = 'SHA256:' + ([Convert]::ToBase64String($sha).TrimEnd('='))
            } catch {}
        }
    }

    if ($fingerprint -and ($loaded -join "`n") -match [regex]::Escape($fingerprint)) {
        Write-Ok "SSH 密钥已在 ssh-agent 中（$fingerprint）"
        return
    }

    Write-Host '  正在把 SSH 密钥加入 ssh-agent（如密钥有密码短语会提示一次）…' -ForegroundColor DarkGray
    try {
        & ssh-add $key
        if ($LASTEXITCODE -eq 0) { Write-Ok 'SSH 密钥已加载' }
        else { Write-Warn2 'ssh-add 未成功，脚本会退回直接使用密钥文件认证' }
    } catch {
        Write-Warn2 "ssh-add 失败：$($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------- 动作

switch ($Action) {

    'start' {
        Write-Head '启动 Codex 专用代理'
        Ensure-SshKey
        $rc = Show-Result (Invoke-Proxy -Arguments @('start'))
        if ($rc -ne 0) { exit $rc }
        Write-Ok "本地代理 127.0.0.1:$listenPort"
        Write-Host ''
        Write-Host '  接下来：' -ForegroundColor DarkGray
        Write-Host '    桌面应用  .\codex-proxy.ps1 app' -ForegroundColor DarkGray
        Write-Host '    命令行    .\codex-proxy.ps1 cli' -ForegroundColor DarkGray
        Write-Host '    确认出口  .\codex-proxy.ps1 check' -ForegroundColor DarkGray
    }

    'stop' {
        Write-Head '停止 Codex 专用代理'
        $null = Show-Result (Invoke-Proxy -Arguments @('stop'))
        Write-Ok '已停止（Codex 若还在运行会失去代理，重启它即可恢复直连）'
    }

    'restart' {
        Write-Head '重启 Codex 专用代理'
        Ensure-SshKey
        $null = Show-Result (Invoke-Proxy -Arguments @('restart'))
        Write-Ok '已重启'
    }

    'status' {
        Write-Head '状态'
        $null = Show-Result (Invoke-Proxy -Arguments @('status'))
    }

    'conns' {
        Write-Head '活动连接与出口对应关系'
        $null = Show-Result (Invoke-Proxy -Arguments @('conns'))
    }

    'check' {
        Write-Head '连通性实测'
        $rc = Show-Result (Invoke-Proxy -Arguments @('check'))
        if ($rc -ne 0) { Write-Err2 '出口不通，请先执行 .\codex-proxy.ps1 start' }
        exit $rc
    }

    'env' {
        $null = Show-Result (Invoke-Proxy -Arguments @('env'))
    }

    'nodes' {
        Write-Head '回落出口会使用的节点'
        $null = Show-Result (Invoke-Proxy -Arguments @('nodes'))
    }

    'node-test' {
        Write-Head '回落节点逐个测延迟'
        $rc = Show-Result (Invoke-Proxy -Arguments @('node-test'))
        exit $rc
    }

    'speed' {
        Write-Head '各出口真实延迟与速度实测'
        Write-Host '  （发真实 HTTPS 请求 + 实际下载数据；只读，不切换、不影响正在用的出口）' -ForegroundColor DarkGray
        Write-Host ''
        $pArgs = @('speed')
        if ($Rest -contains '--bytes') {
            $bi = [Array]::IndexOf(@($Rest), '--bytes')
            if ($bi -ge 0 -and $bi + 1 -lt @($Rest).Count) { $pArgs += @('--bytes', @($Rest)[$bi + 1]) }
        }
        $rc = Show-Result (Invoke-Proxy -Arguments $pArgs)
        exit $rc
    }

    'best' {
        Write-Head '立刻切到实测最优出口'
        Write-Host '  （实测所有出口的真实延迟，切到最低的那个）' -ForegroundColor DarkGray
        Write-Host '  （不钉住：之后由判定规则接管，它仍是最优就不会被换掉）' -ForegroundColor DarkGray
        Write-Host ''
        $rc = Show-Result (Invoke-Proxy -Arguments @('best'))
        if ($rc -eq 0) {
            Write-Host ''
            Write-Host '  当前状态：' -ForegroundColor DarkGray
            $null = Show-Result (Invoke-Proxy -Arguments @('status'))
        }
        exit $rc
    }

    'use' {
        Write-Head '强制指定出口（钉住）'
        Write-Host '  （忽略自动判定规则，固定用你指定的那一条；想解除用 auto）' -ForegroundColor DarkGray
        Write-Host '  （如果你只是想"现在换成最好的那条"，应该用 best 而不是 use）' -ForegroundColor DarkGray
        Write-Host ''
        $pArgs = @('use')
        $restArr = @($Rest | Where-Object { $_ })
        if ($restArr.Count) { $pArgs += $restArr }
        $rc = Show-Result (Invoke-Proxy -Arguments $pArgs)
        if ($rc -eq 0) {
            Write-Host ''
            $null = Show-Result (Invoke-Proxy -Arguments @('status'))
        }
        exit $rc
    }

    'auto' {
        Write-Head '解除强制指定，回到自动选择'
        $rc = Show-Result (Invoke-Proxy -Arguments @('auto'))
        exit $rc
    }

    'resolve' {
        Write-Head '脚本实际会启动哪个 Codex'
        $info = Resolve-CodexDesktopExe
        $pArgs = @('resolve')
        if ($info) {
            $pArgs += @('--desktop-exe', $info.Path, '--desktop-version', $info.Version)
        }
        # 顺带把"装了哪些版本"也传过去，让 resolve 能打印完整清单
        $installed = @(Get-CodexInstalledVersions)
        if ($installed.Count) {
            # 组装成 "版本|是否已注册|是否有exe" 的形式（避免往 node 传对象）
            $list = ($installed | ForEach-Object { "$($_.Version)|$($_.Registered)|$($_.HasExe)" }) -join ';'
            $pArgs += @('--installed', $list)
        }
        # ★ 关键：把"双击桌面图标会启动什么"的权威答案也传过去 ★
        #   桌面快捷方式是 AUMID 型的，TargetPath 为空，真正的入口写在 AppxManifest.xml 里。
        #   这里读出来，让 resolve 能直接对照"我们会启动的"与"双击图标会启动的"是否一致。
        $shortcut = Get-CodexShortcutTarget
        $deskLnk = Get-DesktopShortcutAumid
        if ($shortcut) {
            $pArgs += @('--shortcut-exe', $shortcut.ExePath,
                        '--shortcut-aumid', $shortcut.Aumid,
                        '--shortcut-version', $shortcut.Version)
        }
        if ($deskLnk) { $pArgs += @('--lnk-aumid', $deskLnk.Aumid, '--lnk-path', $deskLnk.Path) }
        $null = Show-Result (Invoke-Proxy -Arguments $pArgs)
    }

    'app' {
        Write-Head '启动 Codex 桌面应用（已挂代理）'
        Ensure-SshKey
        # 版本策略：--prefer 优先，否则用配置 codex.desktopPrefer（默认 registered）
        # 在 PowerShell 这一侧先解析好路径再传给 node（更可靠，理由见 Resolve-CodexDesktopExe 注释）
        $restArr = @($Rest | Where-Object { $_ })
        $prefer = $null
        $pi = [Array]::IndexOf($restArr, '--prefer')
        if ($pi -ge 0 -and $pi + 1 -lt $restArr.Count) { $prefer = $restArr[$pi + 1] }
        $info = Resolve-CodexDesktopExe -Prefer $prefer
        if (-not $info) {
            Write-Err2 '找不到 Codex 桌面应用。'
            Write-Host '  请确认 Codex 桌面版已安装，或在 codex-proxy.config.json 里设置 codex.desktopExe。' -ForegroundColor Yellow
            Write-Host '  查看装在哪：Get-AppxPackage -Name OpenAI.Codex | Select InstallLocation' -ForegroundColor Yellow
            exit 1
        }
        Write-Host ("  选中版本: {0}   （策略: {1}，来源: {2}）" -f $info.Version, $(if ($prefer) { $prefer } else { $config.codex.desktopPrefer }), $info.Source) -ForegroundColor DarkGray

        $pArgs = @('app', '--desktop-exe', $info.Path, '--desktop-version', $info.Version)
        # ★ 把真正生效的策略名也传过去 ★
        #   策略是在 PowerShell 侧解析的（那边能查 MSIX 注册表）。
        #   如果不传，node 侧只能回退去读配置，于是 `app --prefer newest` 时日志里
        #   仍会打印配置里的 registered —— 说的和做的不一致。
        $effPrefer = if ($prefer) { $prefer } else { $config.codex.desktopPrefer }
        if (-not $effPrefer) { $effPrefer = 'registered' }
        $pArgs += @('--prefer', $effPrefer)
        # 透传 --force（强制重启）
        if ($restArr -contains '--force') { $pArgs += '--force' }
        $rc = Show-Result (Invoke-Proxy -Arguments $pArgs)
        if ($rc -ne 0) { exit $rc }
        Write-Host ''
        Write-Host "  Codex 的流量现在走 127.0.0.1:$listenPort，其它应用不受影响。" -ForegroundColor DarkGray
        Write-Host '  确认出口：.\codex-proxy.ps1 check' -ForegroundColor DarkGray
    }

    'cli' {
        Write-Head '启动 codex CLI（已挂代理）'
        Ensure-SshKey
        $null = Show-Result (Invoke-Proxy -Arguments @('start'))

        # 注意：codex 常常**不在 PATH 里**——官方安装器把 CLI 放在
        # %LOCALAPPDATA%\OpenAI\Codex\bin\<哈希>\codex.exe，但没写进 PATH。
        # 所以必须显式解析它的完整路径，并把所在目录补进本会话的 PATH。
        $codexExe = (Get-Command codex -ErrorAction SilentlyContinue).Source
        if (-not $codexExe) {
            $codexExe = Get-ChildItem -LiteralPath "$env:LOCALAPPDATA\OpenAI\Codex\bin" -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'codex.exe' } |
                Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        }

        $env:HTTP_PROXY  = "http://127.0.0.1:$listenPort"
        $env:HTTPS_PROXY = "http://127.0.0.1:$listenPort"
        $env:ALL_PROXY   = "socks5h://127.0.0.1:$listenPort"
        $env:NO_PROXY    = 'localhost,127.0.0.1,::1'
        Write-Ok "HTTP(S)_PROXY=http://127.0.0.1:$listenPort"

        if ($codexExe) { $env:PATH = "$(Split-Path -Parent $codexExe);$env:PATH" }

        if ($Rest.Count -gt 0) {
            # 带参数：直接跑一次（例如 cli exec "你好"）；可执行文件由 node 端再次解析，双保险
            Write-Host "  执行：codex $($Rest -join ' ')" -ForegroundColor DarkGray
            $rc = Show-Result (Invoke-Proxy -Arguments (@('run', '--') + $Rest))
            exit $rc
        }

        if (-not $codexExe) {
            Write-Err2 '找不到 codex 可执行文件，无法把 codex 命令加进本会话。'
            Write-Host '  请在 codex-proxy.config.json 里设置 codex.cliExe，或手工执行：' -ForegroundColor Yellow
            Write-Host '    $env:PATH = "<codex.exe 所在目录>;$env:PATH"' -ForegroundColor Yellow
            exit 1
        }

        Write-Ok "codex = $codexExe"
        Write-Host ''
        Write-Host '  这个终端里现在直接敲 codex 即可（代理只作用于本终端启动的进程）。' -ForegroundColor DarkGray
        Write-Host '  注意：PATH 改动只影响当前窗口，关掉窗口即失效；新窗口请重跑一次 cli。' -ForegroundColor DarkGray
        Write-Host '  想直接跑一条命令：.\codex-proxy.ps1 cli exec "你好"' -ForegroundColor DarkGray
    }

    'down' {
        Write-Head '关闭代理和 Codex'
        $null = Show-Result (Invoke-Proxy -Arguments @('down'))
    }

    'logs' {
        Write-Head '最近日志'
        if (-not (Test-Path -LiteralPath $logDir)) { Write-Warn2 '还没有日志'; break }
        Get-ChildItem -LiteralPath $logDir -Filter '*.log' |
            Sort-Object LastWriteTime -Descending | Select-Object -First 4 | ForEach-Object {
                Write-Host ''
                Write-Host "--- $($_.Name) (最后 20 行) ---" -ForegroundColor DarkCyan
                Get-Content -LiteralPath $_.FullName -Tail 20
            }
    }

    'test' {
        Write-Head '本地协议自测'
        # 测试脚本在 tests\ 目录下；兼容旧位置（根目录）以防有人手工挪动过
        $t = Join-Path $root 'tests\01-bridge.mjs'
        if (-not (Test-Path -LiteralPath $t)) { $t = Join-Path $root 'test-bridge.mjs' }
        if (-not (Test-Path -LiteralPath $t)) {
            Write-Err2 '找不到测试脚本（tests\01-bridge.mjs）'
            exit 1
        }
        & $nodeExe $t
        exit $LASTEXITCODE
    }

    'tests' {
        Write-Head '全部测试脚本'
        & pwsh -NoProfile -File (Join-Path $root 'tests\run-all.ps1')
        exit $LASTEXITCODE
    }

    'help' {
        Get-Help $PSCommandPath -Detailed
    }
}
