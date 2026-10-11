// tests/13-uplink-accounting.mjs — 验证"切换时流量实际走了哪条"可被观测
//
// 背景（用户的实际疑问）：
//   "我想验证在切换出口时实际 codex 流量的走向走了哪个，有办法验证吗？"
//   能。桥接层在【连接建立】时就记下该连接用了哪个出口，并按出口累计流量。
//   status 里那张"各出口实际承载的流量"表就是证据。
//
// 本测试用假上游（不碰真网络）验证这套记账：
//   1) 连接建立时归属正确（走 A 的连接记在 A 上）
//   2) 字节数按方向正确累计（上行=客户端→目标，下行=目标→客户端）
//   3) 切换出口后，新连接记到新出口，旧出口的累计值不变
//   4) 连接关闭时 active 正确回落，connects/closed 递增
//   5) 未使用过的出口不出现在表里（不会凭空造出 0 行）
//   6) 双向都触发 close 时不会重复计数（半关闭场景）
//
// 用法： node tests/13-uplink-accounting.mjs
// 预期： 7/7 通过
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { Bridge, socksConnect } = await import(pathToFileURL(path.join(ROOT, 'codex-proxy.mjs')).href);

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 假的「上游出口」：把连接转到本地 echo
async function startEchoUplink(tag) {
  const echo = net.createServer((c) => {
    c.on('error', () => {});
    c.on('data', (d) => c.write(Buffer.concat([Buffer.from(`[${tag}]`), d])));   // 回显并打标记
  });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = echo.address().port;

  const socks = net.createServer((c) => {
    let st = 'greet', buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (st === 'greet') {
        if (buf.length < 2) return;
        const gl = 2 + buf[1];
        if (buf.length < gl) return;
        c.write(Buffer.from([0x05, 0x00]));
        buf = buf.subarray(gl); st = 'req';
      }
      if (st === 'req') {
        if (buf.length < 10) return;
        st = 'pipe';
        const rest = buf.subarray(10);
        buf = Buffer.alloc(0);
        const up = net.connect({ host: '127.0.0.1', port: echoPort }, () => {
          c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (rest.length) up.write(rest);
          c.pipe(up); up.pipe(c);
        });
        up.on('error', () => c.destroy());
      }
    });
  });
  await new Promise((r) => socks.listen(0, '127.0.0.1', r));
  return {
    port: socks.address().port,
    close: async () => { await new Promise((r) => socks.close(r)); await new Promise((r) => echo.close(r)); },
  };
}

/** 经桥接发一段数据并读回，返回收到的内容 */
async function roundTrip(bridgePort, payload, tag) {
  const sock = await socksConnect(bridgePort, 'example.test', 443, 8000);
  sock.on('error', () => {});
  const chunks = [];
  sock.on('data', (d) => chunks.push(d));
  await sleep(80);
  sock.write(Buffer.from(payload));
  await sleep(250);
  const got = Buffer.concat(chunks).toString();
  sock.destroy();
  await sleep(120);
  return got;
}

console.log('=== 13 出口流量记账（回答"切换后流量走了哪条"）===\n');

const upA = await startEchoUplink('A');
const upB = await startEchoUplink('B');

let activeName = 'uplink-A';
let active = { name: activeName, port: upA.port };
const bridge = new Bridge(() => active);
const bp = await bridge.listen(0);
console.log(`桥接端口 ${bp}｜出口A=${upA.port}｜出口B=${upB.port}\n`);

// ---------------------------------------------------------------- 1~2
step('1~2. 连接建立时归属正确，字节按方向累计');
{
  const r1 = await roundTrip(bp, 'HELLO-ONE');
  check('数据确实经过了出口 A', r1.includes('[A]') && r1.includes('HELLO-ONE'), JSON.stringify(r1));

  const by = bridge.stats.byUplink;
  check('uplink-A 出现在统计里', !!by['uplink-A'], Object.keys(by).join(','));
  check('uplink-A 连接数为 1', by['uplink-A']?.connects === 1, `connects=${by['uplink-A']?.connects}`);
  check('uplink-A 上行字节 = 9（"HELLO-ONE"）', by['uplink-A']?.bytesUp === 9, `bytesUp=${by['uplink-A']?.bytesUp}`);
  check('uplink-A 下行字节 > 上行（含 [A] 前缀）', (by['uplink-A']?.bytesDown ?? 0) > 9, `bytesDown=${by['uplink-A']?.bytesDown}`);
  check('未使用过的 uplink-B 不出现在统计里', !by['uplink-B'], Object.keys(by).join(','));
}

// ---------------------------------------------------------------- 3
step('3. 切换出口后，新连接记到新出口，旧出口累计值不变');
{
  const beforeA = { ...bridge.stats.byUplink['uplink-A'] };
  active = { name: 'uplink-B', port: upB.port };          // 切换
  const r2 = await roundTrip(bp, 'HELLO-TWO');
  check('切换后数据经过出口 B', r2.includes('[B]') && r2.includes('HELLO-TWO'), JSON.stringify(r2));

  const by = bridge.stats.byUplink;
  check('uplink-B 出现在统计里', !!by['uplink-B'], Object.keys(by).join(','));
  check('uplink-B 连接数为 1', by['uplink-B']?.connects === 1, `connects=${by['uplink-B']?.connects}`);
  check('uplink-A 的连接数没变（新连接不记到它头上）',
    by['uplink-A']?.connects === beforeA.connects, `before=${beforeA.connects} after=${by['uplink-A']?.connects}`);
  check('uplink-A 的字节数也没变',
    by['uplink-A']?.bytesUp === beforeA.bytesUp && by['uplink-A']?.bytesDown === beforeA.bytesDown,
    `up ${beforeA.bytesUp}->${by['uplink-A']?.bytesUp}, down ${beforeA.bytesDown}->${by['uplink-A']?.bytesDown}`);

  // 再走一批 B 的流量，A 仍应保持不变
  await roundTrip(bp, 'HELLO-THREE');
  await roundTrip(bp, 'HELLO-FOUR');
  const by2 = bridge.stats.byUplink;
  check('继续走 B 时 A 完全静止（清晰区分切换前后的归属）',
    by2['uplink-A']?.connects === beforeA.connects && by2['uplink-B']?.connects === 3,
    `A=${by2['uplink-A']?.connects} B=${by2['uplink-B']?.connects}`);
}

// ---------------------------------------------------------------- 4
step('4. 连接关闭时 active 回落、closed 递增');
{
  const by = bridge.stats.byUplink;
  const a = by['uplink-A'], b = by['uplink-B'];
  check('两个出口的 active 都已回落到 0', a?.active === 0 && b?.active === 0,
    `A.active=${a?.active} B.active=${b?.active}`);
  check('closed 与 connects 相等（每个连接都只计一次关闭）',
    a?.closed === a?.connects && b?.closed === b?.connects,
    `A ${a?.closed}/${a?.connects}  B ${b?.closed}/${b?.connects}`);
}

// ---------------------------------------------------------------- 6
step('6. 半关闭场景不重复计数');
{
  // 注意：step 3 已把出口切到 B，所以这里的新连接会记到 B 头上。别去看 A。
  const key = 'uplink-B';
  const before = { ...bridge.stats.byUplink[key] };
  const sock = await socksConnect(bp, 'example.test', 443, 8000);
  sock.on('error', () => {});
  await sleep(80);
  sock.write(Buffer.from('X'));
  await sleep(150);
  sock.destroy();                       // 只让客户端先关，触发一次 'close'
  await sleep(400);
  const after = bridge.stats.byUplink[key];
  check('一次连接只让 closed 增加 1（双向 close 不重复计）',
    after.closed === before.closed + 1, `${before.closed} -> ${after.closed}`);
  check('connects 也只增加 1', after.connects === before.connects + 1,
    `${before.connects} -> ${after.connects}`);
  check('active 回落到 0（没有泄漏的活动计数）', after.active === 0, `active=${after.active}`);
}

console.log('\n=== 记账快照 ===');
for (const [name, u] of Object.entries(bridge.stats.byUplink)) {
  console.log(`  ${name.padEnd(12)} 连接 ${u.connects}  活动 ${u.active}  上行 ${u.bytesUp}B  下行 ${u.bytesDown}B`);
}

console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);

await bridge.close();
await upA.close();
await upB.close();
process.exit(pass === results.length ? 0 : 1);
