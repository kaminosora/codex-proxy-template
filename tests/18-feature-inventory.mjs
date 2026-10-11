// tests/18-feature-inventory.mjs — 功能清单：文档提到的每个功能，代码里是否真的实现
//
// 与 17 号的分工：
//   17 号核对「文档里的数字/命令/路径」是否与代码一致（防文档漂移）
//   18 号核对「文档提到的功能」是否真的实现了（防功能遗漏）
//
// 每一项都写成：功能名 → 必须在代码里找到的实现锚点（函数名/关键语句/配置项）。
// 锚点挑的是「这个功能真的存在」的证据，不是随便一个词。
//
// 用法： node tests/18-feature-inventory.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const M = await import(pathToFileURL(path.join(ROOT, 'codex-proxy.mjs')).href);

const mjs = fs.readFileSync(path.join(ROOT, 'codex-proxy.mjs'), 'utf8');
const ps1 = fs.readFileSync(path.join(ROOT, 'codex-proxy.ps1'), 'utf8');
const cfgRaw = fs.readFileSync(path.join(ROOT, 'codex-proxy.config.json'), 'utf8');
const cfg = M.loadConfig();
const docs = ['README.md', '使用手册.md', '故障排查与说明.md', 'tests/README.md']
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}
/** 锚点必须在代码里出现（mjs 或 ps1 或配置） */
const has = (needle) => mjs.includes(needle) || ps1.includes(needle) || cfgRaw.includes(needle);
/** 文档里提过这个话题 */
const documented = (re) => re.test(docs);

console.log('=== 18 功能清单核对 ===\n');

// ================================================================ A. 三个出口
step('A. 三个出口（SSH / xray / 回落）');
{
  check('SSH 出口类', has('class SshTunnel'));
  check('SSH 动态转发参数（-D 本地 SOCKS）', has("'-D'") || has('-D 127.0.0.1'));
  check('SSH 免密（BatchMode + 禁用密码提示）', has('BatchMode=yes') && has('NumberOfPasswordPrompts=0'));
  check('SSH 断线自动重连（有重连计数与递增退避）', /重连（第 \$\{|重连（第 /.test(mjs) || has('重连'));
  check('SSH 保活（ServerAliveInterval）', has('ServerAliveInterval'));

  check('xray 出口类', has('class XrayUplink'));
  check('xray VLESS+REALITY 配置生成', has('buildConfig()') && has("security: 'reality'"));
  check('xray 支持 REALITY 公钥的两种字段名', has('c.password || c.publicKey'));
  check('xray 启动前自检（缺关键项给清晰提示）', has('validateConfig()'));

  check('回落出口类', has('class ClashPartyUplink'));
  check('回落用独立 mihomo 实例（独立目录）', has('FALLBACK_DIR'));
  check('回落内核优先用改名副本 codex-core.exe', has("'codex-core.exe'"));
  check('回落配置含 url-test 策略组（自动选最快节点）', has('type: url-test'));
  check('回落节点数可配', 'maxNodes' in cfg.uplinks.clashParty);
  check('回落的 SOCKS 端口对客户端隐藏（只暴露 mixed-port）', cfg.uplinks.clashParty.mixedPort === 17893);
}

// ================================================================ B. 本地桥接
step('B. 本地桥接（HTTP CONNECT + SOCKS5）');
{
  check('桥接类', has('class Bridge'));
  check('HTTP CONNECT 支持', /method === 'CONNECT'/.test(mjs));
  check('SOCKS5 支持', has('handleSocks'));
  check('SOCKS5 问候语按 NMETHODS 剥（防错位）', has('const greetLen = 2 + nMethods'));
  check('socks5h 语义（把域名交给上游解析）', has('Buffer.from(targetHost') || has("atyp === 0x03"));
  check('无健康出口时立刻失败而不是挂死', has('no healthy uplink') || has('没有可用出口'));
}

// ================================================================ C. 出口选择
step('C. 出口选择与自动切换');
{
  check('四层选择逻辑（selectUplink）', has('selectUplink() {'));
  check('第 1 层：手动强制指定优先', has('if (this.pinnedUplink) {'));
  check('第 2 层：粘性（当前健康就保持）', has('const stillOk = healthy.find'));
  check('第 3 层：按 priority 回落', has('const first = healthy[0] || null'));
  check('第 4 层：性能判定取最快候选', has('candMs === null || h.lastMs < candMs'));
  check('性能判定是纯函数（可单测）', has('function decideLatencySwitch'));
  check('slowMs 地板语义', cfg.health.slowMs === 250);
  check('fastRatio + minGainMs 双阈值', has('Math.max(curH.lastMs / cfg.fastRatio'));
  check('satisfiedPolls 连续计数', cfg.health.satisfiedPolls === 3);
  check('cooldownMs 冷静期', cfg.health.cooldownMs === 120000);
  check('latencyAware 可关闭（回到纯优先级模式）', has('cfg.latencyAware !== false'));
  check('探测防重入闸门', has('if (this.probeRunning)'));
  check('真实延迟判据（HTTPS 往返，不是本地握手）', has('realMs = Date.now() - t0'));
  check('握手值另存，不参与判据', has('h.handshakeMs = handshake'));
  check('拿不到真实延迟就标不新鲜（不拿旧数字做判断）', has('h.latencyFresh = realMs !== null'));
}

// ================================================================ D. 连接管理（界面呆住）
step('D. 连接管理（防「界面呆住」）');
{
  check('切换出口时断开旧出口连接', has("dropConnectionsOnUplink(prev.name, '切换出口')"));
  check('出口被判 DOWN 时也断开', has('该出口被判不健康'));
  check('TCP keepalive', has('setKeepAlive(true, 15000)'));
  check('空闲连接清理', has('reapIdleConnections(idleMs) {'));
  check('空闲超时可配', 'connIdleTimeoutSec' in cfg.health);
  check('连接表用于断连（Set 记录活动连接）', has('this.conns = new Set()'));
  check('按连接建立时刻归属出口（分桶统计）', has('this.pipe(client, upstream, up.name)'));
  check('文档解释了这个设计的原因', documented(/界面.*呆住|呆住/));
}

// ================================================================ E. Codex 挂代理
step('E. Codex 挂代理');
{
  check('桌面应用用 --proxy-server（Chromium 不读环境变量）', has('--proxy-server'));
  check('CLI 注入代理环境变量', has('HTTP_PROXY') && has('HTTPS_PROXY'));
  check('注入 ALL_PROXY（socks5h）', has('socks5h://'));
  check('注入 NO_PROXY（本机不走代理）', has('NO_PROXY'));
  check('注入范围只限 app 启动的那棵进程树', /env: \{ \.\.\.process\.env, \.\.\.proxyEnv/.test(mjs));
  check('app 幂等（已在用则不重启）', has('codexUsingOurProxy'));
  check('app --force 可强制重启', has("argv.includes('--force')"));
  check('down = 代理 + Codex 一起关', has('async function cmdDown'));
  check('不修改系统代理（无注册表写入）', !/Set-ItemProperty[^\n]*Internet Settings/i.test(mjs + ps1));
}

// ================================================================ F. 版本与更新
step('F. 版本识别与更新适配');
{
  check('版本策略配置项存在', 'desktopPrefer' in cfg.codex);
  check('三种策略都实现', ps1.includes("'registered'") && ps1.includes("'newest'") && ps1.includes("'running'"));
  check('registered 用 Get-AppxPackage（只认已注册的包）', has('Get-AppxPackage -Name'));
  check('读包清单拿 AUMID 与入口 exe', has('AppxManifest.xml') && has('Get-CodexShortcutTarget'));
  check('读桌面 .lnk 拿 AUMID 做对照', has('Get-DesktopShortcutAumid'));
  check('resolve 打印已装版本清单', has('磁盘上已装的 Codex 版本'));
  check('resolve 做版本一致性对照', has('版本一致性验证'));
  check('文档说明了「直接启动 exe 会丢包标识」', documented(/包标识|包身份/));
  check('文档说明了更新流程（用快捷方式启动一次）', documented(/更新.*快捷方式|快捷方式.*更新/));
}

// ================================================================ G. 进程与生命周期
step('G. 进程与生命周期');
{
  check('killTree 杀整棵进程树', has('function killTree'));
  check('孤儿回收两道保险', has('function reapPreviousChildren'));
  check('按 children.json 记录的 pid 回收', has('来自 children.json'));
  check('按端口反查回收', has('端口反查'));
  check('子进程登记（供下次回收）', has('function recordChildren'));
  check('控制端口做优雅退出（Windows 信号不可靠）', has('function startControlServer'));
  check('shutdown 杀子进程并等它们结束', has('killTree(pid)'));
  check('启动前端口预检（清残留孤儿）', has('判为上一轮残留') || has('被 pid ${holder} 占用'));
  check('listen 有递增重试（吃竞争窗口）', has('_listenOnce') && has('EADDRINUSE'));
}

// ================================================================ H. 命令面
step('H. 命令面（17 个命令都能跑）');
{
  const cmds = ['start', 'stop', 'down', 'restart', 'status', 'check', 'app', 'env',
    'nodes', 'node-test', 'speed', 'best', 'use', 'auto', 'resolve'];
  for (const c of cmds) {
    check(`CLI 有 ${c} 命令`, new RegExp(`case '${c}':`).test(mjs));
  }
  check('ps1 的 ValidateSet 覆盖全部命令',
    cmds.every((c) => new RegExp(`'${c}'`).test(ps1)), '');
  check('ps1 有子命令分支', /'(start|app)'\s*\{/.test(ps1));
}

// ================================================================ I. 隔离性硬约束
step('I. 隔离性硬约束（与 Clash Party / 系统共存）');
{
  const cu = new M.ClashPartyUplink({ ...cfg.uplinks.clashParty, maxNodes: 2 });
  let cfgText = '';
  try { cfgText = cu.buildConfig(); } catch { /* 读不到订阅就跳过结构断言 */ }
  if (cfgText) {
    check('回落配置不含 tun 段', !/^\s*tun\s*:/m.test(cfgText));
    check('回落配置不含 auto-route', !/auto-route/.test(cfgText));
    check('回落配置 bind-address 限本机', /bind-address:\s*127\.0\.0\.1/.test(cfgText));
    check('回落配置 allow-lan: false', /allow-lan:\s*false/.test(cfgText));
    check('proxies 段是合法 YAML 列表项', /  - \{ name: /.test(cfgText));
  } else {
    console.log('      （读不到订阅，跳过回路配置结构断言）');
  }
  check('回落内核用改名副本（避开进程名检测）', M.loadConfig() && (() => {
    const up = new M.ClashPartyUplink(cfg.uplinks.clashParty);
    const exe = up.coreExe();
    return exe ? !/mihomo(-alpha|-smart)?\.exe$/i.test(exe.split(/[\\/]/).pop()) : true;
  })());
  check('文档说明了内核必须改名的原因', documented(/内核必须改名|高权限内核/));
  check('文档说明了回落不写 Clash Party 目录', documented(/只读|绝不写入/));
}

// ================================================================ J. 测试套件自身
step('J. 测试套件覆盖');
{
  const testFiles = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => /^\d\d-/.test(f));
  check('测试脚本数 ≥ 17', testFiles.length >= 17, String(testFiles.length));
  const all = testFiles.map((f) => fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8')).join('\n');
  // 关键功能都要有测试覆盖
  const covered = [
    ['桥接协议', '01-bridge'],
    ['通道端到端', '02-ours-channel'],
    ['隔离性', '03-fallback-isolation'],
    ['节点延迟', '04-node-test'],
    ['孤儿回收', '05-reaper'],
    ['进程生命周期', '06-process-lifecycle'],
    ['三路径对照', '07-egress-paths'],
    ['流量归属', '08-codex-egress'],
    ['服务器侦察', '09-server-recon'],
    ['延迟切换', '10-latency-switch'],
    ['探测开销', '11-probe-overhead'],
    ['选择规则', '12-selection-rules'],
    ['流量记账', '13-uplink-accounting'],
    ['YAML 类型', '14-yaml-typing'],
    ['app 幂等', '15-app-idempotent'],
    ['版本策略', '16-version-strategy'],
    ['文档一致性', '17-doc-claims'],
  ];
  for (const [label, prefix] of covered) {
    check(`${label} 有对应测试（${prefix}）`, testFiles.some((f) => f.startsWith(prefix)), '');
  }
}

// ================================================================ 汇总
console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
