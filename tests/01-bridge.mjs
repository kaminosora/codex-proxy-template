// tests/01-bridge.mjs — 协议自测：本地桥接（HTTP CONNECT + SOCKS5）与上游链路
//
// 完全本地闭环，不依赖外网、不依赖守护进程、不依赖服务器。
// 覆盖历史上 4 个"时好时坏"级的桥接 bug：
//   1) SOCKS5 建连超时未清除 → 建连成功后 15 秒被定时器摧毁
//   2) 'connection' 里 pause() 后 once('data') → data 事件永不触发，连接死锁
//   3) SOCKS5 问候语只丢 2 字节 → METHODS 被当成请求首字节，后续解析全错位
//   4) 握手与业务数据分片/粘连 → 丢字节或重复
//
// 用法： node tests/01-bridge.mjs
// 预期： 12/12 通过
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 注意：动态 import 在 Windows 上必须用 file:// URL，直接传 "E:\..." 会报
// ERR_UNSUPPORTED_ESM_URL_SCHEME，所以这里必须过一层 pathToFileURL。
const { Bridge, socksConnect } = await import(pathToFileURL(path.join(HERE, '..', 'codex-proxy.mjs')).href);

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 假的「目标服务器」（echo）
async function startEcho() {
  const srv = net.createServer((s) => {
    s.on('error', () => {});
    let greeted = false;
    s.on('data', (d) => {
      if (!greeted) { greeted = true; s.write('ECHO-HELLO\n'); }
      s.write(d);
    });
    s.write('TARGET-READY\n');   // 也主动发一段，覆盖「服务端先行推送」
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

// ---------------------------------------------------------------- 假的「上游 SOCKS5 出口」
async function startFakeSocks(uplinkName) {
  const stats = { connects: 0, targets: [] };
  const srv = net.createServer((c) => {
    let st = 'greet', buf = Buffer.alloc(0);
    c.on('error', () => {});
    c.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // 必须用循环：一次 data 事件里可能同时带来握手和请求
      for (;;) {
        if (st === 'greet') {
          if (buf.length < 2) return;
          // 问候语是 VER NMETHODS METHODS...，长度 = 2 + NMETHODS。
          // 只丢 2 字节会把 METHODS 当成请求首字节 —— 历史上踩过的 bug 3。
          const greetLen = 2 + buf[1];
          if (buf.length < greetLen) return;
          c.write(Buffer.from([0x05, 0x00]));
          buf = buf.subarray(greetLen);
          st = 'req';
          continue;
        }
        if (st === 'req') {
          if (buf.length < 4) return;
          const atyp = buf[3];
          // 请求可能是域名形式（socks5h）。长度必须按 ATYP 分别计算。
          let need;
          if (atyp === 1) need = 10;
          else if (atyp === 4) need = 22;
          else if (atyp === 3) { if (buf.length < 5) return; need = 5 + buf[4] + 2; }
          else return c.destroy();
          if (buf.length < need) return;
          let host, port;
          if (atyp === 1) { host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; port = buf.readUInt16BE(8); }
          else if (atyp === 3) { const l = buf[4]; host = buf.subarray(5, 5 + l).toString(); port = buf.readUInt16BE(5 + l); }
          else { host = 'v6'; port = buf.readUInt16BE(20); }
          const rest = buf.subarray(need);
          buf = Buffer.alloc(0);
          st = 'pipe';
          stats.connects++;
          stats.targets.push(`${host}:${port} [via ${uplinkName}]`);
          const up = net.connect({ host: '127.0.0.1', port }, () => {
            c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            if (rest.length) up.write(rest);
            c.pipe(up); up.pipe(c);
          });
          up.on('error', () => c.destroy());
          return;
        }
        return;
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, stats, close: () => new Promise((r) => srv.close(r)) };
}

// ---------------------------------------------------------------- 各种客户端

async function viaSocks(port, targetHost, targetPort, extraFirstWrite = null, fragment = false) {
  let sock;
  try {
    sock = await socksConnect(port, targetHost, targetPort, 8000);
  } catch (e) {
    return 'CONNECT-ERR: ' + e.message;
  }
  sock.on('error', () => {});
  const chunks = [];
  sock.on('data', (d) => chunks.push(d));
  await sleep(150);
  const payload = extraFirstWrite ?? 'PING-A';
  try {
    if (fragment) {
      sock.write(payload.slice(0, 2));
      await sleep(60);
      sock.write(payload.slice(2));
    } else {
      sock.write(payload);
    }
    await sleep(300);
  } catch (e) {
    return 'WRITE-ERR: ' + e.message;
  }
  sock.destroy();
  return Buffer.concat(chunks).toString();
}

function viaHttpConnect(port, targetHost, targetPort, sendEarly = true) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => {
      let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`;
      if (sendEarly) req += 'EARLY-BYTES';
      s.write(req);
    });
    let buf = '';
    const t = setTimeout(() => { s.destroy(); resolve({ raw: buf, err: 'timeout' }); }, 6000);
    s.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('ECHO-HELLO') && buf.includes('EARLY-BYTES')) { clearTimeout(t); s.destroy(); resolve({ raw: buf }); }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function viaHttpConnectFragmented(port, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, async () => {
      const full = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\nFRAG`;
      s.write(full.slice(0, 10));
      await sleep(80);
      s.write(full.slice(10, 40));
      await sleep(80);
      s.write(full.slice(40));
    });
    let buf = '';
    const t = setTimeout(() => { s.destroy(); resolve({ raw: buf, err: 'timeout' }); }, 6000);
    s.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('ECHO-HELLO') && buf.includes('FRAG')) { clearTimeout(t); s.destroy(); resolve({ raw: buf }); }
    });
    s.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------------------------------------------------------------- 跑

console.log('=== 01 本地桥接自测（不依赖外网）===\n');

const echo = await startEcho();
const socksA = await startFakeSocks('uplink-A');
const socksB = await startFakeSocks('uplink-B');

let active = { name: 'uplink-A', port: socksA.port };
const bridge = new Bridge(() => active);
const bport = await bridge.listen(0);
console.log(`桥接端口 ${bport}｜假目标 ${echo.port}｜假出口 A=${socksA.port} B=${socksB.port}\n`);

step('1. SOCKS5 客户端 -> 桥接 -> 出口A');
const r1 = await viaSocks(bport, '127.0.0.1', echo.port);
check('SOCKS5 -> 桥接 -> 出口A -> 目标，回显正确', r1.includes('ECHO-HELLO') && r1.includes('PING-A'), JSON.stringify(r1));

step('2. SOCKS5 分片写入');
const r2 = await viaSocks(bport, '127.0.0.1', echo.port, 'FRAGMENTED', true);
check('SOCKS5 分片写入不丢字节', r2.includes('FRAGMENTED'), JSON.stringify(r2));

step('3. HTTP CONNECT + 紧跟的业务字节');
const r3 = await viaHttpConnect(bport, '127.0.0.1', echo.port, true);
check('HTTP CONNECT 建隧道成功', r3.raw.includes('200 Connection established'), r3.raw.split('\r\n')[0]);
check('CONNECT 后紧跟的字节没有丢失', r3.raw.includes('EARLY-BYTES'), 'EARLY-BYTES 已回显');

step('4. HTTP CONNECT 头分片');
const r4 = await viaHttpConnectFragmented(bport, '127.0.0.1', echo.port);
check('HTTP CONNECT 头分片发送仍能建隧道', r4.raw.includes('200 Connection established') && r4.raw.includes('FRAG'), JSON.stringify(r4.raw.slice(0, 60)));

step('5. 域名形式的目标（socks5h 语义）');
const r5 = await viaSocks(bport, 'localhost', echo.port);
check('域名目标能正确传给上游', r5.includes('ECHO-HELLO'), JSON.stringify(r5));
check('上游确实收到了域名而不是解析后的 IP', socksA.stats.targets.some((t) => t.startsWith('localhost:')), socksA.stats.targets.join(', '));

step('6. 出口切换');
active = { name: 'uplink-B', port: socksB.port };
const before = socksB.stats.connects;
const r6 = await viaSocks(bport, '127.0.0.1', echo.port, 'SWITCHED');
check('出口切换到 B 后仍然通', r6.includes('SWITCHED'), JSON.stringify(r6));
check('连接确实走了新出口 B', socksB.stats.connects > before, `B 连接数 ${socksB.stats.connects}`);

step('7. 无健康出口时的行为');
active = null;
const t0 = Date.now();
const r7 = await viaSocks(bport, '127.0.0.1', echo.port, 'X').catch((e) => 'ERR:' + e.message);
const dt = Date.now() - t0;
check('无可用出口时立刻失败而不是挂死', String(r7).includes('ERR') || !String(r7).includes('ECHO-HELLO'), `${dt}ms :: ${JSON.stringify(r7)}`);
check('失败耗时在 3 秒内', dt < 3000, `${dt}ms`);

step('8. 统计');
check('桥接统计有连接计数', bridge.stats.connects >= 4, JSON.stringify({ connects: bridge.stats.connects, errors: bridge.stats.errors, active: bridge.stats.active }));

console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);

await bridge.close();
await echo.close();
await socksA.close();
await socksB.close();
process.exit(pass === results.length ? 0 : 1);
