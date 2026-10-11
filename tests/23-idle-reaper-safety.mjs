// tests/23-idle-reaper-safety.mjs — 空闲清理不能误杀 Codex 的长连接
//
// 背景（用户实测 + 日志实证）：
//   直接 `app` 启动 Codex，**没有发生任何出口切换**，界面就是退化的
//   （「Couldn't load workspace settings / Retry to continue chatting」）。
//   日志里对得上：
//     [warn] 空闲超时（134s 无数据）主动断开：…:61429 @ ssh:jp
//     [warn] 空闲超时（135s 无数据）主动断开：…:61431 @ ssh:jp
//
// 根因：`reapIdleConnections` 原来一刀切 —— 任何连接 120 秒没数据就杀。
//   Codex 是 Chromium，它的 WebSocket / 服务端推送 / HTTP/2 复用连接
//   **正常就是"长时间没有应用层数据"**（在等推送），却被当成"卡死"杀掉。
//
// 修法：要求【同时】满足才清
//   ① 空闲超过 connIdleTimeoutSec（默认从 120 改成 600 秒）
//   ② 这条连接从来没传过任何字节（bytes === 0）
//   ③ 或空闲超过 connIdleMaxSec（默认 1800 秒）的上限兜底
//
// ★ 这个测试为什么不走桥接的握手入口 ★
//   试过两条路，都被证明不可靠：
//   · 直接 net.connect 到桥接端口再 write —— onConnection 会把第一条数据
//     当握手解析（SOCKS5/HTTP CONNECT），数据被吃掉，rec.bytes 恒为 0。
//   · 走 socksConnect 真握手 —— 能建连，但 socksConnect 返回的是客户端那侧的
//     socket，跟 rec.client 不是同一个对象；而且两端握手字节都会记账，
//     两条连接的字节数都非 0，分不清谁是谁。
//   而 reapIdleConnections 的判据只依赖 rec.lastActivity / rec.bytes /
//   rec.client —— 全部由 pipe() 建立和维护。所以这里直接用两个【自己掌控的
//   socket 对】喂给 pipe()，反而更贴近被测逻辑、也更能确定地构造场景。
//
// 用法： node tests/23-idle-reaper-safety.mjs
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// 造一对连通的 socket：一端当 rec.client，另一端当 rec.upstream。
// 往任一侧写，另一侧就收到 —— 两边都在我手里，能确定地控制"有没有数据流过"。
async function socketPair() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const upstreamSide = new Promise((res) => srv.once('connection', (s) => { s.on('error', () => {}); res(s); }));
  const clientSide = net.connect({ host: '127.0.0.1', port });
  clientSide.on('error', () => {});
  await new Promise((r) => clientSide.once('connect', r));
  const us = await upstreamSide;
  srv.close();
  return { clientSide, upstreamSide: us };
}

console.log('=== 23 空闲清理的安全性（不误杀长连接）===\n');

step('准备：起桥接，喂两条连接给它（一条会传数据、一条不会）');
const bridge = new M.Bridge(() => ({ name: 'UP-A', port: 0 }));
bridge.cfg = { health: { connIdleMaxSec: 1800 } };   // reaper 从这里取上限
await bridge.listen(0, 1);

const pairA = await socketPair();
const pairB = await socketPair();
bridge.pipe(pairA.clientSide, pairA.upstreamSide, 'UP-A');   // 稍后会传数据
bridge.pipe(pairB.clientSide, pairB.upstreamSide, 'UP-A');   // 全程不传
await sleep(120);

check('两条连接都记进 conns 表', bridge.conns.size === 2, `实际 ${bridge.conns.size}`);
const recs = [...bridge.conns];
const recA = recs.find((r) => r.client === pairA.clientSide);
const recB = recs.find((r) => r.client === pairB.clientSide);
check('能按 socket 精确定位到两条记录', !!recA && !!recB && recA !== recB, '');
check('初始两条的 bytes 都是 0', (recA?.bytes || 0) === 0 && (recB?.bytes || 0) === 0,
  `a=${recA?.bytes} b=${recB?.bytes}`);

// 只让 A 传数据（双向都过一遍，rec.bytes 两端都算）
pairA.upstreamSide.write('PUSH-FROM-UPSTREAM');
pairA.clientSide.write('REQ-FROM-CLIENT');
await sleep(250);
check('A 的 bytes > 0（它的确工作过）', (recA?.bytes || 0) > 0, `bytes=${recA?.bytes}`);
check('B 的 bytes 仍是 0（它从未传过）', (recB?.bytes || 0) === 0, `bytes=${recB?.bytes}`);

// ---------------------------------------------------------------- 核心：传过数据的不杀
step('1. ★ 传过数据的连接：即使空闲很久也不能杀 ★');
recA.lastActivity = Date.now() - 300 * 1000;   // 空闲 5 分钟（远超旧的 120 秒阈值）
const n1 = bridge.reapIdleConnections(120 * 1000);   // 故意用旧阈值 120 秒
await sleep(150);
check('一条都没杀（虽然它已经空闲 5 分钟）', n1 === 0, `杀了 ${n1} 条`);
check('A 仍然活着（这是这次 bug 的核心）', recA && !recA.client.destroyed, '');
check('conns 表没变', bridge.conns.size === 2, `实际 ${bridge.conns.size}`);

// ---------------------------------------------------------------- 从未传数据的可杀
step('2. 从未传过数据的连接：超过阈值可以清掉');
recB.lastActivity = Date.now() - 700 * 1000;   // 空闲 700 秒 > 600 秒阈值
const n2 = bridge.reapIdleConnections(600 * 1000);
await sleep(200);
check('清掉了那一条（从未传过数据）', n2 === 1, `清了 ${n2} 条`);
check('B 确实被清掉', recB && recB.client.destroyed, '');
check('A 依然没被牵连', recA && !recA.client.destroyed, '');

// ---------------------------------------------------------------- 上限兜底
step('3. 传过数据的连接：超过 connIdleMaxSec 上限才被清（兜底）');
recA.lastActivity = Date.now() - 2000 * 1000;   // 空闲 2000 秒 > 1800 秒上限
const n3 = bridge.reapIdleConnections(600 * 1000);
await sleep(200);
check('超过上限后被清掉（兜底生效，不会永久堆积）', n3 === 1, `清了 ${n3} 条`);
check('A 被清掉', recA && recA.client.destroyed, '');
check('conns 表清空', bridge.conns.size === 0, `实际 ${bridge.conns.size}`);

// ---------------------------------------------------------------- 默认值
step('4. 默认阈值必须足够保守');
const h = M.loadConfig().health;
check('connIdleTimeoutSec ≥ 600 秒（原来是 120，误杀长连接）',
  Number(h.connIdleTimeoutSec) >= 600, `实际 ${h.connIdleTimeoutSec}`);
check('connIdleMaxSec 有上限兜底', Number(h.connIdleMaxSec) >= 1800, `实际 ${h.connIdleMaxSec}`);
const fs = await import('node:fs');
const cfgRaw = fs.readFileSync(path.join(ROOT, 'codex-proxy.config.json'), 'utf8');
// 说明文字里要留下"为什么必须保守"的教训，否则以后有人又会把它调回 120 秒
check('配置文件里写明了"必须保守"的原因（提到长连接被误杀）',
  /必须保守/.test(cfgRaw) && /长连接/.test(cfgRaw) && /当成“卡死”杀了/.test(cfgRaw), '');
check('0 表示关闭（保持原有语义）', bridge.reapIdleConnections(0) === 0, '');

// ---------------------------------------------------------------- 静态核对
step('5. 实现里同时检查了字节数与上限（静态）');
const mjs = fs.readFileSync(path.join(ROOT, 'codex-proxy.mjs'), 'utf8');
check('判据里用了 rec.bytes', /\(rec\.bytes \|\| 0\) > 0 && idle < maxIdleMs/.test(mjs), '');
check('上限取自 connIdleMaxSec', /connIdleMaxSec \?\? 1800/.test(mjs), '');
check('日志区分"从未传过数据"与"超过上限"',
  /从未传过数据/.test(mjs) && /空闲超过上限/.test(mjs), '');
check('启动日志不再宣称"120s 就断"',
  !/空闲连接清理已启用：\$\{idleSec\}s 无数据则断开（逼客户端重连）/.test(mjs) &&
  /且从未传过字节/.test(mjs), '');

// ---------------------------------------------------------------- 清理
for (const p of [pairA, pairB]) {
  try { p.clientSide.destroy(); } catch {}
  try { p.upstreamSide.destroy(); } catch {}
}
try { bridge.server.close(); } catch {}

console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
