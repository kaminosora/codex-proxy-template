// tests/04-node-test.mjs — 逐个测量回落出口（机场节点）的真实延迟
//
// 为什么不能"经本地 SOCKS 建连来测延迟"：那只量到本地握手（实测全是 0~2ms），
// 完全反映不出节点真实速度。正确做法是问 mihomo 自己的测速接口：
//   GET /proxies/<名字>/delay?timeout=6000&url=<测试URL>
//
// 本脚本会临时起一个独立的 mihomo 实例（独立端口 + secret + 数据目录），
// 跑完就在 finally 里杀掉，不会影响正在运行的守护进程或 Clash Party。
//
// 用法：
//   node tests/04-node-test.mjs              # 用默认测试 URL
//   node tests/04-node-test.mjs <订阅文件>    # 指定 profile 文件
//
// 预期：每个节点打印 100~400ms 属正常；OFFLINE/超时说明该节点不可用。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
// Windows 上动态 import 必须用 file:// URL
const M = await import(pathToFileURL(path.join(ROOT, 'codex-proxy.mjs')).href);
const { resolveProfileFile, findMihomo, productionCoreExe, JP_RE } = await import(pathToFileURL(path.join(HERE, '_helpers.mjs')).href);

const TEST_URL = 'https://www.gstatic.com/generate_204';
const TIMEOUT = 6000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function rawHttpGet(port, secret, pathname, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.write(
        `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
        `Authorization: Bearer ${secret}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    const t = setTimeout(() => { sock.destroy(); resolve(null); }, timeoutMs);
    sock.on('data', (d) => { buf += d; });
    sock.on('close', () => {
      clearTimeout(t);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return resolve(null);
      try { resolve(JSON.parse(buf.slice(i + 4))); } catch { resolve(null); }
    });
    sock.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

// ---------------------------------------------------------------- 找订阅文件
// 必须顺着 profile.yaml 的 current 去找 profiles\<id>.yaml —— profile.yaml 只是订阅索引。
const profile = resolveProfileFile(process.argv[2] || null);
if (!profile) {
  console.error('找不到订阅/配置文件。用法：node tests/04-node-test.mjs <配置文件路径>');
  process.exit(1);
}
console.log(`=== 04 回落节点延迟实测 ===`);
console.log(`配置来源: ${profile}\n`);

const proxies = M.parseProfileProxies(fs.readFileSync(profile, 'utf8'));
if (!proxies.length) {
  console.error('这份配置里没解析出代理节点。');
  console.error('提示：%APPDATA%\\mihomo-party\\profile.yaml 只是订阅索引，节点在 profiles\\<current>.yaml');
  process.exit(1);
}
console.log(`解析出 ${proxies.length} 个节点，其中日本相关节点：`);
const jp = proxies.filter((p) => JP_RE.test(p.name));
for (const p of (jp.length ? jp : proxies)) console.log(`  - ${p.name}  (${p.type})`);
console.log('');

// ---------------------------------------------------------------- 起临时 mihomo
const ctlPort = await freePort();
const socksPort = await freePort();
const secret = 'nodetest-' + Date.now();
const dir = path.join(ROOT, 'run', 'nodetest');
fs.mkdirSync(dir, { recursive: true });

const list = (jp.length ? jp : proxies).slice(0, 20);
const lines = [
  'mixed-port: ' + socksPort,
  'allow-lan: false',
  'mode: rule',
  'log-level: warning',
  'external-controller: 127.0.0.1:' + ctlPort,
  'secret: "' + secret + '"',
  'proxies:',
];
for (const p of list) {
  const kv = Object.entries(p).filter(([k]) => k !== 'name').map(([k, v]) => `${k}: ${M.yamlScalar(v)}`).join(', ');
  lines.push(`  - { name: ${M.yamlScalar(p.name)}, ${kv} }`);
}
lines.push('proxy-groups:');
lines.push(`  - { name: NODES, type: select, proxies: [${list.map((p) => M.yamlScalar(p.name)).join(', ')}] }`);
lines.push('rules:');
lines.push('  - MATCH,NODES');

const cfgFile = path.join(dir, 'config.yaml');
fs.writeFileSync(cfgFile, lines.join('\n'), 'utf8');

// ★ 必须用【生产实际会用】的内核，不是 Clash Party 自带的 mihomo.exe ★
//   本测试会起实例；用 mihomo.exe 会：
//     ① 撞上 Clash Party 的"高权限内核检测"（纯进程名匹配，点取消它会退出）
//     ② 测的不是生产路径（生产用的是改名副本 bin\codex-core.exe）
//   早期这里用了 findMihomo()，输出的就是 Clash Party 目录下的 mihomo.exe —— 已修。
const exe = await productionCoreExe(ROOT);
if (!exe) { console.error('找不到可用的 mihomo 内核（生产会优先用 bin\\codex-core.exe）。'); process.exit(1); }
console.log(`使用内核: ${exe}`);
console.log(`  （生产用的就是它；文件名应为 codex-core 而不是 mihomo —— 改名是为了避开 Clash Party 的高权限检测）`);
{
  const base = path.basename(exe).toLowerCase();
  const renamed = !/^mihomo(-alpha|-smart)?\.exe$/.test(base);
  if (renamed) {
    console.log('  ✔ 是改名副本，不会触发 Clash Party 的进程名检测');
  } else {
    console.log('  ⚠ 这是 Clash Party 自带的 mihomo.exe —— 起实例时可能触发它的"高权限内核"弹窗。');
    console.log(`     建议把内核复制到 ${path.join(ROOT, 'bin', 'codex-core.exe')} 再跑。`);
  }
  const orig = findMihomo();
  if (orig && orig !== exe) console.log(`  （参照：Clash Party 自带的内核在 ${orig}）`);
}
console.log('');

// 受限环境（沙箱）不允许启动子进程 —— 如实说明并退出，不要抛 EPERM 中断。
// 注意探测必须用【带管道】的 stdio：EPERM 来自"创建管道"这一步，
// stdio:'ignore' 不建管道，探测不出来（会误判成可以 spawn）。
function canSpawn() {
  try {
    const p = spawn(process.execPath, ['-e', 'process.exit(0)'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    p.on('error', () => {});
    return true;
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return false;
    throw e;
  }
}
if (!canSpawn()) {
  console.log('跳过：当前环境不允许启动子进程（spawn EPERM）。');
  console.log('      请在普通终端里运行： node tests/04-node-test.mjs');
  console.log('      也可直接用生产命令测：.\\codex-proxy.ps1 node-test');
  process.exit(0);
}

let child = null;
try {
  child = spawn(exe, ['-d', dir, '-f', cfgFile], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.on('error', (e) => console.error('  mihomo 启动失败: ' + e.message));

  // 等控制端口就绪
  let ready = false;
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    const r = await rawHttpGet(ctlPort, secret, '/version', 3000);
    if (r && r.version) { ready = true; console.log(`mihomo 就绪（${r.version}）\n`); break; }
  }
  if (!ready) { console.error('mihomo 控制端口没起来。'); process.exit(1); }

  console.log('逐个测延迟（真实 API 测速，非本地握手）：');
  const rows = [];
  for (const p of list) {
    const q = `/proxies/${encodeURIComponent(p.name)}/delay?timeout=${TIMEOUT}&url=${encodeURIComponent(TEST_URL)}`;
    const r = await rawHttpGet(ctlPort, secret, q, TIMEOUT + 5000);
    const ms = r && typeof r.delay === 'number' ? r.delay : null;
    rows.push({ name: p.name, ms, msg: r?.message || '' });
    console.log(`  ${ms !== null ? String(ms).padStart(5) + ' ms' : '  ----  '}  ${p.name}${ms === null && r?.message ? '   (' + r.message + ')' : ''}`);
  }

  const ok = rows.filter((r) => r.ms !== null);
  console.log('');
  console.log(`可用 ${ok.length}/${rows.length}`);
  if (ok.length) {
    ok.sort((a, b) => a.ms - b.ms);
    console.log(`最快: ${ok[0].name}  ${ok[0].ms}ms`);
    console.log(`最慢可用: ${ok[ok.length - 1].name}  ${ok[ok.length - 1].ms}ms`);
    const avg = Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length);
    console.log(`平均: ${avg}ms`);
  }
  console.log('\n注：回落出口内部是 url-test 组，会自动选最快的，一般不需要手工指定节点。');
} finally {
  if (child) {
    try { M.killTree({ pid: child.pid }); } catch {}
    await sleep(800);
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
process.exit(0);
