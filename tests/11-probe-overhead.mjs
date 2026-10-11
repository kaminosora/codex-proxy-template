// tests/11-probe-overhead.mjs — 验证"后台自动探测"的开销与安全性
//
// 这个测试回答一个使用层面的关键问题：
//   **每 15 秒一次的后台探测，会不会干扰正在使用的 Codex？**
//
// 结论要靠三件事证明：
//   1) 探测是【轻量】的 —— 只做 SOCKS 建连就 destroy，不做 TLS、不发一个字节
//   2) 探测【不会重入叠加】 —— 上一轮没跑完时跳过下一轮（否则 failStreak 会被交错放大）
//   3) 重型测量（真实下载）【只在手动命令里】发生，绝不在定时器路径上
//
// 覆盖（共 8 项）：
//   1) 轻量探测确实不做 TLS/HTTP：用一个"只接受 SOCKS、不给数据"的假出口验证
//   2) 单次轻量探测耗时与传输量为 0 字节
//   3) 并发调用 healthCheckAll 不会放大 failStreak（防重入生效）
//   4) 防重入跳过的轮次会被记录（日志里有"跳过这一轮"）
//   5) probeRunning 标志在异常后也会复位（finally 保证）
//   6) requestTiming 是重型的（会真的收到字节）—— 与 1 形成对比
//   7) 定时器路径（healthCheckAll）不会调用 measureUplink
//   8) 冷静期常量符合预期（默认 120 秒），且 decideLatencySwitch 在期内返回 cooldown
//
// 用法： node tests/11-probe-overhead.mjs
// 预期： 8/8 通过
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

console.log('=== 11 后台探测的开销与安全性 ===\n');

// ---------------------------------------------------------------- 假出口：只完成 SOCKS 握手，之后什么都不发
// 用来证明"轻量探测不做 TLS"：如果它做 TLS，就会卡住并超时失败。
async function startSocksOnly() {
  const stats = { accepted: 0, bytesFromClient: 0 };
  const srv = net.createServer((c) => {
    stats.accepted++;
    let greeted = false;
    c.on('error', () => {});
    c.on('data', (d) => {
      stats.bytesFromClient += d.length;
      if (greeted) return;
      greeted = true;
      c.write(Buffer.from([0x05, 0x00]));          // 接受无认证
      // 之后故意什么都不发：真正的 TLS 握手会在这里卡住
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, stats, close: () => new Promise((r) => srv.close(r)) };
}

// ---------------------------------------------------------------- 1~2 轻量性
step('1~2. 轻量探测不做 TLS/HTTP（只 SOCKS 建连就断开）');
const fake = await startSocksOnly();
{
  const t0 = Date.now();
  const r = await M.probeVia(fake.port, { host: 'example.com', port: 443 }, 4000);
  const dt = Date.now() - t0;
  // probeVia 内部 socksConnect 要等服务端的 reply 才 resolve，而我们这个假出口不发 reply，
  // 所以它应该【超时失败】—— 这恰恰证明它不会绕过 SOCKS 握手去做别的事。
  check('对方不回 SOCKS reply 时 probeVia 会超时失败（说明它严格等握手）',
    r.ok === false, `${dt}ms  detail=${r.detail}`);
  check('整个过程没有产生业务数据传输（只收到握手字节）',
    fake.stats.bytesFromClient < 64, `客户端只发了 ${fake.stats.bytesFromClient} 字节（SOCKS 问候语）`);
}
await fake.close();

// ---------------------------------------------------------------- 3~5 防重入
step('3~5. 防重入：并发调用不会放大 failStreak');
{
  const cfg = M.loadConfig();
  cfg.health.timeoutMs = 2500;
  const d = new M.Daemon(cfg);
  // 一个必然失败的出口（端口没人监听）
  d.uplinks = [{ name: 'dead', port: 1, priority: 1 }];
  d.health = new Map([['dead', { ok: true, failStreak: 0, okStreak: 0, lastMs: null, lastDetail: '', latencyFresh: false }]]);

  // 并发发起 6 轮：只有第一轮应该真正跑，其余被跳过
  await Promise.all(Array.from({ length: 6 }, () => d.healthCheckAll(false)));
  const h = d.health.get('dead');
  check('6 轮并发只让 failStreak 增加 1 次（其余被防重入跳过）',
    h.failStreak === 1, `failStreak=${h.failStreak}`);
  check('probeRunning 已复位', d.probeRunning === false, `probeRunning=${d.probeRunning}`);

  // 异常后也要复位（finally 保证）
  const d2 = new M.Daemon(cfg);
  d2.uplinks = [{ name: 'x', port: 1, priority: 1 }];
  d2.health = new Map([['x', { ok: true, failStreak: 0, okStreak: 0, lastMs: null, lastDetail: '', latencyFresh: false }]]);
  d2.healthCheckOnce = async () => { throw new Error('模拟探测内部崩溃'); };
  try { await d2.healthCheckAll(false); } catch { /* 预期抛出 */ }
  check('探测内部抛异常后 probeRunning 仍被复位', d2.probeRunning === false, `probeRunning=${d2.probeRunning}`);
}

// ---------------------------------------------------------------- 6 重型对比
step('6. 对比：requestTiming 是重型的（会真的走 TLS + 收数据），且有超时保护');
{
  // 假出口：完成 SOCKS 握手后，把连接转到一个"接受 TCP 但什么都不回"的端口。
  // 这样 requestTiming 会走到 TLS 阶段并卡住 —— 用来验证它的 TLS 握手超时确实生效
  // （早期版本没有这个超时，会让 speed/best 永久挂起，实测踩过）。
  const silent = net.createServer((c) => { c.on('error', () => {}); c.on('data', () => {}); });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const silentPort = silent.address().port;

  const socksSrv = net.createServer((c) => {
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
        const up = net.connect({ host: '127.0.0.1', port: silentPort }, () => {
          c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (buf.length > 10) up.write(buf.subarray(10));
          c.pipe(up); up.pipe(c);
        });
        up.on('error', () => c.destroy());
      }
    });
  });
  await new Promise((r) => socksSrv.listen(0, '127.0.0.1', r));
  const sp = socksSrv.address().port;

  const t0 = Date.now();
  const r = await M.requestTiming(sp, { host: 'x.local', path: '/', timeoutMs: 3000 });
  const dt = Date.now() - t0;
  check('对端卡住不做 TLS 握手时，requestTiming 会超时返回而不是永久挂起',
    r.ok === false && dt < 8000, `${dt}ms  err=${r.err}`);
  check('失败原因指向 TLS 阶段', String(r.err).includes('tls'), `err=${r.err}`);

  await new Promise((r2) => socksSrv.close(r2));
  await new Promise((r2) => silent.close(r2));
}

// ---------------------------------------------------------------- 7 定时器路径不碰重型测量
step('7. 定时器路径不做重型测量（只做一次轻量往返）');
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'codex-proxy.mjs'), 'utf8');
  // 界定 healthCheckOnce 的函数体：从它的签名开始，到下一个顶层方法定义为止。
  // 注意不能用"下一个 selectUplink"当终点 —— 它在 healthCheckOnce 之前，
  // 那样截取会一路到文件末尾，把别处的 dlBytes 也误判进来（已踩过）。
  const start = src.indexOf('async healthCheckOnce(');
  const rest = src.slice(start + 10);
  const nextMethod = rest.search(/\n  (?:async )?[a-zA-Z_$][\w$]*\([^)]*\)\s*\{/);
  const body = nextMethod > 0 ? rest.slice(0, nextMethod) : rest.slice(0, 8000);

  check('healthCheckOnce 里没有 measureUplink（不做下载测速）', !body.includes('measureUplink'), '');
  check('healthCheckOnce 只用 probeVia 做连通性判断', body.includes('probeVia'), '');

  // requestTiming 被用来取真实往返延迟，但必须是【只取 1 字节】的轻量往返。
  // 这一条守住"探测不会变重"——真实延迟必须用真实请求量，否则 xray/mihomo 显示 0ms
  // 并系统性压过 ssh（已实测踩过）。
  const usesTiming = body.includes('requestTiming');
  check('healthCheckOnce 会用 requestTiming 取真实往返延迟', usesTiming, '');
  check('但它限制为只取 1 字节（maxBytes: 1），不是下载测速',
    /maxBytes:\s*1\b/.test(body), 'maxBytes: 1');
  check('它不从定时器路径触发下载测速', !/262144|dlBytes/.test(body), '');
}

// ---------------------------------------------------------------- 8 冷静期
step('8. 冷静期默认值与应用');
{
  const cfg = M.loadConfig();
  check('cooldownMs 默认为 120000（2 分钟）', cfg.health.cooldownMs === 120000, `${cfg.health.cooldownMs}ms`);
  check('intervalMs 默认为 15000（15 秒）', cfg.health.intervalMs === 15000, `${cfg.health.intervalMs}ms`);

  const healthy = [{ name: 'a', priority: 1 }, { name: 'b', priority: 2 }];
  const health = new Map([
    ['a', { ok: true, lastMs: 3000, latencyFresh: true }],
    ['b', { ok: true, lastMs: 100, latencyFresh: true }],
  ]);
  const d = M.decideLatencySwitch({
    healthy, current: healthy[0], health, cfg: cfg.health,
    prevStreak: { key: 'a->b', n: 99 },        // 即使连续计数早已满足
    cooldownUntil: Date.now() + 60000,          // 只要还在冷静期
    now: Date.now(),
  });
  check('冷静期内即使连续计数满足也不切换', !d.switch && d.reason === 'cooldown', `reason=${d.reason}`);
}

console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
