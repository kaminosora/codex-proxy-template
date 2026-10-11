# tests/09-server-recon.ps1 — 日本服务器只读侦察
#
# 用途：换服务器、怀疑服务器配置被改动、或想确认 xray/防火墙现状时跑一次。
# **全程只读**：只用 ssh 执行查询命令，不写任何文件、不改任何配置、不重启服务。
#
# 会采集：
#   - 系统信息（发行版 / 内核 / 虚拟化）
#   - xray 状态与入站配置（端口、协议、flow、REALITY 目标）
#   - 防火墙规则（nftables / fail2ban；本机不用 ufw）
#   - SSH 认证策略（确认只有公钥）
#   - BBR 与拥塞控制
#   - 出口 IP 与 ASN
#   - 从服务器侧到 OpenAI 各端点的连通性（判断它能不能当出口）
#
# ⚠️ 输出里密钥类字段会被遮掉（id / password / privateKey 等），但仍建议自己留档时注意。
#
# 用法： pwsh -NoProfile -File tests\09-server-recon.ps1 [-Host YOUR_SERVER_IP] [-Key <私钥路径>]
param(
    [string]$TargetHost = 'YOUR_SERVER_IP',
    [string]$Key = '',
    [string]$User = 'root'
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

if (-not $Key) {
    foreach ($c in @(
        "$env:USERPROFILE\.ssh\id_ed25519_your_server",
        "$env:USERPROFILE\.ssh\id_ed25519",
        "$env:USERPROFILE\.ssh\id_rsa"
    )) { if (Test-Path -LiteralPath $c) { $Key = $c; break } }
}

$sshArgs = @(
    '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new'
)
if ($Key -and (Test-Path -LiteralPath $Key)) { $sshArgs += @('-i', $Key) }

Write-Host '=== 09 服务器只读侦察 ===' -ForegroundColor Yellow
Write-Host "目标: $User@$TargetHost"
Write-Host "密钥: $(if ($Key) { $Key } else { '(未找到，靠 ssh-agent)' })"
Write-Host '本脚本全程只读，不会修改服务器任何内容。'
Write-Host ''

# 一条复合命令，一次 SSH 拿完，减少连接次数（也避免触发 fail2ban）
$remote = @'
echo "##### 系统"
cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME|VERSION)=' || true
uname -r
systemd-detect-virt 2>/dev/null || true
echo
echo "##### xray 服务"
systemctl is-active xray 2>/dev/null || echo "(xray 服务不存在)"
systemctl show xray -p ActiveEnterTimestamp --value 2>/dev/null || true
/usr/local/bin/xray version 2>/dev/null | head -2 || xray version 2>/dev/null | head -2 || echo "(找不到 xray 命令)"
echo
echo "##### xray 入站配置（密钥字段已遮蔽）"
if [ -f /usr/local/etc/xray/config.json ]; then
  sed -E 's/("(id|password|privateKey|publicKey|shortIds)"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"***"/g; s/("(id|password|privateKey|publicKey)"[[:space:]]*:[[:space:]]*\[)[^]]*\]/\1"***"]/g' \
    /usr/local/etc/xray/config.json
else
  echo "(没有 /usr/local/etc/xray/config.json)"
fi
echo
echo "##### systemd drop-in"
ls -1 /etc/systemd/system/xray.service.d/ 2>/dev/null || echo "(无 drop-in)"
echo
echo "##### 监听端口"
ss -tlnp 2>/dev/null | head -20
echo
echo "##### 防火墙（nftables）"
nft list ruleset 2>/dev/null | head -60 || echo "(读不到 nft 规则)"
echo
echo "##### fail2ban"
fail2ban-client status 2>/dev/null || echo "(没有 fail2ban 或读不到)"
fail2ban-client status sshd 2>/dev/null | head -12 || true
echo
echo "##### ufw（应为不存在或未启用）"
ufw status 2>/dev/null || echo "(没有 ufw —— 符合预期)"
echo
echo "##### SSH 认证策略"
grep -Ei '^(PasswordAuthentication|PermitRootLogin|PubkeyAuthentication|Port)' /etc/ssh/sshd_config 2>/dev/null || true
ls -1 /etc/ssh/sshd_config.d/ 2>/dev/null | head -10 || true
echo
echo "##### BBR / 拥塞控制"
sysctl net.ipv4.tcp_congestion_control net.core.default_qdisc 2>/dev/null || true
echo
echo "##### 出口 IP 与 ASN"
curl -s --max-time 8 https://api.ipify.org || echo "(拿不到出口 IP)"
echo
curl -s --max-time 8 https://ipinfo.io/json | head -c 400
echo
echo
echo "##### 从服务器到 OpenAI（看 HTTP 状态码，403/421 表示 TCP+TLS 通）"
for u in https://codex-cloud-backend.chatgpt.com https://chatgpt.com https://api.openai.com/v1/models; do
  printf '%-52s ' "$u"
  curl -s -o /dev/null -w 'HTTP %{http_code}  TLS %{time_connect}s  total %{time_total}s\n' --max-time 12 "$u" 2>/dev/null || echo "(失败)"
done
echo
echo "##### 负载与内存"
uptime
free -m | head -2
'@

Write-Host '--- 采集（一条 SSH 命令拿完） ---' -ForegroundColor Cyan
$out = & ssh @sshArgs "$User@$TargetHost" $remote 2>&1
$exit = $LASTEXITCODE

if ($exit -ne 0) {
    Write-Host ''
    Write-Host "SSH 执行失败（退出码 $exit）。可能原因：" -ForegroundColor Red
    Write-Host '  * 密钥没加载：ssh-add "$env:USERPROFILE\.ssh\id_ed25519_your_server"'
    Write-Host '  * 服务器不可达或防火墙拦了 22'
    Write-Host '  * 被 fail2ban 临时封禁（等一会儿或换 IP）'
    Write-Host ''
    Write-Host '原始输出：'
    $out | Select-Object -First 15 | ForEach-Object { Write-Host "  $_" }
    exit 1
}

$out | ForEach-Object { Write-Host $_ }
Write-Host ''
Write-Host '=== 侦察完成（未对服务器做任何修改）===' -ForegroundColor Green
Write-Host ''
Write-Host '判读要点：' -ForegroundColor Yellow
Write-Host '  * 到 OpenAI 的 HTTP 403/421 = TCP+TLS 全通，这台机器可以当出口'
Write-Host '  * 入站只有 443 VLESS+REALITY、clients 只有一个 = 不要乱加 UUID（会动到在用线路）'
Write-Host '  * 防火墙是 nftables（table inet filter + fail2ban 的 f2b-table），本机不用 ufw'
Write-Host '  * PasswordAuthentication 应为 no'
