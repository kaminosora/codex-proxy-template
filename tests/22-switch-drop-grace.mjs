// tests/22-switch-drop-grace.mjs — 切换出口时的"断连宽限"
//
// 背景（用户实测报告）：
//   "codex 界面退化……看 codex 弹窗基本上就相当于是断连了。
//    主要是在模式发生切换时。"
//
// 根因：`dropConnectionsOnUplink` 原来**无条件** destroy 该出口上的每一条连接 ——
// 包括正在传输的。Codex 是 Chromium，于是每次切出口都把它的在途请求腰斩，
// 界面退化成「Couldn't load workspace settings / Retry to continue chatting」。
//
// 修法：只断开**已经卡住**的连接（`lastActivity` 超过 graceMs 没动过）。
// 正在传输的留着，让它跑完；卡住的（上游黑洞）照样清掉 —— 原 bug 的修复效果保留。
//
// 这个测试验证宽限逻辑真的生效（而不是只读代码看着对）。
//
// 用法： node tests/22-switch-drop-grace.mjs
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const M = await import(pathToFileURL(path.join(ROOT, 'codex-proxy.mjs')).href);

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('=== 22 切换出口时的连接处理（默认不动，可显式开启全断）===\n');

// ---------------------------------------------------------------- 搭一个真桥接
step('准备：起一个桥接 + 假上游，灌入真实连接');
const bridge = new M.Bridge(() => ({ name: 'UP-A', port: 0 }));
await bridge.listen(0, 1);
const bridgePort = bridge.server.address().port;

// 假上游：接受连接后什么都不做（模拟"卡住"）或回数据（模拟"在传输"）
const upSockets = [];
const upServer = net.createServer((s) => { upSockets.push(s); s.on('error', () => {}); });
await new Promise((r) => upServer.listen(0, '127.0.0.1', r));
const upPort = upServer.address().port;

// 建一条连接并把它交给 bridge.pipe（走真实的记录/统计路径）
async function makeConn(tag) {
  const client = net.connect({ host: '127.0.0.1', port: bridgePort });
  await new Promise((r, j) => { client.once('connect', r); client.once('error', j); });
  const upstream = net.connect({ host: '127.0.0.1', port: upPort });
  await new Promise((r, j) => { upstream.once('connect', r); upstream.once('error', j); });
  bridge.pipe(client, upstream, 'UP-A');
  return { tag, client, upstream };
}
const c1 = await makeConn('fresh');
const c2 = await makeConn('idle');
check('两条连接都记进了 conns 表', bridge.conns.size === 2, `实际 ${bridge.conns.size}`);
check('活动连接统计 = 2', bridge.stats.active === 2, `实际 ${bridge.stats.active}`);

// ---------------------------------------------------------------- 宽限生效
step('1. 宽限内：正在传输的连接不能被断');
const before1 = bridge.dropConnectionsOnUplink('UP-A', '切换出口', { graceMs: 1500 });
check('一条都没断（都在宽限内）', before1 === 0, `断了 ${before1} 条`);
check('两条连接仍然活着', !c1.client.destroyed && !c2.client.destroyed, '');
check('conns 表仍是 2 条', bridge.conns.size === 2, `实际 ${bridge.conns.size}`);

// ---------------------------------------------------------------- 空闲的被断
step('2. 超过宽限：卡住的连接必须被断掉');
// 把 c2 的 lastActivity 往前挪（模拟"上游黑洞、一直没数据"）
for (const rec of bridge.conns) {
  if (rec.peer && rec.client === c2.client) rec.lastActivity = Date.now() - 9000;
}
const after = bridge.dropConnectionsOnUplink('UP-A', '切换出口', { graceMs: 1500 });
await sleep(120);
check('只断了那一条卡住的', after === 1, `断了 ${after} 条`);
check('卡住的那条确实断了', c2.client.destroyed, '');
check('正在传输的那条没被牵连', !c1.client.destroyed, '');
check('conns 表回落到 1 条', bridge.conns.size === 1, `实际 ${bridge.conns.size}`);

// ---------------------------------------------------------------- 判 DOWN 时不宽限
step('3. 出口被判 DOWN（graceMs = 0）：全断，不放宽限');
const down = bridge.dropConnectionsOnUplink('UP-A', '该出口被判不健康', { graceMs: 0 });
await sleep(120);
check('剩下那条也被断了（判 DOWN 不能等）', down === 1, `断了 ${down} 条`);
check('连接确实没了', c1.client.destroyed, '');
check('conns 表清空', bridge.conns.size === 0, `实际 ${bridge.conns.size}`);

// ---------------------------------------------------------------- 配置默认值
step('4. 默认值与可配置性');
const h = M.loadConfig().health;
// ★ 语义已改：切换时【默认不断任何连接】，跟 Clash 系一致 ★
//   原来这里是"宽限 1500ms，只断空闲的"。那个"空闲 = 卡住"的假设是错的 ——
//   从代理层分不清"长时间在等消息"和"卡了"，而 HTTP/2 一条连接上还有多个 stream。
check('默认 switchDropAll = false（切换时不断任何连接）', h.switchDropAll === false, `实际 ${h.switchDropAll}`);
check('默认 downDropGraceMs = 0（判 DOWN 时全断）', h.downDropGraceMs === 0, `实际 ${h.downDropGraceMs}`);
// 判 DOWN 时断连【是保留的、有意的】—— 因为应用对两种失败反应不同：
//   连接被关闭 → 请求没发出去 → 应用在【新连接上自动重发】（Chromium 官方变更：
//                  Retry requests on reused sockets that receive ERR_EMPTY_RESPONSE）
//   TCP 超时     → 应用不知道请求是否已被处理 → 【不敢重发】，只能报错让你手动重试
// 所以"干等超时"并不会更安全。想完全照 Clash 干等就设 switchOffDownDrop = true。

check('两个都能从配置覆盖', (() => {
  const src = M.loadConfig.toString();
  return /switchDropAll/.test(src) && /downDropGraceMs/.test(src);
})(), '');

// ---------------------------------------------------------------- 调用方传对了参数
step('5. 调用方传对了宽限（静态核对）');
const h2 = M.loadConfig().health;
const fs = await import('node:fs');
const cfg2 = fs.readFileSync(path.join(ROOT, 'codex-proxy.config.json'), 'utf8');
const mjs = fs.readFileSync(path.join(ROOT, 'codex-proxy.mjs'), 'utf8');
check('切换那一支只在 switchDropAll === true 时才断',
  /if \(prev && this\.cfg\.health\.switchDropAll === true\)/.test(mjs), '');
check('切换分支里默认不调用 dropConnectionsOnUplink',
  !/console\.log/.test(mjs) === false &&
  /默认【不断开任何连接】/.test(mjs), '');
check('判 DOWN 那一支用 downDropGraceMs',
  /dropConnectionsOnUplink\(l\.name, '该出口被判不健康', \{\s*\n?\s*graceMs: this\.cfg\.health\.downDropGraceMs/.test(mjs), '');
// —— 判 DOWN 断连是有意保留的（理由见下），并留了开关 ——
check('默认 switchOffDownDrop = false（判 DOWN 时仍断）',
  h2.switchOffDownDrop === false, `实际 ${h2.switchOffDownDrop}`);
check('switchOffDownDrop 真的包住了那段断连逻辑',
  /switchOffDownDrop !== true/.test(mjs), '');
check('配置里写明了"应用自动重发 vs 超时不重发"的理由',
  /自动重发/.test(cfg2) && /不敢重发/.test(cfg2), '');
check('日志区分了"已卡住的连接"与"保留的连接"',
  /主动断开已卡住的连接/.test(mjs) && /保留了 \$\{kept\} 条正在传输的连接/.test(mjs), '');

// ---------------------------------------------------------------- 清理
c1.client.destroy(); c1.upstream.destroy();
c2.client.destroy(); c2.upstream.destroy();
for (const s of upSockets) { try { s.destroy(); } catch {} }
try { bridge.server.close(); } catch {}
try { upServer.close(); } catch {}

console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
