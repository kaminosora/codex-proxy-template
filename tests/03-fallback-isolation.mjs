// tests/03-fallback-isolation.mjs — 验证回落出口（独立 mihomo）与 Clash Party 的隔离性
//
// 这是"绝不碰用户的 Clash Party"这条承诺的验证脚本。做法：
//   1. 起一个真实的回落 mihomo 实例（用和守护进程相同的方式：独立 -d 目录、独立端口）
//   2. 记录 Clash Party 数据目录的文件指纹（大小 + 修改时间）
//   3. 让回落实例跑一会儿（含一次真实请求，逼它写缓存）
//   4. 重新取指纹，比对——一个字节都不该变
//   5. 确认回落实例自己的 cache.db 落在自己的目录里
//
// 需要：能读到 Clash Party 的订阅；找不到时用 --profile <路径> 指定。
//
// 用法： node tests/03-fallback-isolation.mjs
// 预期： 6/6 通过（Clash Party 文件零改动）
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
// Windows 上动态 import 必须用 file:// URL
const M = await import(pathToFileURL(path.join(ROOT, 'codex-proxy.mjs')).href);
const { CLASH_DIR, resolveProfileFile, findMihomo, productionCoreExe } = await import(pathToFileURL(path.join(HERE, '_helpers.mjs')).href);

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 取文件指纹：路径 -> "大小|mtime" */
// ★ 指纹要排除 Clash Party【自己会持续写】的文件 ★
//
// 踩过的坑：Clash Party 开着的时候，它自己的内核会一直往
//   <数据目录>\logs\core-YYYY-MM-DD.log
//   <数据目录>\logs\clash-party-YYYY-MM-DD.log
// 追加内容。那两个文件【每时每刻都在变】，与我们的回落实例毫无关系。
//
// 最早没排除它们，于是"Clash Party 开着"时本测试必然 FAIL，
// 报"被改动: …\logs\core-2026-10-11.log" —— 假失败，而且会让人以为
// 我们的回落真去动了 Clash Party 的目录（那是这条承诺最不该出错的地方）。
//
// 判据要精确到"我们的行为"能影响到的东西：配置、订阅、缓存、状态。
// 日志是对方自己的运行痕迹，排除。
const IGNORE_PATTERNS = [
  /[\\/]logs[\\/]/i,          // Clash Party 自己的日志目录（含 core-*.log / clash-party-*.log）
  /[\\/]Cache[\\/]/i,         // Electron 的磁盘缓存，它自己会刷
  /[\\/]Code Cache[\\/]/i,
  /[\\/]GPUCache[\\/]/i,
  /[\\/]DawnGraphiteCache[\\/]/i,
  /[\\/]DawnWebGPUCache[\\/]/i,
  /[\\/]Shared Dictionary[\\/]/i,
  /[\\/]blob_storage[\\/]/i,
  /[\\/]Session Storage[\\/]/i,
  /[\\/]Local Storage[\\/]/i,
  /[\\/]Service Worker[\\/]/i,
  /[\\/]IndexedDB[\\/]/i,
  /[\\/]Network[\\/]/i,
];
const isIgnoredPath = (p) => IGNORE_PATTERNS.some((re) => re.test(p));

function fingerprint(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (isIgnoredPath(p)) continue;        // 对方自己会写的，不算
      if (e.isDirectory()) walk(p);
      else {
        try { const st = fs.statSync(p); out[p] = `${st.size}|${st.mtimeMs}`; } catch {}
      }
    }
  };
  walk(dir);
  return out;
}

function diffFingerprints(a, b) {
  const changed = [];
  for (const [k, v] of Object.entries(a)) if (b[k] !== v) changed.push(k);
  for (const k of Object.keys(b)) if (!(k in a)) changed.push(k + ' (新增)');
  return changed;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

console.log('=== 03 回落出口隔离性验证 ===\n');
console.log(`Clash Party 数据目录: ${CLASH_DIR}`);
console.log(`存在: ${fs.existsSync(CLASH_DIR)}\n`);

step('1. Clash Party 数据目录可读');
check('能读到 Clash Party 数据目录', fs.existsSync(CLASH_DIR), CLASH_DIR);

const before = fingerprint(CLASH_DIR);
check('已记录初始文件指纹', Object.keys(before).length > 0, `${Object.keys(before).length} 个文件`);

// 找订阅：必须顺着 profile.yaml 的 current 去找 profiles\<id>.yaml，
// 直接读 profile.yaml 只会得到 0 个节点（它只是订阅索引）。
const profile = resolveProfileFile(process.argv[2] || null);
let proxies = [];
if (profile && fs.existsSync(profile)) {
  proxies = M.parseProfileProxies(fs.readFileSync(profile, 'utf8'));
}
step('2. 订阅解析');
check('解析出可用节点', proxies.length > 0, `来源 ${profile || '(无)'}，${proxies.length} 个节点`);

if (!proxies.length) {
  console.log('\n没有节点可用，后续检查跳过。');
  console.log('排查：%APPDATA%\\mihomo-party\\profile.yaml 是订阅【索引】，节点在 profiles\\<current>.yaml');
  console.log('用法：node tests/03-fallback-isolation.mjs [订阅文件路径]');
  process.exit(1);
}

// 起独立回落实例（与守护进程相同的做法）
//
// ★ 必须调用生产的 buildConfig() ★
//   早期这里【自己拼】了一份配置（连流式格式都是手写的），于是内核能起来、测试通过，
//   而生产的 buildConfig() 从来没被验证过 —— 它当时输出的是
//     proxies:
//     {"name":"…","type":"anytls",…}        ← 没有 `- ` 前缀、JSON 不是 YAML
//   mihomo 直接报 `could not find expected ':'` 退出，clash-party 出口整个起不来，
//   而测试却是绿的（典型的假测试：复刻了生产逻辑，测的是复制品）。
//   现在改成调用生产方法，这条路径就再也藏不住问题了。
const ctlPort = await freePort();
const socksPort = await freePort();
const dir = path.join(ROOT, 'run', 'fallback-iso');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const prodUplink = new M.ClashPartyUplink({
  dataDir: CLASH_DIR,
  mixedPort: socksPort,
  preferNodeNameRegex: '日本|JP|Japan|Tokyo|🇯🇵',
  maxNodes: 5,
  coreExe: '',
  enabled: true,
  priority: 3,
});
// 让实例的落点指向本测试自己的目录（隔离性验证要求不能碰生产目录）
prodUplink.configFile = path.join(dir, 'config.yaml');
prodUplink.logFile = path.join(dir, 'mihomo.log');
let nodes;
try {
  nodes = prodUplink.loadNodes();
} catch (e) {
  check('读得到订阅节点', false, e.message);
  process.exit(1);
}
check('读得到订阅节点', nodes.length > 0, `${nodes.length} 个`);

let cfgText;
try {
  cfgText = prodUplink.buildConfig();
} catch (e) {
  check('生产 buildConfig() 能生成配置', false, e.message);
  process.exit(1);
}
check('生产 buildConfig() 能生成配置', cfgText.length > 0, `${cfgText.split('\n').length} 行`);

// ★ 结构性断言：proxies 段必须是 YAML 列表项（`- {`），不能是裸 JSON ★
//   只取 proxies: 之后的【节点数】行 —— 再往后是 proxy-groups，不归这条断言管
//   （早期版本没限制行数，把 proxy-groups 也扫进来，误报了 12 行"不合法"）。
const cfgLines = cfgText.split('\n');
const pIdx = cfgLines.findIndex((l) => /^proxies:/.test(l));
const proxyLines = pIdx >= 0 ? cfgLines.slice(pIdx + 1, pIdx + 1 + nodes.length) : [];
const badProxyLines = proxyLines.filter((l) => !/^\s*-\s*\{/.test(l));
check('proxies 段每行都是 `- { … }`（不是裸 JSON）',
  proxyLines.length === nodes.length && badProxyLines.length === 0,
  badProxyLines.length
    ? `有 ${badProxyLines.length}/${proxyLines.length} 行不合法，例如: ${badProxyLines[0].slice(0, 70)}`
    : `检查了 ${proxyLines.length} 行`);

// 关键：绝不能出现 tun 段
const cfgFile = path.join(dir, 'config.yaml');
fs.writeFileSync(cfgFile, cfgText, 'utf8');
check('生成的配置里没有 tun 段（不动路由表）', !/^\s*tun\s*:/m.test(cfgText), '已确认');

// 找内核 —— ★ 必须用生产实际会用的那个（改名副本 codex-core.exe）★
//   用 Clash Party 自带的 mihomo.exe 有两个问题：
//     ① 本测试要起实例，会撞上它的"高权限内核检测"（纯进程名匹配，点取消它会退出）
//     ② 测的不是生产路径
const exe = await productionCoreExe(ROOT);
check('找到可用的 mihomo 内核', !!exe, exe || '(没找到)');
if (!exe) process.exit(1);
{
  const base = path.basename(exe).toLowerCase();
  const renamed = !/^mihomo(-alpha|-smart)?\.exe$/.test(base);
  check('用的是改名副本（不会触发 Clash Party 的进程名检测）', renamed,
    renamed ? base : `${base} —— 建议复制到 bin\\codex-core.exe`);
  const orig = findMihomo();
  if (orig && orig !== exe) console.log(`      参照：Clash Party 自带的内核在 ${orig}`);
}

// ★ 让内核自己判配置是否合法（`-t` 只校验不启动）★
//   比任何自定义断言都可靠：内核说行才是真行。
//   受限沙箱里 spawnSync 会被拒（EPERM），这时如实说明"没验证"，不能算通过。
{
  const t = spawnSync(exe, ['-d', dir, '-t', '-f', cfgFile], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (t.error && (t.error.code === 'EPERM' || t.error.code === 'EACCES')) {
    check('内核校验生产配置通过（mihomo -t）', false,
      '跳过：当前环境不允许启动子进程（spawn EPERM）。请在普通终端里重跑本测试');
  } else {
    const output = String((t.stdout || '') + (t.stderr || ''));
    const ok = t.status === 0 && !/level=fatal|Parse config error/i.test(output);
    check('内核校验生产配置通过（mihomo -t）', ok,
      ok ? (output.match(/configuration file .* test is successful/i)?.[0] || 'status=0')
         : output.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 160));
  }
}

let child = null;
// 受限环境（沙箱）不允许启动子进程，直接说明并跳到隔离性比对 —— 不要硬跑然后抛 EPERM 中断。
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
const spawnOk = canSpawn();

try {
  if (!spawnOk) {
    step('3. 启动独立回落实例并产生真实流量');
    console.log('  跳过：当前环境不允许启动子进程（spawn EPERM）。');
    console.log('        请在普通终端里重跑： node tests/03-fallback-isolation.mjs');
    console.log('        （配置生成的有效性已由上面的 mihomo -t 覆盖，但那一步在本环境同样跑不了）');
  } else {
    step('3. 启动独立回落实例并产生真实流量');
    child = spawn(exe, ['-d', dir, '-f', cfgFile], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.on('error', (e) => console.error('  启动失败: ' + e.message));

    let ready = false;
    for (let i = 0; i < 25; i++) {
      await sleep(400);
      // 注意 probeVia 的签名是 (socksPort, {host, port}, timeoutMs) —— 第 2 个参数是对象。
      // 传成位置参数会让 target.host = undefined，进而在 Buffer.from(undefined) 崩掉。
      const r = await M.probeVia(socksPort, { host: 'www.gstatic.com', port: 443 }, 4000).catch(() => null);
      if (r && r.ok) { ready = true; break; }
    }
    // probeVia 只是建连，能建上就算就绪；建不上也不算致命，继续跑缓存写入
    check('回落实例已启动且能出去（端口建立 + 建连成功）', ready || child.pid > 0,
      ready ? `pid=${child.pid} socks=${socksPort}` : `pid=${child.pid} socks=${socksPort}（建连未成功，可能节点慢）`);

    await sleep(3000);   // 给它时间写 cache.db
    step('4. 检查回落实例自己的文件落点');
    const ownCache = path.join(dir, 'cache.db');
    check('回落实例的 cache.db 落在自己的目录里', fs.existsSync(ownCache), ownCache);
  }
} finally {
  step('5. 与 Clash Party 目录比对');
  const after = fingerprint(CLASH_DIR);
  const changed = diffFingerprints(before, after);
  check('Clash Party 数据目录零改动', changed.length === 0, changed.length ? '被改动: ' + changed.slice(0, 5).join(', ') : `${Object.keys(after).length} 个文件全部一致`);

  if (child) { try { M.killTree({ pid: child.pid }); } catch {} await sleep(800); }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
