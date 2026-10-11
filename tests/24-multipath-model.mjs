// tests/24-multipath-model.mjs — "多条长连接能不能同时走不同路径"
//
// 用户的问题（原话）：
//   "如果很多个长连接请求走了不同的路径，我们能保证多个路径共同工作吗？
//    他们都能通过 17890 走吗？是不是原理是从 17891、17892、17893 等各个端口
//    都往 17890 走出去然后回来的时候再回到各个不同的端口？"
//
// 答案：能并行。机制**不是**端口回环，而是：
//   · Codex 只连 127.0.0.1:17890 这一个端口
//   · 桥接 accept 到第 k 条连接 → 给它单独开一个「上游 socket」连到【当时选中】的出口端口
//       ssh:jp → 17891   xray:jp → 17892   clash-party → 17893
//   · 两个 socket 配成一对，双向复制；回程按【socket 配对】回来，不经过端口号
//   · 17891/17892/17893 是上游 SOCKS 服务的【监听口】，是"出去的方向"
//   · 真正标识"一条连接"的是**客户端那个临时端口**（client.remotePort），不是 17890
//
// 这个测试验证：
//   1. 每条连接各自记录自己的出口、客户端端口、目标 —— 互不串
//   2. 同一时刻不同出口可以并行工作（分组后出现多组）
//   3. 记录的是**客户端临时端口**，不是服务端的 17890（踩过这个坑）
//   4. 目标主机被如实记录（CONNECT / SOCKS 两条路径都要）
//
// 用法： node tests/24-multipath-model.mjs
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

// ---------------------------------------------------------------- 假的上游 SOCKS5 出口
async function startFakeSocks() {
  const srv = net.createServer((c) => {
    c.on('error', () => {});
    c.once('data', () => {
      c.write(Buffer.from([0x05, 0x00]));
      c.once('data', (req) => {
        c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        void req;
      });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

console.log('=== 24 多路径并行模型 ===\n');

step('准备：两个假出口，桥接在它们之间按"当时选中"分流');
const upA = await startFakeSocks();   // 模拟 ssh:jp / 17891
const upB = await startFakeSocks();   // 模拟 clash-party / 17893

let current = { name: 'A', port: upA.port };
const bridge = new M.Bridge(() => current);
bridge.cfg = { health: { connIdleMaxSec: 1800 } };
await bridge.listen(0, 1);
const bridgePort = bridge.server.address().port;

// 走真实 SOCKS 握手建连（桥接的 onConnection 会把第一条数据当握手解析）
async function connectTo(targetHost, targetPort) {
  const sock = await M.socksConnect(bridgePort, targetHost, targetPort, 8000);
  sock.on('error', () => {});
  sock.on('data', () => {});
  return sock;
}

step('1. 先经出口 A 建两条连接（不同目标）');
const a1 = await connectTo('api.openai.com', 443);
const a2 = await connectTo('chatgpt.com', 443);
await sleep(250);
check('两条连接都记进了 conns 表', bridge.conns.size === 2, `实际 ${bridge.conns.size}`);
const recs1 = [...bridge.conns];
check('两条都标在出口 A 上', recs1.every((r) => r.uplink === 'A'), recs1.map((r) => r.uplink).join(','));
check('目标主机被如实记录（不是空）',
  recs1.some((r) => String(r.target).includes('api.openai.com')) &&
  recs1.some((r) => String(r.target).includes('chatgpt.com')),
  recs1.map((r) => r.target).join(' , '));

step('2. ★ 关键：记录的是客户端临时端口，不是服务端的 17890 ★');
// 桥接这次监听在随机端口上；无论如何，绝不能是【服务端】那个端口
check('clientPort 不等于桥接的监听端口（取错了端就是这个值）',
  recs1.every((r) => r.clientPort !== bridgePort),
  `clientPort=${recs1.map((r) => r.clientPort).join(',')} 服务端=${bridgePort}`);
check('两条连接的 clientPort 互不相同（各自的身份）',
  new Set(recs1.map((r) => r.clientPort)).size === 2,
  recs1.map((r) => r.clientPort).join(','));
check('clientPort 是合法端口号', recs1.every((r) => Number.isInteger(r.clientPort) && r.clientPort > 0));

step('3. ★ 切到出口 B，再建两条 —— 形成"多路径并行" ★');
current = { name: 'B', port: upB.port };
const b1 = await connectTo('codex-cloud-backend.chatgpt.com', 443);
const b2 = await connectTo('api.openai.com', 443);
await sleep(250);
const recs2 = [...bridge.conns];
check('现在共 4 条连接', recs2.length === 4, `实际 ${recs2.length}`);

const byUplink = new Map();
for (const r of recs2) {
  if (!byUplink.has(r.uplink)) byUplink.set(r.uplink, []);
  byUplink.get(r.uplink).push(r);
}
check('★ 同时存在两个出口，各自都有连接（并行工作的直接证据）★',
  byUplink.size === 2, `出口: ${[...byUplink.keys()].join(', ')}`);
check('出口 A 仍然是 2 条（旧连接没被迁走、也没被断）',
  (byUplink.get('A') || []).length === 2, `${(byUplink.get('A') || []).length} 条`);
check('出口 B 是 2 条（新建的走新出口）',
  (byUplink.get('B') || []).length === 2, `${(byUplink.get('B') || []).length} 条`);
check('旧连接仍然活着（切换不动已建立的连接）',
  !a1.destroyed && !a2.destroyed, '');

step('4. 每条连接的端口与目标都是一一对应的，没有串');
const all = [...byUplink.values()].flat();
check('4 条连接的 clientPort 全不相同',
  new Set(all.map((r) => r.clientPort)).size === 4, all.map((r) => r.clientPort).join(','));
check('每条都有 target（没有丢目标）', all.every((r) => r.target), all.map((r) => r.target).join(' , '));
check('target 里带端口（形如 host:443）', all.every((r) => /:\d+$/.test(String(r.target))));

step('5. 静态核对：三处 pipe 调用都传了 target；state 里带 clientPort 与 target');
const fs = await import('node:fs');
const mjs = fs.readFileSync(path.join(ROOT, 'codex-proxy.mjs'), 'utf8');
check('pipe 的签名支持 target', /pipe\(client, upstream, uplinkName, target = null\)/.test(mjs), '');
const pipeCalls = (mjs.match(/this\.pipe\(client, upstream, up\.name, `/g) || []).length;
check('三处调用点都传了目标', pipeCalls === 3, `实际 ${pipeCalls} 处`);
check('clientPort 取的是 remotePort（不是 localPort）',
  /client\.remotePort \?\? null/.test(mjs) && !/client\.localPort \?\? null/.test(mjs), '');
check('writeState 里带 clientPort 与 target',
  /clientPort: r\.clientPort/.test(mjs) && /target: r\.target/.test(mjs), '');
check('有 conns 命令并在命令表里注册',
  /function cmdConns\(\)/.test(mjs) && /case 'conns': return cmdConns\(\)/.test(mjs), '');

// ---------------------------------------------------------------- 清理
for (const s of [a1, a2, b1, b2]) { try { s.destroy(); } catch {} }
await sleep(100);
try { bridge.server.close(); } catch {}
await upA.close();
await upB.close();

console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
