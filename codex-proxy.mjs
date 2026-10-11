#!/usr/bin/env node
/**
 * codex-proxy.mjs —— Codex 专用代理的守护进程
 *
 * 目标：只让 Codex 走日本服务器（或 Clash Party 节点），其它应用一律不受影响。
 *
 *   浏览器 / 其它应用 ──> 系统代理(保持原样，本脚本绝不修改)
 *   Codex             ──> 127.0.0.1:17890（本脚本）──┬─ 1. SSH 隧道 ──> 日本服务器
 *                                                  ├─ 2. xray   ──> 日本服务器(可选)
 *                                                  └─ 3. Clash Party 节点(回落)
 *
 * 本地 17890 端口同时接受 HTTP CONNECT 和 SOCKS5（按首字节自动识别），
 * 因为 Codex 是 Rust + reqwest 实现，两种方式它都支持，两条路都留着最稳。
 *
 * 用法：
 *   node codex-proxy.mjs daemon            前台运行守护进程（由 PowerShell 启动器后台拉起）
 *   node codex-proxy.mjs start             确保守护进程在跑
 *   node codex-proxy.mjs stop              停止
 *   node codex-proxy.mjs status            查看状态
 *   node codex-proxy.mjs check [--url U]   实测出口 IP 与延迟
 *   node codex-proxy.mjs run -- <args...>  用代理环境变量启动 codex
 *   node codex-proxy.mjs app               重启 Codex 桌面应用并挂上代理
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, 'codex-proxy.config.json');
const RUN_DIR = path.join(HERE, 'run');
const LOG_DIR = path.join(HERE, 'logs');
const PID_FILE = path.join(RUN_DIR, 'daemon.pid');
const TOKEN_FILE = path.join(RUN_DIR, 'control-token.json');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const CHILDREN_FILE = path.join(RUN_DIR, 'children.json');
const FALLBACK_DIR = path.join(RUN_DIR, 'fallback');

for (const d of [RUN_DIR, LOG_DIR, FALLBACK_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------- 日志

let logStream = null;
function openLog() {
  const name = `daemon-${new Date().toISOString().slice(0, 10)}.log`;
  logStream = fs.createWriteStream(path.join(LOG_DIR, name), { flags: 'a' });
}
function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (logStream) logStream.write(line + '\n');
  if (level !== 'debug') console.log(line);
}

// ---------------------------------------------------------------- 配置

function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  const stripComments = (o) => {
    if (Array.isArray(o)) return o.map(stripComments);
    if (o && typeof o === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(o)) if (!k.startsWith('//')) out[k] = stripComments(v);
      return out;
    }
    return o;
  };
  const c = stripComments(cfg);

  // health 的默认值：老配置文件里没有这些字段也能正常跑。
  c.health = {
    intervalMs: 15000,
    timeoutMs: 8000,
    failThreshold: 2,
    latencyAware: true,
    // ★ slowMs 是【地板】语义，不是"超过才算慢"的高门槛 ★
    //   低于它就认为够快、不再折腾（哪怕别人快 10 倍）。
    //   早期把它当高门槛用（800），导致 250~800ms 区间成了永不优化的死区：
    //   600ms vs 300ms 差一倍也放着不动 —— 实测踩过。
    slowMs: 250,
    fastRatio: 2,          // 候选要比当前快这么多倍（相对阈值，与 slowMs 无关）
    minGainMs: 150,        // 且至少快这么多毫秒，避免"50ms→20ms 也切"
    satisfiedPolls: 3,     // 连续满足多少次才切换（3 × 15s ≈ 45 秒）
    cooldownMs: 120000,    // 切换后的冷静期（2 分钟）
    connIdleTimeoutSec: 120,  // 连接连续这么久无数据就断开，逼客户端重连（防上游黑洞卡死界面）
    latencyTarget: { host: 'speed.cloudflare.com', path: '/__down?bytes=1' },
    ...(c.health || {}),
  };
  return c;
}

// ---------------------------------------------------------------- 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 把一个值写成 YAML 标量。
 *
 * ★ 必须按类型区分，不能一律当字符串加引号 ★
 *   订阅里的值虽然解析出来都是字符串，但 YAML 是有类型的：
 *     udp: 'true'        → mihomo 报 "expected type 'bool', got unconvertible type 'string'"
 *     ech-opts: '{...}'  → mihomo 报 "expected a map, got 'string'"
 *   早期版本一律加引号，结果回落出口 / node-test 的内核直接启动失败（实测踩过）。
 *   所以这里要还原类型：布尔用裸 true/false、数字用裸数字、
 *   流式 map/数组按原样输出（它们本身就是合法 YAML）。
 */
function yamlScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  const t = s.trim();

  // 布尔：裸 true / false
  if (/^(true|false)$/i.test(t)) return t.toLowerCase();
  // 纯整数：裸数字（端口、mtu 之类必须是数字）
  if (/^-?\d+$/.test(t)) return t;
  // 浮点：也按数字
  if (/^-?\d+\.\d+$/.test(t)) return t;
  // 流式 map / 数组：本身是合法 YAML，原样输出，绝不能加引号
  if (/^\{[\s\S]*\}$/.test(t) || /^\[[\s\S]*\]$/.test(t)) return t;

  // 其余按需加引号：首尾空白、含特殊字符、看起来像 null 字面量、空串
  // 注意：仅"内部含空格"不需要引号 —— YAML 明文标量允许内部空格（如节点名 `🇯🇵 日本1|BGP优化`）
  if (s === '' || /^\s|\s$/.test(s) || /[:#{}[\],&*?|<>=!%@`"']/.test(s) ||
    /^(null|yes|no|on|off|~)$/i.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/** 端口类的键：值要用数字，不能是字符串（mihomo 会拒绝字符串端口） */
function isPortLikeKey(k) {
  return /port$/i.test(k);
}

/** 把解析出的键值按类型放进对象（端口转数字）—— 块式与流式共用同一套规则 */
function setParsedKey(obj, k, rawValue) {
  const v = unquote(rawValue);
  obj[k] = (isPortLikeKey(k) && /^\d+$/.test(v)) ? Number(v) : v;
}

/**
 * 结束一棵进程树。
 * Windows 上 taskkill /T 才会连子进程一起杀；其它平台用进程组。
 * 非致命：失败不抛，由调用方决定后续。
 */
function killTree(childOrPid) {
  const pid = typeof childOrPid === 'number' ? childOrPid : childOrPid?.pid;
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
    }
  } catch { /* 已经不在了就忽略 */ }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function portBusy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(true));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(false)));
  });
}

// ---------------------------------------------------------------- SOCKS5 客户端

/**
 * 通过 SOCKS5 代理连到 target:port，成功返回已连通的 socket。
 * 一定用域名形式（socks5h 语义），让代理解析 DNS，避免本地 DNS 污染。
 */
function socksConnect(proxyPort, targetHost, targetPort, timeoutMs, proxyHost = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxyHost, port: proxyPort });
    let phase = 'greet';
    let buf = Buffer.alloc(0);
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.removeListener('data', onData);
      resolve(sock);
    };

    sock.setTimeout(timeoutMs, () => fail(new Error('socks timeout')));
    sock.on('error', fail);

    function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (phase === 'greet') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05) return fail(new Error('bad socks version'));
        if (buf[1] !== 0x00) return fail(new Error('socks auth required'));
        buf = buf.subarray(2);
        const host = Buffer.from(targetHost, 'utf8');
        const req = Buffer.alloc(7 + host.length);
        req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
        req[4] = host.length;
        host.copy(req, 5);
        req.writeUInt16BE(targetPort, 5 + host.length);
        sock.write(req);
        phase = 'reply';
        return;
      }
      if (buf.length < 4) return;
      const rep = buf[1];
      if (rep !== 0x00) {
        const names = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'ttl expired', 7: 'command not supported', 8: 'address type not supported' };
        return fail(new Error('socks reply ' + rep + ' (' + (names[rep] || '?') + ')'));
      }
      // ★ 回复长度按 ATYP 动态判断，且【拿到 4 字节就算成功】★
      //   RFC 1928 的回复格式是 VER REP RSV ATYP BND.ADDR BND.PORT，但那 6~18 字节的
      //   BND 地址是"代理自己用的出口地址"，**客户端完全不需要**。
      //   实践中（以及我们的假出口测试里）常见只回前 4 字节的实现；
      //   早期版本写死要 10 字节，会让这类出口永远握手不上（实测踩过）。
      //   所以：REP=0 且 ATYP 合法 → 立刻成功，不等 BND 部分。
      const atyp = buf[3];
      if (atyp === 0x01 || atyp === 0x04 || atyp === 0x03) return ok();
      return fail(new Error('bad atyp ' + atyp));
    }

    sock.on('data', onData);
    sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
  });
}

/** 通过某个 SOCKS5 端口探测一个目标，返回 { ok, ms, detail } */
async function probeVia(socksPort, target, timeoutMs) {
  // 参数校验：这个函数以前被按位置参数误用，崩在协议解析处、误导排查（已踩过）
  if (typeof socksPort !== 'number' || !socksPort) {
    return { ok: false, ms: 0, detail: 'probeVia: 第 1 个参数应为端口号（number）' };
  }
  if (!target || typeof target !== 'object' || !target.host) {
    return { ok: false, ms: 0, detail: 'probeVia: 第 2 个参数应为 { host, port }' };
  }
  const t0 = Date.now();
  let sock;
  try {
    sock = await socksConnect(socksPort, target.host, target.port, timeoutMs);
    const ms = Date.now() - t0;
    sock.destroy();
    // 注意：这里只做到 SOCKS 握手，没做 TLS、没发一个字节。
    // 它只说明"出口进程活着"，【不能】当作延迟用 —— 见 requestTiming。
    return { ok: true, ms, detail: 'socks 握手成功' };
  } catch (e) {
    if (sock) sock.destroy();
    return { ok: false, ms: Date.now() - t0, detail: e.message };
  }
}

/**
 * 经某个 SOCKS5 端口发一次**真实 HTTPS 请求**，返回各阶段耗时。
 *
 * 为什么需要它（而不是用 probeVia 的握手耗时）：
 *   probeVia 只测"到本地出口端口的 SOCKS 握手"。而三个出口的 SOCKS 服务位置不同：
 *     · ssh:jp      → ssh -D 在【远端】监听，握手真的绕一圈日本再回来（~120ms，真实）
 *     · xray/mihomo → SOCKS 服务在【本机】，隧道要等 CONNECT 目标才建（<1ms，虚假 0ms）
 *   后果不只是显示问题：拿这个数字做切换判据会**系统性偏向本机出口**，
 *   "谁更快"从根上判断错（实测踩过）。所以判据一律用这个函数的结果。
 *
 * maxBytes 默认可观（用于测速）；health 探测时传 1，只取响应头，保持轻量。
 */
function requestTiming(socksPort, { host, port = 443, path: reqPath = '/', method = 'GET', maxBytes = 65536, timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const marks = { t0 };
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try { sock?.destroy(); } catch {}
      // ★ tEnd 记的是【耗时】不是时间戳 ★
      //   写成 Date.now() 会让调用方拿到的 totalMs 是 1791...（绝对毫秒），
      //   于是"—延迟"显示成一串天文数字、算 Mbps 时除以它得到 0.00（实测踩过）。
      resolve({ ...r, t0: marks.t0, tSocks: marks.tSocks ?? null, tTls: marks.tTls ?? null, tFirst: marks.tFirst ?? null, tEnd: Date.now() - marks.t0 });
    };

    let sock = null;
    let tlsSock = null;
    let settled = false;
    // 记录当前所处阶段：超时/失败时据此给出准确的原因，便于排查
    // （否则"卡在 TLS"会报成笼统的"总超时"，看不出卡在哪一步）
    let stage = 'socks';
    const settle = (fn) => { if (!settled) { settled = true; fn(); } };
    const guard = setTimeout(() => {
      settle(() => finish({ ok: false, err: `${stage}: 超时（${timeoutMs}ms 未完成）`, stage }));
    }, timeoutMs);

    (async () => {
      try {
        sock = await socksConnect(socksPort, host, port, timeoutMs);
        marks.tSocks = Date.now();
        stage = 'tls';
      } catch (e) {
        clearTimeout(guard);
        return settle(() => finish({ ok: false, err: 'socks: ' + e.message, stage: 'socks' }));
      }

      // TLS 握手也要有超时：对端卡住不握手时，没有超时会让整个流程永久挂起（实测踩过 4 分钟）
      const tlsTimeout = Math.min(timeoutMs, 20000);
      tlsSock = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false });
      const tlsTimer = setTimeout(() => {
        settle(() => { clearTimeout(guard); finish({ ok: false, err: 'tls: 握手超时（对端未完成 TLS 握手）', stage: 'tls' }); });
      }, tlsTimeout);

      tlsSock.once('secureConnect', () => {
        clearTimeout(tlsTimer);
        if (settled) return;
        stage = 'http';
        marks.tTls = Date.now();
        const reqHeaders = {
          Host: host,
          'User-Agent': 'codex-proxy/1.0',
          Accept: '*/*',
          Connection: 'close',
          ...headers,
        };
        let head = `${method} ${reqPath} HTTP/1.1\r\n`;
        for (const [k, v] of Object.entries(reqHeaders)) head += `${k}: ${v}\r\n`;
        head += '\r\n';
        try { tlsSock.write(head); } catch (e) { clearTimeout(guard); return settle(() => finish({ ok: false, err: 'write: ' + e.message, stage: 'http' })); }
      });

      let buf = Buffer.alloc(0);
      let status = null;
      let truncated = false;

      tlsSock.on('data', (d) => {
        if (marks.tFirst === null) marks.tFirst = Date.now();
        buf = Buffer.concat([buf, d]);
        if (status === null) {
          const s = buf.toString('latin1', 0, Math.min(buf.length, 256));
          const m = s.match(/^HTTP\/\d\.\d (\d{3})/);
          if (m) status = Number(m[1]);
        }
        if (buf.length >= maxBytes) { truncated = true; clearTimeout(guard); settle(() => finish({ ok: true, status, bytes: buf.length, truncated })); }
      });

      tlsSock.on('end', () => { clearTimeout(guard); settle(() => finish({ ok: true, status, bytes: buf.length, truncated })); });
      tlsSock.on('error', (e) => { clearTimeout(tlsTimer); clearTimeout(guard); settle(() => finish({ ok: false, err: 'tls: ' + e.message, stage: 'tls' })); });
      tlsSock.on('close', () => {
        clearTimeout(tlsTimer);
        clearTimeout(guard);
        settle(() => finish({ ok: true, status, bytes: buf.length, truncated }));
      });
    })();
  }).then((r) => {
    if (!r.ok) return { ok: false, err: r.err || '未知错误', status: null, bytes: 0 };
    const socksMs = r.tSocks ? r.tSocks - r.t0 : null;
    const tlsMs = (r.tTls && r.tSocks) ? r.tTls - r.tSocks : null;
    const ttfbMs = r.tFirst ? r.tFirst - r.t0 : null;
    // 注意：要用 finish() 里记下的 r.tEnd，不能在这里重新取 Date.now()
    // —— 那会把"promise 链的开销"也算进去，而且调用方看到的耗时和内部不一致。
    const totalMs = r.tEnd;
    return {
      ok: true, status: r.status, bytes: r.bytes, truncated: !!r.truncated,
      socksMs, tlsMs, ttfbMs, totalMs, host,
      // totalMs 就是"真实往返耗时"，用作 status 显示的延迟与自动切换的判据
    };
  });
}

// ---------------------------------------------------------------- 出口性能判定（纯函数）

/**
 * 性能判定（纯函数，无副作用、无 IO）—— 便于单独测试防抖动行为。
 *
 * 设计目标：只要当前出口还没有"快到不值得折腾"，且存在明显更优的候选，就建议切换。
 * **与 priority 无关** —— priority 只在"第一次挑一个"时用（见 Daemon.selectUplink 第 3 层）。
 *
 * 三条切换条件（全部满足）：
 *   1) 当前不达标：cur > slowMs。slowMs 的语义是【地板】——
 *      "低于它就够快了，哪怕别人快 10 倍也不折腾"。★它不是"超过才算慢"的高门槛★
 *      （早期把它当高门槛用（800），导致 250~800ms 区间成了永不优化的死区：
 *        600ms vs 300ms 差一倍也放着不动。已实测发现并修正。）
 *   2) 候选明显更优（两条都要满足）：
 *        · 相对：比当前快 fastRatio 倍以上（含等于）
 *        · 绝对：至少快 minGainMs 毫秒
 *      一起卡是为了避免"50ms→20ms 也切"这种无意义切换。
 *   3) 连续 satisfiedPolls 次成立，且不在 cooldownMs 冷静期内。
 *
 * ★ 防"来回横跳"靠闸门对称，而不是方向限制 ★
 *   切过去之后，旧出口要在下一轮【反向满足同样苛刻的条件】才能夺回：
 *   它得先超过 slowMs，且新出口比它快 fastRatio 倍以上、增益超过 minGainMs，
 *   并连续成立 satisfiedPolls 次、还得等过冷静期。因为切换本来就冲着明显更优去，
 *   反向条件几乎不可能成立。
 *   （早期版本用"只能往低优先级换"防横跳，会挡掉正当优化，已移除。）
 *
 * 候选必须是健康、且本轮延迟数据新鲜的出口。
 *
 * 返回：{ switch, cand, streak, cooldownUntil, curMs, candMs, reason }
 */
function decideLatencySwitch({ healthy, current, health, cfg, prevStreak, cooldownUntil, now }) {
  const keep = (reason, streak = null) => ({
    switch: false, cand: null, streak, cooldownUntil, curMs: null, candMs: null, reason,
  });
  const curH = health.get(current.name);

  // 条件 3a：冷静期
  if (now < cooldownUntil) return keep('cooldown');

  // 条件 1：当前已经快到不值得折腾 → 一律不动
  if (!curH || !curH.latencyFresh || typeof curH.lastMs !== 'number') return keep('no-fresh-latency');
  if (curH.lastMs <= cfg.slowMs) return keep('fast-enough');

  // 条件 2：在【所有】健康出口里找最优候选（不看 priority），两条阈值都要满足。
  // 用 <= 而不是 <："快 2 倍"应当包含正好 2 倍。
  const gainNeeded = Math.max(curH.lastMs / cfg.fastRatio, cfg.minGainMs ?? 0);
  const candLimit = curH.lastMs - gainNeeded;
  let cand = null, candMs = null;
  for (const l of healthy) {
    if (l.name === current.name) continue;
    const h = health.get(l.name);
    if (!h || !h.latencyFresh || typeof h.lastMs !== 'number') continue;
    if (h.lastMs > candLimit) continue;                   // 不够快 / 增益不足
    if (candMs === null || h.lastMs < candMs) { cand = l; candMs = h.lastMs; }   // 取最快
  }
  if (!cand) return keep('no-better-candidate');

  // 条件 3b：连续满足 satisfiedPolls 次才真切；中途一次不成立就清零重数。
  // streak 用 { n } 对象而不是裸数字：调用方要能区分"从没满足过（null）"和"计数为 0"。
  const streak = { n: (prevStreak?.n || 0) + 1 };
  if (streak.n < cfg.satisfiedPolls) {
    return { switch: false, cand, streak, cooldownUntil, curMs: curH.lastMs, candMs, reason: 'pending' };
  }
  return {
    switch: true, cand, streak: null,
    cooldownUntil: now + (cfg.cooldownMs || 120000),
    curMs: curH.lastMs, candMs, reason: 'switch',
  };
}

// ---------------------------------------------------------------- 本地桥接（HTTP CONNECT + SOCKS5）

class Bridge {
  constructor(getUplink) {
    this.getUplink = getUplink;   // () => { name, port } | null
    this.server = null;
    this.stats = {
      connects: 0, rejected: 0, errors: 0, active: 0, bytesUp: 0, bytesDown: 0,
      lastClientAt: 0, lastError: '',
      // 按【出口】分桶统计：这是"切换时流量实际走了哪条"最直接的证据
      byUplink: {},
    };
    // 活动连接表：切换出口 / 空闲超时时需要主动关掉它们，所以必须持有引用
    this.conns = new Set();
  }

  /**
   * 绑监听端口。
   *
   * ★ 要容忍短暂的 EADDRINUSE 并重试 ★
   *   场景：上一轮的孤儿守护进程刚被回收，它释放端口和内核真正完成 bind 之间有窗口；
   *   或者同一秒内有另一个实例在收尾。不重试的话内核直接退出，
   *   日志里只有一句 EADDRINUSE，很难看出是"上一轮还没退干净"（实测踩过）。
   *   真的被无关程序长期占用时，重试会耗尽并如实报错。
   */
  async listen(port, attempts = 8) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this._listenOnce(port);
      } catch (e) {
        lastErr = e;
        if (e.code !== 'EADDRINUSE') throw e;
        if (i < attempts - 1) {
          const holder = pidListeningOn(port);
          log('warn', `端口 ${port} 被 pid ${holder ?? '?'} 占用，${300 * (i + 1)}ms 后重试（第 ${i + 1}/${attempts} 次）`);
          await sleep(300 * (i + 1));
        }
      }
    }
    throw lastErr;
  }

  _listenOnce(port) {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => this.onConnection(sock));
      this.server = srv;
      const onErr = (e) => { srv.removeListener('listening', onOk); try { srv.close(); } catch {} reject(e); };
      const onOk = () => { srv.removeListener('error', onErr); resolve(srv.address().port); };
      srv.once('error', onErr);
      srv.once('listening', onOk);
      srv.listen(port, '127.0.0.1');
    });
  }

  close() {
    return new Promise((r) => (this.server ? this.server.close(r) : r()));
  }

  onConnection(client) {
    this.stats.active++;
    client.once('close', () => this.stats.active--);
    client.on('error', () => {});
    client.once('data', (first) => {
      this.stats.lastClientAt = Date.now();
      if (first[0] === 0x05) this.handleSocks(client, first);
      else this.handleHttp(client, first);
    });
  }

  // ---- SOCKS5 入口
  async handleSocks(client, first) {
    let buf = first;
    try {
      // ★ 问候语长度是 2 + NMETHODS，不是固定 2 字节 ★
      //   客户端经常把"问候 + 请求"合在一个 TCP 段里发出来（很常见，比如我们的
      //   socksConnect 就是先写 3 字节问候、紧接着写请求）。早期版本写死
      //   `buf = buf.subarray(2)`，于是 buf[1] 那个 METHOD 字节被当成请求的 CMD，
      //   后续字段整体错位 → 解析出 bad atyp → 回 05 01（general failure），
      //   表现为"握手莫名其妙失败"（实测踩过）。
      if (buf.length < 2 || buf[0] !== 0x05) throw new Error('bad socks hello');
      const nMethods = buf[1];
      const greetLen = 2 + nMethods;
      if (buf.length < greetLen) {
        // 问候还没收全，先等齐（后面的请求字节会一起到）
        buf = await readMore(client, buf, (b) => (b.length >= 2 ? 2 + b[1] : 0));
      }
      client.write(Buffer.from([0x05, 0x00]));
      buf = buf.subarray(greetLen);

      // 读完整请求（含地址）
      buf = await readMore(client, buf, (b) => {
        if (b.length < 4) return 0;
        const atyp = b[3];
        if (atyp === 0x01) return 10;
        if (atyp === 0x04) return 22;
        if (atyp === 0x03) return b.length < 5 ? 0 : 5 + b[4] + 2;
        throw new Error('bad atyp ' + atyp);
      });

      const cmd = buf[1];
      const atyp = buf[3];
      let host, port, off;
      if (atyp === 0x01) { host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`; port = buf.readUInt16BE(8); off = 10; }
      else if (atyp === 0x04) { host = Array.from(buf.subarray(4, 20)).map((x) => x.toString(16).padStart(2, '0')).join(':'); port = buf.readUInt16BE(20); off = 22; }
      else { const l = buf[4]; host = buf.subarray(5, 5 + l).toString('utf8'); port = buf.readUInt16BE(5 + l); off = 7 + l; }
      const rest = buf.subarray(off);

      if (cmd !== 0x01) {
        client.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        this.stats.rejected++;
        return;
      }

      const up = this.getUplink();
      if (!up) throw new Error('no healthy uplink');
      const upstream = await socksConnect(up.port, host, port, 20000);
      client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      if (rest.length) upstream.write(rest);
      this.pipe(client, upstream, up.name);
      this.stats.connects++;
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = 'socks: ' + e.message;
      try { client.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); } catch {}
    }
  }

  // ---- HTTP 代理入口（含 CONNECT 隧道与普通请求）
  async handleHttp(client, first) {
    try {
      let buf = first;
      buf = await readMore(client, buf, (b) => (b.includes('\r\n\r\n') ? b.length : 0));
      const headEnd = buf.indexOf('\r\n\r\n');
      const head = buf.subarray(0, headEnd).toString('latin1');
      const rest = buf.subarray(headEnd + 4);
      const [requestLine, ...headerLines] = head.split('\r\n');
      const [method, targetRaw, version = 'HTTP/1.1'] = requestLine.split(' ');

      const headers = {};
      for (const line of headerLines) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }

      const up = this.getUplink();
      if (!up) throw new Error('no healthy uplink');

      if (method === 'CONNECT') {
        const [host, portStr] = targetRaw.split(':');
        const upstream = await socksConnect(up.port, host, Number(portStr) || 443, 20000);
        client.write(`${version} 200 Connection established\r\n\r\n`);
        if (rest.length) upstream.write(rest);
        this.pipe(client, upstream, up.name);
        this.stats.connects++;
        return;
      }

      // 普通 HTTP 请求：解析绝对 URL，改写后经隧道转发
      let target = targetRaw;
      if (/^https?:\/\//i.test(target)) {
        const u = new URL(target);
        target = u.pathname + u.search;
        headers.host = headers.host || u.host;
      }
      if (!headers.host) throw new Error('missing Host header');

      const upstream = await socksConnect(up.port, headers.host.split(':')[0], Number(headers.host.split(':')[1]) || 80, 20000);
      const outHeaders = Object.entries(headers)
        .filter(([k]) => k !== 'proxy-connection' && k !== 'proxy-authorization')
        .map(([k, v]) => `${k}: ${v}`);
      upstream.write(`${method} ${target} ${version}\r\n${outHeaders.join('\r\n')}\r\n\r\n`);
      if (rest.length) upstream.write(rest);
      this.pipe(client, upstream, up.name);
      this.stats.connects++;
    } catch (e) {
      this.stats.errors++;
      this.stats.lastError = 'http: ' + e.message;
      const body = `codex-proxy: ${e.message}`;
      try {
        client.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      } catch {}
    }
  }

  pipe(client, upstream, uplinkName) {
    client.setNoDelay(true);
    upstream.setNoDelay(true);

    // ① TCP keepalive：让操作系统帮我们察觉"对端无声消失"（半开连接）。
    //    没有它的话，对端进程死了/网络黑洞了，连接会一直挂着，双方都以为还活着。
    try { client.setKeepAlive(true, 15000); } catch {}
    try { upstream.setKeepAlive(true, 15000); } catch {}

    const key = uplinkName || '未知';
    const tot = this.uplinkTotals(key);
    tot.connects++;
    tot.active++;
    tot.lastAt = Date.now();

    // ② 记录每条活动连接，以便切换出口时主动终结它们、以及空闲超时兜底清理
    const rec = { client, upstream, uplink: key, openedAt: Date.now(), lastActivity: Date.now(), peer: peerOf(client), bytes: 0 };
    this.conns.add(rec);

    const touch = () => { rec.lastActivity = Date.now(); };
    client.on('data', (d) => { this.stats.bytesUp += d.length; tot.bytesUp += d.length; rec.bytes += d.length; touch(); });
    upstream.on('data', (d) => { this.stats.bytesDown += d.length; tot.bytesDown += d.length; rec.bytes += d.length; touch(); });
    client.pipe(upstream);
    upstream.pipe(client);
    let closed = false;
    const note = () => {
      if (closed) return;                    // 双向各可能触发一次，不能重复计数
      closed = true;
      tot.closed++;
      if (tot.active > 0) tot.active--;
      this.conns.delete(rec);
    };
    const kill = () => { note(); client.destroy(); upstream.destroy(); };
    client.on('error', kill);
    upstream.on('error', kill);
    client.on('close', () => { note(); upstream.destroy(); });
    upstream.on('close', () => { note(); client.destroy(); });
  }

  /** 取（必要时创建）某出口的累计统计。pipe 是唯一入口，所以这里不需要重置逻辑 */
  uplinkTotals(name) {
    let t = this.stats.byUplink[name];
    if (!t) {
      t = { connects: 0, closed: 0, active: 0, bytesUp: 0, bytesDown: 0, firstAt: Date.now(), lastAt: 0 };
      this.stats.byUplink[name] = t;
    }
    return t;
  }

  /**
   * 主动终结仍挂在指定出口上的连接。
   *
   * ★ 为什么这一步必须有 ★
   *   Codex（Chromium）会复用已建立的长连接（WebSocket / HTTP/2）发请求。
   *   出口延迟爆炸时，连接并不会断开，只是"卡住不动" —— 我们把这种"卡住"如实转达给
   *   Codex，它便认为"连接还活着，只是慢"，于是继续等，界面就呆住了。
   *   而且它会一直复用那条连接，**哪怕我们已经把出口切到了健康的另一条** ——
   *   所以"切换出口"对已经卡住的界面完全无效，只能重启应用（实测踩过）。
   *
   *   只有把这些连接关掉，Codex 才会重新建连，而新建的连接会走新出口，界面立刻恢复。
   */
  dropConnectionsOnUplink(uplinkName, why) {
    let n = 0;
    for (const rec of [...this.conns]) {
      if (rec.uplink !== uplinkName) continue;
      n++;
      log('warn', `因${why}主动断开挂在 ${uplinkName} 上的连接（${rec.peer}，已活跃 ${Math.round((Date.now() - rec.openedAt) / 1000)}s，` +
        `空闲 ${Math.round((Date.now() - rec.lastActivity) / 1000)}s，${fmtBytes(rec.bytes)}）`);
      try { rec.client.destroy(); } catch {}
      try { rec.upstream.destroy(); } catch {}
    }
    if (n) log('warn', `共断开 ${n} 条连接 —— Codex 会自动重连，新连接走当前出口`);
    return n;
  }

  /** 兜底：清掉长时间完全没数据的连接（防上游黑洞导致的"卡住但不断"） */
  reapIdleConnections(idleMs) {
    if (!idleMs || idleMs <= 0) return 0;
    const now = Date.now();
    let n = 0;
    for (const rec of [...this.conns]) {
      if (now - rec.lastActivity < idleMs) continue;
      n++;
      log('warn', `空闲超时（${Math.round((now - rec.lastActivity) / 1000)}s 无数据）主动断开：${rec.peer} @ ${rec.uplink}`);
      try { rec.client.destroy(); } catch {}
      try { rec.upstream.destroy(); } catch {}
    }
    return n;
  }
}

/** 对端地址的可读描述（日志用） */
function peerOf(sock) {
  try {
    const a = sock.remoteAddress || '?';
    const p = sock.remotePort || 0;
    return `${a}:${p}`;
  } catch { return '?'; }
}

/** 从 socket 继续读到满足 want(buf) 为止，返回完整缓冲 */function readMore(sock, initial, want) {
  return new Promise((resolve, reject) => {
    let buf = initial;
    const check = () => {
      let need;
      try { need = want(buf); } catch (e) { cleanup(); return reject(e); }
      if (need && buf.length >= need) { cleanup(); resolve(buf); return true; }
      return false;
    };
    const onData = (c) => { buf = Buffer.concat([buf, c]); check(); };
    const onErr = (e) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error('client closed early')); };
    function cleanup() {
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock.removeListener('end', onEnd);
    }
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('end', onEnd);
    check();
  });
}

// ---------------------------------------------------------------- 出口 1：SSH 隧道

class SshTunnel {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.attempt = 0;
    this.port = cfg.socksPort || 17891;
    this.stopping = false;
    this.logFile = path.join(LOG_DIR, 'ssh-tunnel.log');
  }

  get name() { return 'ssh:jp'; }

  async start() {
    this.stopping = false;
    if (await this.isPortUp()) return true;
    this.spawnOnce();
    for (let i = 0; i < 24; i++) {
      await sleep(500);
      if (await this.isPortUp()) { this.attempt = 0; return true; }
      if (!this.child || this.child.exitCode !== null) break;
    }
    return false;
  }

  spawnOnce() {
    const c = this.cfg;
    const args = [
      '-N',
      '-o', 'BatchMode=yes',              // 绝不弹密码，避免触发服务器上的 fail2ban
      '-o', 'NumberOfPasswordPrompts=0',
      '-o', 'PreferredAuthentications=publickey',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `ConnectTimeout=${c.connectTimeoutSec}`,
      '-o', `ServerAliveInterval=${c.serverAliveIntervalSec}`,
      '-o', `ServerAliveCountMax=${c.serverAliveCountMax}`,
      '-o', 'ControlMaster=no',
      '-D', `127.0.0.1:${this.port}`,
      '-p', String(c.port),
    ];
    if (c.identityFile && fs.existsSync(c.identityFile)) args.push('-i', c.identityFile);
    args.push(`${c.user}@${c.host}`);

    log('info', `启动 SSH 隧道: ssh ${args.join(' ')}`);
    const out = fs.openSync(this.logFile, 'a');
    this.child = spawn('ssh', args, { stdio: ['ignore', out, out], windowsHide: true, detached: false });
    this.child.on('exit', (code, signal) => {
      log(code === 0 || this.stopping ? 'info' : 'warn', `SSH 隧道退出 code=${code} signal=${signal}`);
      this.child = null;
      if (!this.stopping) this.scheduleRestart();
    });
    this.child.on('error', (e) => log('error', `SSH 启动失败: ${e.message}`));
  }

  scheduleRestart() {
    if (this.stopping) return;
    const list = this.cfg.restartBackoffMs || [1000, 2000, 5000];
    const delay = list[Math.min(this.attempt, list.length - 1)];
    this.attempt++;
    log('info', `SSH 隧道将在 ${delay}ms 后重连（第 ${this.attempt} 次）`);
    setTimeout(() => { if (!this.stopping) this.spawnOnce(); }, delay).unref();
  }

  isPortUp() {
    return new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: this.port });
      const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
      s.setTimeout(1200, () => done(false));
      s.on('error', () => done(false));
      s.once('connect', () => done(true));
    });
  }

  stop() {
    this.stopping = true;
    if (this.child) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }
  }
}

// ---------------------------------------------------------------- 出口 2：xray 客户端（可选）

class XrayUplink {
  constructor(cfg, cfgRoot) {
    this.cfg = cfg;
    this.root = cfgRoot;
    this.child = null;
    this.port = cfg.port || 17892;
    this.stopping = false;
    this.logFile = path.join(LOG_DIR, 'xray-client.log');
    this.configFile = path.join(RUN_DIR, 'xray-client.json');
  }

  get name() { return 'xray:jp'; }

  async start() {
    if (!this.cfg.enabled || !this.cfg.uuid) return false;
    if (!this.cfg.xrayExe || !fs.existsSync(this.cfg.xrayExe)) {
      log('warn', 'xray 出口已启用但找不到 xrayExe，跳过');
      return false;
    }
    // 启动前自检：配置缺关键项时内核会直接退出（退出码与日志都很难懂），
    // 这里提前给出明确的提示，省得去翻 xray-client.log
    const problems = this.validateConfig();
    if (problems.length) {
      log('warn', `xray 配置有问题，跳过该出口：${problems.join('；')}`);
      return false;
    }
    fs.writeFileSync(this.configFile, JSON.stringify(this.buildConfig(), null, 2));
    const out = fs.openSync(this.logFile, 'a');
    this.child = spawn(this.cfg.xrayExe, ['run', '-c', this.configFile], { stdio: ['ignore', out, out], windowsHide: true });
    this.child.on('exit', (code) => log('warn', `xray 客户端退出 code=${code}`));
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      if (await portOpen(this.port)) return true;
    }
    return false;
  }

  buildConfig() {
    const c = this.cfg;
    // ★ REALITY 公钥的字段名在不同 Xray 版本里不一样 ★
    //   Xray 26.x 用 `password`，旧版用 `publicKey`。配置里两种都可能出现，
    //   只认其中一个会让另一个版本上 REALITY 配置为空 → 内核直接退出：
    //     Failed to build REALITY config. > infra/conf: empty "password"  (code=23)
    //   这是实测踩过的：配置文件里明明填了 password，代码却读 publicKey，于是起不来。
    const pubKey = c.password || c.publicKey || c.public_key || '';
    return {
      log: { loglevel: 'warning' },
      inbounds: [{
        tag: 'socks-in', listen: '127.0.0.1', port: this.port, protocol: 'socks',
        settings: { auth: 'noauth', udp: false },
      }],
      outbounds: [{
        tag: 'jp-out', protocol: 'vless',
        settings: { vnext: [{ address: c.server, port: c.serverPort, users: [{ id: c.uuid, encryption: 'none', flow: c.flow }] }] },
        streamSettings: {
          network: 'raw', security: 'reality',
          realitySettings: {
            serverName: c.sni, shortId: c.shortId,
            fingerprint: c.fingerprint || 'chrome', spiderX: c.spiderX || '/',
            // 同时写两个键名，兼容新老 Xray；多余的键会被忽略
            password: pubKey,
            publicKey: pubKey,
          },
        },
      }],
    };
  }

  /** 启动前自检：REALITY 公钥不能为空，否则内核会直接退出（报错难懂，提前给出清晰提示） */
  validateConfig() {
    const c = this.cfg;
    const pubKey = c.password || c.publicKey || c.public_key || '';
    const problems = [];
    if (!c.server) problems.push('uplinks.xray.server 未填写');
    if (!c.uuid) problems.push('uplinks.xray.uuid 未填写');
    if (!pubKey) {
      problems.push('uplinks.xray 的 REALITY 公钥为空：请填 password（Xray 26.x 叫法）或 publicKey（旧版叫法）。' +
        '用 bin\\xray.exe x25519 -i "<服务器 privateKey>" 反推，输出里的 Password (PublicKey) 才是要填的值');
    }
    return problems;
  }

  stop() {
    this.stopping = true;
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(1000, () => done(false));
    s.on('error', () => done(false));
    s.once('connect', () => done(true));
  });
}

// ---------------------------------------------------------------- 出口 3：Clash Party 节点（回落）

/** 极简 YAML 扫描：只提取 proxies 段里 name/type/server/port/... 这些扁平字段 */
/**
 * 查某个 pid 的**进程名**（只看名字，不看路径）。
 *
 * 为什么要这个：我们的回落内核是改名过的 `bin\codex-core.exe`，所以正常时
 * 端口上的进程名应该是 **`codex-core`**；一旦看到 `mihomo`，要么是
 *   ① 我们的副本丢了、退回了 Clash Party 的内核（要补副本），
 *   ② 要么那根本是 Clash Party 自己的内核占了端口（与我们无关）。
 * `status` 把名字打出来，用户就能一眼区分，不用自己去 tasklist。
 *
 * 用 `tasklist /FI "PID eq N" /FO CSV /NH` —— 比 PowerShell 轻，
 * 且在受限环境下失败也只是返回 null（显示成"名字未知"），不影响主流程。
 */
function processNameOf(pid) {
  if (!pid) return null;
  try {
    if (process.platform !== 'win32') return null;
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', windowsHide: true });
    if (out.error || !out.stdout) return null;
    // 形如： "codex-core.exe","12345","Console","1","45,123 K"
    const m = out.stdout.match(/^"([^"]+)"/m);
    if (!m) return null;
    return m[1].replace(/\.exe$/i, '');   // 去掉 .exe，与 Get-Process 的 ProcessName 对齐
  } catch {
    return null;
  }
}

/**
 * 找出监听某端口的进程 PID（Windows 用 netstat，其它平台用 lsof）。
 *
 * ⚠️ 可能返回 null 即使端口确实被占 —— 受限沙箱里 `spawnSync` 会直接 EPERM，
 *    拿不到 netstat 输出。所以调用方**不能**把 null 当成"端口空闲"来断言，
 *    只能当成"查不到"。（实测踩过：沙箱里孤儿占着 17890，这里却报空闲。）
 *
 * 超过 1 秒才返回时记一条日志，便于区分"真的空闲"和"查询被拒"。
 */
function pidListeningOn(port) {
  if (!port) return null;
  const t0 = Date.now();
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
      if (out.error) {
        if (Date.now() - t0 > 1000 || out.error.code === 'EPERM') {
          log('warn', `查不到端口 ${port} 的归属：${out.error.code || out.error.message}` +
            `（受限环境会导致 netstat 不可用；这不代表端口空闲）`);
        }
        return null;
      }
      if (!out.stdout) return null;
      for (const line of out.stdout.split('\n')) {
        // 形如：  TCP    127.0.0.1:17890        0.0.0.0:0              LISTENING       12345
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
        if (m && Number(m[1]) === Number(port)) return Number(m[2]);
      }
      return null;
    }
    // 非 Windows：用 lsof 兜底（没有就返回 null，退化为只有保险 1 生效）
    const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    if (out.error) return null;
    const pid = Number(String(out.stdout || '').trim().split('\n')[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 能否查询端口归属（沙箱里 netstat 不可用时为 false，此时不该声称"端口空闲"） */
let portLookupUsable = null;
function canLookupPorts() {
  if (portLookupUsable !== null) return portLookupUsable;
  try {
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    portLookupUsable = !out.error && typeof out.stdout === 'string' && out.stdout.length > 0;
  } catch {
    portLookupUsable = false;
  }
  return portLookupUsable;
}

/**
 * 记录自己启动的子进程，供下次启动时回收。
 *
 * 为什么需要：Windows 上强杀守护进程（任务管理器结束进程、控制台被关掉）
 * **不会执行任何清理逻辑**，ssh / xray / mihomo 会变成孤儿继续占着 17891~17893。
 * 下次启动时如果端口被孤儿占着，新出口就起不来，而且健康探测可能"成功"
 * （连到孤儿上）—— 这是唯一一种"看起来正常其实不对"的状态。
 *
 * 格式固定为 { daemon: <pid>, pids: [...] } —— 测试按这个格式断言，别改。
 */
function recordChildren(daemonPid, children) {
  try {
    const pids = [];
    for (const c of children) {
      const pid = c?.child?.pid ?? c?.pid ?? null;
      if (pid) pids.push(pid);
    }
    fs.writeFileSync(CHILDREN_FILE, JSON.stringify({ daemon: daemonPid ?? null, pids }, null, 2));
    return pids;
  } catch { return []; }
}

/**
 * 回收上一轮留下的孤儿。两道保险，各自独立有效：
 *
 *   保险 1：读 children.json 里记录的 pid，逐个确认还活着就杀掉。
 *           覆盖"我们正常记录过、但没来得及清理"的情形。
 *   保险 2：按端口反查（17890~17893），占着这些端口的进程若不是当前守护进程
 *           自己的子进程，就当孤儿清掉。
 *           覆盖"连记录都没写下来"的情形（比如上次是被硬杀在写文件之前）。
 *
 * ★ 两道都要有 ★
 *   只有保险 1：上次没写成 children.json 就白搭。
 *   只有保险 2：孤儿若没占那几个端口（比如改过端口）就漏了。
 *   （测试 05 专门分别验证这两条，早期版本因为格式不匹配让保险 1 空转、
 *     而保险 2 恰好清掉了同批进程，于是"看起来通过"。）
 */
function reapPreviousChildren(cfg) {
  const reaped = [];
  const seen = new Set([process.pid]);   // 绝不杀自己

  // ---- 保险 1：按记录回收
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(CHILDREN_FILE, 'utf8')); } catch { rec = null; }
  if (rec && Array.isArray(rec.pids)) {
    for (const pid of rec.pids) {
      const n = Number(pid);
      if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
      seen.add(n);
      if (!isAlive(n)) continue;
      log('warn', `回收上一轮遗留的子进程 pid=${n}（来自 children.json）`);
      killTree(n);
      reaped.push(n);
    }
  }

  // ---- 保险 2：按端口反查
  const ports = [cfg?.listen?.port, cfg?.uplinks?.ssh?.port, cfg?.uplinks?.xray?.port, cfg?.uplinks?.clashParty?.mixedPort]
    .map(Number).filter((p) => Number.isFinite(p) && p > 0);
  for (const p of ports) {
    const owner = pidListeningOn(p);
    if (!owner || seen.has(owner)) continue;
    seen.add(owner);
    log('warn', `回收占用端口 ${p} 的遗留进程 pid=${owner}（端口反查）`);
    killTree(owner);
    reaped.push(owner);
  }

  if (reaped.length) log('warn', `共回收 ${reaped.length} 个上一轮遗留进程`);
  try { fs.unlinkSync(CHILDREN_FILE); } catch {}
  return reaped;
}

/** 等待端口被释放（回收孤儿后用它确认，避免"刚杀完就启动"仍撞端口） */
async function waitPortFree(port, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (!pidListeningOn(port)) return true;
    await sleep(250);
  }
  return !pidListeningOn(port);
}

/**
 * 从订阅 YAML 的 proxies 段里解析出节点列表。
 *
 * 支持两种写法（Clash Party 的订阅两种都会出现）：
 *   流式：  - { name: '🇯🇵 日本1', type: ss, server: a.b, port: 11001, cipher: x }
 *   块式：  - name: 🇯🇵 日本1
 *             type: ss
 *             server: a.b
 *
 * ★ 流式是主流，必须支持 ★
 *   早期版本只认块式，结果解析出 55 个【空对象】（每个 `- {…}` 都被当成
 *   "只有一个键、值是 `{…}`"而被丢弃），于是"回落出口没有可用节点"——
 *   而文件里明明有 55 个节点。这是踩过的坑。
 *
 * 还要处理引号内的逗号：`- { name: '官网: www.雨燕云.com', type: ss, … }`
 * 里的逗号不能当分隔符，所以分隔时要跟踪引号状态。
 */
function parseProfileProxies(text) {
  const lines = text.split(/\r?\n/);
  let inProxies = false, cur = null, baseIndent = null;
  const out = [];
  const push = () => { if (cur && Object.keys(cur).length) out.push(cur); cur = null; };

  for (const line of lines) {
    if (/^proxies\s*:/.test(line)) { inProxies = true; continue; }
    if (!inProxies) continue;
    if (/^\S/.test(line)) { push(); inProxies = false; continue; }   // 段结束
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;

    const indent = line.match(/^\s*/)[0].length;

    if (t.startsWith('- ')) {
      push();
      baseIndent = indent;
      const rest = t.slice(2).trim();
      if (rest.startsWith('{')) {
        // ---- 流式：整行就是一个节点
        cur = parseFlowMap(rest);
        push();
      } else {
        // ---- 块式：第一行是第一个键，后续行缩进更深
        cur = {};
        const i = rest.indexOf(':');
        if (i > 0) setParsedKey(cur, rest.slice(0, i).trim(), rest.slice(i + 1).trim());
      }
      continue;
    }

    // 块式的后续键值行
    if (cur && baseIndent !== null && indent > baseIndent) {
      const i = t.indexOf(':');
      if (i > 0) {
        const k = t.slice(0, i).trim();
        const v = t.slice(i + 1).trim();
        if (!v.startsWith('{') && !v.startsWith('[')) setParsedKey(cur, k, v);
      }
    }
  }
  push();
  return out;
}

/**
 * 解析流式 YAML map：`{ k: v, k2: v2, ... }`
 * 按【嵌套深度】和【引号状态】切分，所以：
 *   · 值里的逗号不会把条目切断（节点名 `'官网: www.x.com'`）
 *   · 嵌套的流式 map/数组不会被切碎（`ech-opts: { enable: true, config: xxx }`）
 */
function parseFlowMap(s) {
  let body = s.trim();
  if (body.startsWith('{')) body = body.slice(1);
  if (body.endsWith('}')) body = body.slice(0, -1);

  const parts = splitFlow(body);

  const obj = {};
  for (const p of parts) {
    // 只按【第一个】顶层冒号切分：值里可能有冒号（节点名、ech 配置等）
    let cut = -1, quote = null, depth = 0;
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === ':' && depth === 0) { cut = i; break; }
    }
    if (cut < 0) continue;
    const k = p.slice(0, cut).trim();
    const vRaw = p.slice(cut + 1).trim();
    if (!k) continue;
    const v = unquote(vRaw);
    // 端口类键转成 number（mihomo 要求 port 是数字）
    obj[k] = (isPortLikeKey(k) && /^\d+$/.test(v)) ? Number(v) : v;
  }
  return obj;
}

/** 按顶层逗号切分流式内容（跟踪引号与 {} [] 嵌套深度） */
function splitFlow(body) {
  const parts = [];
  let buf = '', quote = null, depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      buf += c;
      if (c === '\\' && i + 1 < body.length) { buf += body[++i]; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '{' || c === '[') { depth++; buf += c; continue; }
    if (c === '}' || c === ']') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

function unquote(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}

const MIHOMO_TYPES = new Set(['ss', 'ss2022', 'vmess', 'vless', 'trojan', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'socks5', 'http', 'snell', 'wireguard', 'mieru', 'ssh']);

class ClashPartyUplink {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.port = cfg.mixedPort || 17893;
    this.socksPort = this.port + 1000;   // 供内层使用
    this.stopping = false;
    this.nodes = [];
    this.logFile = path.join(LOG_DIR, 'fallback-mihomo.log');
    this.configFile = path.join(FALLBACK_DIR, 'config.yaml');
  }

  get name() { return 'clash-party'; }

  /**
   * 找 mihomo 内核。
   *
   * ★ 必须优先用我们自己的副本 bin\codex-core.exe ★
   *   为什么不能用 Clash Party 自带的 mihomo.exe：
   *   Clash Party 启动时会做"高权限内核检测"，而那个检测**纯按进程名匹配**
   *   （mihomo.exe / mihomo-alpha.exe / mihomo-smart.exe）。它一旦看到有 mihomo.exe 在跑，
   *   就弹窗要求"以管理员身份重启"，而**点取消 = Clash Party 直接退出**。
   *   所以我们的回落出口把内核复制成 bin\codex-core.exe 再启动，进程名就不是 mihomo 了。
   *   （改名是安全的：mihomo 不依赖自己的文件名。）
   */
  coreExe() {
    if (this.cfg.coreExe && fs.existsSync(this.cfg.coreExe)) return this.cfg.coreExe;

    // 首选：我们自己的副本（改过名，不会触发 Clash Party 的高权限检测）
    const mine = path.join(HERE, 'bin', 'codex-core.exe');
    if (fs.existsSync(mine)) return mine;

    // 退路：Clash Party 自带的 mihomo.exe —— 会触发那个检测，只在没有副本时才用
    for (const c of this.coreCandidates()) if (fs.existsSync(c)) {
      log('warn', `回落出口将直接使用 Clash Party 的 mihomo.exe（${c}）—— 可能触发它的"高权限内核"检测弹窗。` +
        `建议把内核复制一份到 ${mine}（或跑 bin\\fetch-binaries.ps1）`);
      return c;
    }

    // 最后一道：有界搜索（Clash Party 装在非常规位置时）
    //
    // 为什么需要它：上面那批候选路径是"按惯例猜"的，猜不中就返回 null，
    // 于是回落出口起不来、而用户只看到一句"找不到内核"。实测这台机器的 Clash Party
    // 就装在 D 盘 —— 早期靠一条硬编码路径兜住，去掉硬编码后必须有等价的兜底。
    const found = this.findCoreBySearch();
    if (found) {
      log('warn', `按惯例路径没找到内核，搜索后在 ${found} 找到 —— 会触发 Clash Party 的"高权限内核"检测弹窗。` +
        `强烈建议跑 bin\\fetch-binaries.ps1 把它复制成 ${mine}`);
      return found;
    }
    return null;
  }

  /** Clash Party 自带内核的候选路径 */
  coreCandidates() {
    const names = ['mihomo.exe', 'mihomo', 'clash-meta.exe', 'clash.exe', 'verge-mihomo.exe'];
    const out = [];
    // 1) 配置里的数据目录（最权威 —— 用户可以在配置里改）
    for (const n of names) out.push(path.join(this.cfg.dataDir, n), path.join(this.cfg.dataDir, 'sidecar', n));

    // 2) Clash Party 的常见安装位置
    //
    // ★ 不要写死某台机器的路径 ★
    //   早期这里硬编码了一条 `D:\Program Files\Mihomo Party\...`（作者机器上的位置），
    //   对别人毫无用处，而且会把本机路径带进脱敏模板。已去掉。
    //
    //   补偿办法（去掉硬编码不能变成"找不到"）：
    //     a) 环境变量给出的根（LOCALAPPDATA / ProgramFiles / ProgramFiles(x86)）
    //     b) 常见盘符 + 常见安装目录名（含 Program Files 与直接盘根两种）
    //     c) 上面都不中时，做一次【有界】目录搜索（只扫两层，见 findCoreBySearch）
    //   最好的办法其实是把内核复制到 bin\codex-core.exe（bin\fetch-binaries.ps1 一键做），
    //   本函数只是最后一道退路。
    const relDirs = [
      path.join('Mihomo Party', 'Clash Party', 'resources', 'sidecar'),
      path.join('Mihomo Party', 'Clash Party', 'resources'),
    ];
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      // 盘根与"盘符 + Program Files"：实测这台机器就装在 D 盘的 Program Files 下
      ...['C:', 'D:', 'E:', 'F:'].flatMap((d) => [`${d}\\`, `${d}\\Program Files\\`, `${d}\\Program Files (x86)\\`]),
    ].filter(Boolean);
    for (const base of [...new Set(roots)]) {
      for (const r of relDirs) {
        for (const n of names) out.push(path.join(base, r, n));
      }
    }
    return out;
  }

  /**
   * 有界搜索：在常见根目录下找 `resources\sidecar\mihomo.exe`。
   *
   * 只在 coreExe() 的候选路径【全部落空】时才调用 —— 那是"用户的 Clash Party
   * 装在非常规位置"的情况。深度限制到 4 层、且只看目录名匹配的，避免全盘扫描。
   */
  findCoreBySearch() {
    const fsMod = fs;
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      // 常见盘符 × 常见安装前缀。必须显式列出"盘符 + Program Files"——
      // 实测这台机器的 Clash Party 就在 `D:\Program Files\...`，
      // 只给 `D:\` 是进不去的（虽然理论上能靠遍历下去，但那样会扫整个盘）。
      ...['C:', 'D:', 'E:', 'F:'].flatMap((d) => [
        `${d}\\`, `${d}\\Program Files\\`, `${d}\\Program Files (x86)\\`,
      ]),
    ].filter(Boolean);
    const seen = new Set();
    // ★ 要往下走的目录名 ★
    //   踩过的坑：原来只写 /mihomo|clash/，结果在最后一层断了 ——
    //   路径是 `…\Clash Party\resources\sidecar\mihomo.exe`，中间那层叫
    //   **`resources`**，不含 mihomo/clash，于是遍历不进去、永远返回 null（4ms 就退出）。
    //   Program Files 同理：D 盘装的话必须能进去。
    const WALK_INTO = /mihomo|clash|program files|resources/i;
    const walk = (dir, depth) => {
      if (depth > 5 || seen.has(dir)) return null;
      seen.add(dir);
      let entries;
      try { entries = fsMod.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        // 命中 sidecar 目录就找内核
        if (e.name.toLowerCase() === 'sidecar') {
          for (const n of ['mihomo.exe', 'mihomo', 'clash-meta.exe', 'verge-mihomo.exe']) {
            const cand = path.join(p, n);
            if (fsMod.existsSync(cand)) return cand;
          }
        }
        // 只沿着"名字像安装目录"的文件夹往下走（否则会扫爆整块盘）
        if (WALK_INTO.test(e.name)) {
          const hit = walk(p, depth + 1);
          if (hit) return hit;
        }
      }
      return null;
    };
    for (const r of [...new Set(roots)]) {
      const hit = walk(r, 0);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 读出当前生效订阅里的可用节点。
   *
   * ★ Clash Party 的文件结构（实测）★
   *   %APPDATA%\mihomo-party\profile.yaml        订阅【索引】：只有 current + items[].id/url，
   *                                              **不含节点**
   *   %APPDATA%\mihomo-party\profiles\<id>.yaml  真正的节点配置（由 profile.yaml 的 current 指向）
   *   所以必须顺着 `current` 去找 profiles\<current>.yaml。
   *   直接读 profile.yaml 会得到 0 个节点 —— 这是踩过的坑。
   */
  loadNodes() {
    const all = parseProfileProxies(this.readProfileText());
    const usable = all.filter((p) => p.name && p.server && p.port && MIHOMO_TYPES.has(String(p.type).toLowerCase()));
    const re = new RegExp(this.cfg.preferNodeNameRegex || '日本|JP|Japan|Tokyo', 'i');
    const preferred = usable.filter((p) => re.test(p.name));
    const chosen = (preferred.length ? preferred : usable).slice(0, this.cfg.maxNodes || 8);
    if (!chosen.length) throw new Error('订阅里没有 mihomo 支持的可用节点');
    this.nodes = chosen;
    return chosen;
  }

  /** 找到并读出当前订阅的 YAML 文本（兼容两种索引格式：YAML 与旧版 JSON） */
  readProfileText() {
    const dir = this.cfg.dataDir;
    const indexPath = path.join(dir, 'profile.yaml');
    if (!fs.existsSync(indexPath)) throw new Error(`读不到 Clash Party 订阅列表（${indexPath}）`);
    const text = fs.readFileSync(indexPath, 'utf8');

    let currentId = null;
    // 新版：YAML 索引，形如 `current: <id>`
    const m = text.match(/^current:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/m);
    if (m) currentId = m[1];
    // 旧版：JSON，形如 { "current": "<id>", "items": [...] }
    if (!currentId && text.trim().startsWith('{')) {
      try {
        const j = JSON.parse(text);
        currentId = j.current || (Array.isArray(j.items) ? j.items.find((i) => i.type === 'remote')?.id : null);
      } catch { /* 继续兜底 */ }
    }

    if (currentId) {
      const p = path.join(dir, 'profiles', `${currentId}.yaml`);
      if (fs.existsSync(p) && fs.statSync(p).size > 0) return fs.readFileSync(p, 'utf8');
    }
    // current 没写或文件为空：挑 profiles 下最大的一个（最可能是有内容的订阅）
    const pdir = path.join(dir, 'profiles');
    if (fs.existsSync(pdir)) {
      const best = fs.readdirSync(pdir)
        .map((n) => {
          let s = 0;
          try { s = fs.statSync(path.join(pdir, n)).size; } catch {}
          return { n, s };
        })
        .filter((x) => x.n.endsWith('.yaml') && x.s > 1024)
        .sort((a, b) => b.s - a.s)[0];
      if (best) return fs.readFileSync(path.join(pdir, best.n), 'utf8');
    }
    // 最后兜底：运行配置里可能含节点
    const runtime = path.join(dir, 'mihomo.yaml');
    if (fs.existsSync(runtime)) return fs.readFileSync(runtime, 'utf8');
    throw new Error('Clash Party 没有可用订阅');
  }

  /** 把一个节点写成 YAML 流式 map（mihomo 接受的写法） */
  nodeToYaml(n) {
    // ★ 必须 output `- { k: v, ... }` 这种 YAML 流式 map ★
    //   早期这里直接 `JSON.stringify(n)`，结果是：
    //     proxies:
    //     {"name":"🇯🇵 日本1","type":"anytls",...}     ← 没有 `- `，而且是 JSON 不是 YAML
    //   mihomo 直接报 `yaml: line 24: could not find expected ':'` 并退出，
    //   于是 clash-party 出口整个起不来、status 里那一行直接消失（实测踩过）。
    //   node-test 用的是另一条生成路径（已修好），所以只有回落出口坏 —— 容易漏掉。
    const kv = Object.entries(n)
      .filter(([k]) => k !== 'name')
      .map(([k, v]) => `${k}: ${yamlScalar(v)}`)
      .join(', ');
    return `  - { name: ${yamlScalar(n.name)}, ${kv} }`;
  }

  buildConfig() {
    const nodes = this.loadNodes();
    const names = nodes.map((n) => n.name);
    return [
      'mixed-port: ' + this.port,
      'allow-lan: false',
      'bind-address: 127.0.0.1',
      'mode: rule',
      'log-level: warning',
      'ipv6: false',
      'unified-delay: true',
      'tcp-concurrent: true',
      'find-process-mode: ' + "'off'",
      'dns:',
      '  enable: true',
      '  ipv6: false',
      '  enhanced-mode: fake-ip',
      '  fake-ip-range: 198.18.0.1/16',
      '  fake-ip-filter:',
      "    - '+.lan'",
      "    - '+.local'",
      '  default-nameserver:',
      "    - '223.5.5.5'",
      '  nameserver:',
      "    - 'https://223.5.5.5/dns-query'",
      "    - 'https://1.1.1.1/dns-query'",
      'proxies:',
      ...nodes.map((n) => this.nodeToYaml(n)),
      'proxy-groups:',
      '  - name: CODEX-JP',
      '    type: url-test',
      '    url: https://www.gstatic.com/generate_204',
      '    interval: 60',
      '    tolerance: 120',
      '    proxies:',
      ...names.map((n) => '      - ' + JSON.stringify(n)),
      'rules:',
      '  - MATCH,CODEX-JP',
      '',
    ].join('\n');
  }

  async start() {
    const exe = this.coreExe();
    if (!exe) { log('warn', '找不到 mihomo 内核，回落出口不可用'); return false; }
    const yaml = this.buildConfig();
    fs.writeFileSync(this.configFile, yaml);
    log('info', `回落出口使用 ${this.nodes.length} 个节点：${this.nodes.map((n) => n.name).join(' | ')}`);

    const out = fs.openSync(this.logFile, 'a');
    this.child = spawn(exe, ['-d', FALLBACK_DIR, '-f', this.configFile], {
      stdio: ['ignore', out, out], windowsHide: true, detached: false,
    });
    this.child.on('exit', (code) => log('warn', `回落 mihomo 退出 code=${code}`));

    for (let i = 0; i < 25; i++) {
      await sleep(400);
      if (await portOpen(this.port)) return true;
      if (this.child && this.child.exitCode !== null) break;
    }
    return false;
  }

  stop() {
    this.stopping = true;
    if (this.child) { try { this.child.kill(); } catch {} this.child = null; }
  }
}

// ---------------------------------------------------------------- 守护进程主体

class Daemon {
  constructor(cfg) {
    this.cfg = cfg;
    this.bridge = new Bridge(() => this.activeUplink);
    this.uplinks = [];
    this.activeUplink = null;
    this.pinnedUplink = null;          // use 命令钉住的出口（唯一能压过判定规则的机制）
    this.slowStreak = null;            // 性能判定"连续满足"计数
    this.latencyCooldownUntil = 0;     // 性能切换后的冷静期截止时间
    this.probeRunning = false;         // 探测防重入闸门
    this.health = new Map();
    this.probeTimer = null;
    this.token = crypto.randomBytes(24).toString('hex');
    this.startTime = Date.now();
  }

  async init() {
    const u = this.cfg.uplinks;
    const ssh = new SshTunnel(u.ssh);
    const xray = new XrayUplink(u.xray, this.cfg);
    const clash = new ClashPartyUplink(u.clashParty);
    this.ssh = ssh;
    this.xray = xray;
    this.clash = clash;

    log('info', '=== codex-proxy 启动 ===');
    log('info', `本地代理监听 127.0.0.1:${this.cfg.listen.port}（HTTP CONNECT + SOCKS5）`);

    // ★ 启动出口【之前】先回收上一轮的孤儿 ★
    //   Windows 上强杀守护进程不会执行清理逻辑，ssh/xray/mihomo 会变孤儿继续占端口。
    //   必须在启动自己的出口之前清掉，否则新出口绑不上端口，
    //   而健康探测还可能连到孤儿上"成功" —— 唯一一种"看着正常其实不对"的状态。
    try {
      const reaped = reapPreviousChildren(this.cfg);
      if (reaped.length) {
        // 等端口真正释放，避免"刚杀完就启动"仍撞端口
        for (const p of [this.cfg.uplinks.ssh?.port, this.cfg.uplinks.xray?.port, this.cfg.uplinks.clashParty?.mixedPort]) {
          if (p) await waitPortFree(Number(p), 5000);
        }
      }
    } catch (e) {
      log('warn', `回收上一轮遗留进程时出错（继续启动）：${e.message}`);
    }

    // 出口 1
    if (u.ssh.enabled) {
      log('info', '启动出口 1/3：SSH 隧道 -> 日本服务器');
      const ok = await ssh.start();
      log(ok ? 'info' : 'warn', `SSH 隧道 ${ok ? '已就绪' : '启动失败，将依赖后续出口'}`);
      this.uplinks.push({ name: ssh.name, port: ssh.port, priority: u.ssh.priority, obj: ssh });
    }

    // 出口 2
    if (u.xray.enabled) {
      log('info', '启动出口 2/3：xray 客户端 -> 日本服务器');
      const ok = await xray.start();
      log(ok ? 'info' : 'warn', `xray 出口 ${ok ? '已就绪' : '不可用'}`);
      if (ok) this.uplinks.push({ name: xray.name, port: xray.port, priority: u.xray.priority, obj: xray });
    }

    // 出口 3
    if (u.clashParty.enabled) {
      log('info', '启动出口 3/3：Clash Party 节点（回落）');
      try {
        const ok = await clash.start();
        log(ok ? 'info' : 'warn', `回落出口 ${ok ? '已就绪' : '不可用'}`);
        if (ok) this.uplinks.push({ name: clash.name, port: clash.port, priority: u.clashParty.priority, obj: clash });
      } catch (e) {
        log('warn', `回落出口初始化失败: ${e.message}`);
      }
    }

    if (!this.uplinks.length) throw new Error('没有任何可用出口，无法启动');

    this.uplinks.sort((a, b) => a.priority - b.priority);
    for (const l of this.uplinks) {
      this.health.set(l.name, {
        ok: false, failStreak: 0, okStreak: 0,
        lastMs: null, latencyFresh: false, handshakeMs: null, lastDetail: '未探测',
      });
    }

    const port = await this.bridge.listen(this.cfg.listen.port);
    log('info', `本地代理已监听 127.0.0.1:${port}`);

    // 记下自己启动的子进程，供下次启动时回收（格式见 recordChildren 注释）
    const pids = recordChildren(process.pid, [ssh, xray, clash]);
    log('info', `已记录子进程 ${pids.length} 个（供下次启动回收）：${pids.join(', ') || '无'}`);

    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ port, token: this.token, pid: process.pid, startedAt: new Date().toISOString() }, null, 2));
    fs.writeFileSync(PID_FILE, String(process.pid));

    await this.healthCheckAll(true);
    this.probeTimer = setInterval(() => this.healthCheckAll(false).catch(() => {}), this.cfg.health.intervalMs);
    setInterval(() => this.writeState(), 5000).unref();
    // 空闲超时兜底：上游"黑洞"时连接会一直卡着（不报错、不断开），客户端也就一直等。
    // 定期清掉长时间零数据的连接，逼客户端重连。
    const idleSec = Number(this.cfg.health.connIdleTimeoutSec ?? 0);
    if (idleSec > 0) {
      this.idleTimer = setInterval(() => {
        try { this.bridge.reapIdleConnections(idleSec * 1000); } catch {}
      }, Math.min(15000, Math.max(5000, (idleSec * 1000) / 3)));
      this.idleTimer.unref?.();
      log('info', `空闲连接清理已启用：${idleSec}s 无数据则断开（逼客户端重连）`);
    }
    this.writeState();
    log('info', `就绪。当前出口：${this.activeUplink ? this.activeUplink.name : '无'}`);
  }

  /**
   * 定时探测入口：带防重入。
   *
   * 为什么必须有防重入：每轮探测要发若干次网络请求，慢的时候可能超过 intervalMs。
   * 没有这个闸门，两轮会交错跑，failStreak / okStreak 被交错更新 ——
   * 表现为"明明网断了却一直判健康"，或反之（实测踩过）。
   */
  async healthCheckAll(initial) {
    if (this.probeRunning) {
      log('info', '上一轮健康探测还没跑完，跳过这一轮（避免计数被交错更新）');
      return;
    }
    this.probeRunning = true;
    try {
      await this.healthCheckOnce(initial);
    } finally {
      this.probeRunning = false;     // finally 保证：即使内部抛异常也会复位
    }
  }

  async healthCheckOnce(initial) {
    for (const l of this.uplinks) {
      const h = this.health.get(l.name);
      let anyOk = false, handshake = null;
      const fails = [];
      for (const t of this.cfg.health.targets) {
        const r = await probeVia(l.port, t, this.cfg.health.timeoutMs);
        if (r.ok) { anyOk = true; if (handshake === null || r.ms < handshake) handshake = r.ms; }
        else fails.push(`${t.host}: ${r.detail}`);
        if (initial && anyOk) break;
      }

      // ★ 连通性探测的 ms 不能当"延迟"用 ★
      //   probeVia 只测到本地出口端口的 SOCKS 握手：
      //     ssh:jp 的 SOCKS 服务在【远端】（ssh -D 在服务器上监听），所以它的数字是真实的
      //     绕行时间（~120ms）；而 xray/mihomo 的 SOCKS 服务在【本机】，隧道要等 CONNECT
      //     目标才建，所以本地握手 <1ms —— 显示成 0ms，而且会系统性压过 ssh:jp。
      //   后果：用这个数字做切换判据会一直偏向本机出口，"谁更快"从根上判断错了。
      //   所以这里额外做一次真实 HTTPS 往返（只取响应头，不下载），用它的耗时
      //   作为 lastMs（也就是 status 里显示的"延迟"和自动切换的判据）。
      let realMs = null;
      if (anyOk) {
        const lt = this.cfg.health.latencyTarget || { host: 'speed.cloudflare.com', path: '/__down?bytes=1' };
        const t0 = Date.now();
        const rt = await requestTiming(l.port, {
          host: lt.host, path: lt.path, maxBytes: 1, timeoutMs: this.cfg.health.timeoutMs,
        });
        if (rt.ok) realMs = Date.now() - t0;
      }

      if (anyOk) {
        h.okStreak++; h.failStreak = 0; h.ok = true;
        h.handshakeMs = handshake;                 // 保留握手值，仅供排查（不作判据）
        h.lastMs = realMs;
        h.latencyFresh = realMs !== null;          // 拿不到真实值就标不新鲜，宁可不用也不拿假数字
        h.lastDetail = realMs !== null ? '正常' : '正常（延迟未测到）';
      } else {
        h.failStreak++; h.okStreak = 0;
        h.lastDetail = fails[0] || '不通';
        h.latencyFresh = false;                    // 延迟数据作废，不能拿旧数字做切换判断
        // ★ 握手值也要作废 ★
        //   不清的话 status 会显示"上一轮成功探测的握手值"，而同一行的延迟是 `-`，
        //   看起来像"握手通、延迟不通"—— 其实这一轮【全部探测都失败了】，两个值都不可信。
        //   判据本来就只用 latencyFresh，这里只是让显示与事实一致。
        h.handshakeMs = null;
        if (h.failStreak >= this.cfg.health.failThreshold) h.ok = false;
      }
    }

    // 选出口 + 应用（逻辑抽在 selectUplink / applyUplink 里，便于测试）
    this.applyUplink(this.selectUplink());
  }

  /**
   * 挑出口。四层，顺序即优先级：
   *
   *   第 1 层  手动强制指定（use）—— 唯一能压过判定规则的机制；它自己变不健康就自动解除
   *   第 2 层  粘性：当前出口还健康 → 保持不动
   *   第 3 层  当前出口不可用 → 用 priority 挑第一个健康的
   *            ★ 这是 priority 唯一的用途 ★（初始选择 / 降级回落）
   *   第 4 层  性能判定：存在"超出宽容范围且明显更优"的候选 → 换过去（与 priority 无关）
   *
   * ★ 核心设计：priority 只在"第一次必须挑一个出来"时生效 ★
   *   之后无论自动切换还是手动 best，都由性能判定选最优，与谁优先级高无关。
   *
   * 第 2 层（粘性）不可省：没有它，"按优先级第一个健康出口"是无记忆的，
   * 会把任何基于性能的切换在下一轮推翻 —— 日志里会出现来回横跳。
   */
  selectUplink() {
    const healthy = this.uplinks.filter((l) => this.health.get(l.name).ok);
    const cur = this.activeUplink;
    const cfg = this.cfg.health;

    // 第 1 层：手动强制指定
    if (this.pinnedUplink) {
      const p = healthy.find((l) => l.name === this.pinnedUplink);
      if (p) return p;
      log('warn', `强制指定的出口 ${this.pinnedUplink} 已不健康，自动解除指定`);
      this.pinnedUplink = null;
    }

    // 第 2 层：粘性
    if (cur) {
      const stillOk = healthy.find((l) => l.name === cur.name);
      if (stillOk) {
        // 第 4 层：粘住不放，但如果它明显慢于别人，允许切走
        if (cfg.latencyAware !== false) return this.pickFasterUplink(healthy, stillOk);
        return stillOk;
      }
    }

    // 第 3 层：priority 挑第一个健康的
    const first = healthy[0] || null;
    if (first) {
      if (cur) log('info', `当前出口 ${cur.name} 不可用，按优先级回落到 ${first.name}`);
      this.slowStreak = null;          // 换了出口，性能计数重新开始
      return first;
    }
    return null;
  }

  /**
   * 性能判定的有状态外壳：把 slowStreak / latencyCooldownUntil 传给纯函数并收回结果。
   * 判定逻辑全在 decideLatencySwitch 里（可单测），这里只管状态与日志。
   */
  pickFasterUplink(healthy, current) {
    const cfg = this.cfg.health;
    const now = Date.now();
    const d = decideLatencySwitch({
      healthy,
      current,
      health: this.health,
      cfg,
      prevStreak: this.slowStreak,
      cooldownUntil: this.latencyCooldownUntil || 0,
      now,
    });
    this.slowStreak = d.streak;
    this.latencyCooldownUntil = d.cooldownUntil || 0;
    if (d.switch) {
      log('warn', `性能判定切换出口：${current.name}(${d.curMs}ms) -> ${d.cand.name}(${d.candMs}ms)` +
        `（连续 ${cfg.satisfiedPolls} 次满足，之后 ${Math.round(cfg.cooldownMs / 1000)}s 冷静期）`);
      return d.cand;
    }
    return current;
  }

  /**
   * 应用选中的出口。切换时**必须**断开挂在旧出口上的连接：
   * Codex（Chromium）会复用已建立的长连接，出口延迟爆炸时连接不会断、只是卡住，
   * 它会一直等，界面就呆住了；而且哪怕我们把出口切到健康的另一条，它仍复用那条卡住的连接，
   * 所以"切换出口"对已经卡住的界面完全无效 —— 只能重启应用（实测踩过）。
   * 断开后 Codex 会立刻重连，新连接走新出口。
   */
  applyUplink(next) {
    const prev = this.activeUplink;
    if (!next) {
      if (prev) log('warn', `所有出口均不健康，暂停转发（上一个：${prev.name}）`);
      this.activeUplink = null;
    } else if (!prev || prev.name !== next.name) {
      this.activeUplink = next;
      const ms = this.health.get(next.name)?.lastMs;
      log('info', `出口切换：${prev ? prev.name : '无'} -> ${next.name}（${ms ?? '?'}ms）`);
      if (prev) this.bridge.dropConnectionsOnUplink(prev.name, '切换出口');
    } else {
      this.activeUplink = next;
    }
    // 任何被判 DOWN 的出口，挂在它上面的连接也该断开。
    // 场景：界面正卡在 xray 上，探测把 xray 判 DOWN，但当前出口是另一条，
    // 上面那个"切换出口"分支就不会触发，卡住的连接就留着了。
    for (const l of this.uplinks) {
      const h = this.health.get(l.name);
      if (h && h.ok === false) this.bridge.dropConnectionsOnUplink(l.name, '该出口被判不健康');
    }
    this.writeState();
  }

  /** 解除手动强制指定；返回被解除的名字（没有则 null） */
  releasePin() {
    const was = this.pinnedUplink;
    this.pinnedUplink = null;
    return was || null;
  }

  /**
   * 实测所有出口，切到延迟最低的那个。
   *   opts.pin  = true  → 同时钉住（use 命令语义：强制固定）
   *   opts.name = 'x'   → 只切到指定出口（不实测全部；它自己不可用就拒绝）
   * 不传 opts 时（best 命令）只切换、不钉住 —— 因为"最优选择"本身就满足
   * "暂不切换"的判定条件（没有明显更优的候选），规则会自己留住它。
   */
  async measureAndSwitchBest(dlBytes, opts = {}) {
    const results = [];
    for (const l of this.uplinks) {
      log('info', `实测出口 ${l.name}…`);
      const m = await measureUplink(l, { dlBytes: dlBytes || 65536 });
      results.push(m);
      const h = this.health.get(l.name);
      if (m.ok && typeof m.latencyMs === 'number') {
        // 顺手把实测值写回健康状态：这样"切到最优"之后判定规则也知道各出口的真实水平
        h.lastMs = m.latencyMs;
        h.latencyFresh = true;
      }
    }
    const usable = results.filter((r) => r.ok && typeof r.latencyMs === 'number');
    if (!usable.length) return { ok: false, detail: '没有任何可用出口', measured: results };

    let target;
    if (opts.name) {
      target = usable.find((r) => r.name === opts.name);
      if (!target) {
        const why = results.find((r) => r.name === opts.name)?.err || '不可用';
        return { ok: false, detail: `出口 ${opts.name} 当前不可用（${why}）`, measured: results };
      }
    } else {
      target = usable.slice().sort((a, b) => a.latencyMs - b.latencyMs)[0];
    }

    const up = this.uplinks.find((l) => l.name === target.name);
    const fromName = this.activeUplink ? this.activeUplink.name : '无';
    if (opts.pin) this.pinnedUplink = target.name;
    // 直接应用：这里不该走 applyUplink 的"切换即断开旧连接"逻辑吗？——该走。
    // 手动指定出口同样要让 Codex 尽快摆脱卡住的旧连接。
    this.applyUplink(up);

    if (opts.pin) {
      this.slowStreak = null;
      this.latencyCooldownUntil = Date.now() + (this.cfg.health.cooldownMs || 120000);
      log('warn', `强制指定出口并钉住：${fromName} -> ${target.name}`);
      return {
        ok: true, action: 'switched', from: fromName, to: target.name,
        fromMs: results.find((x) => x.name === fromName)?.latencyMs ?? '?',
        toMs: target.latencyMs, pinned: true, measured: results,
      };
    }
    if (!opts.name) {
      // best：不钉住，但记下这次实测结果
      log('info', `best 切换到 ${target.name}（${target.latencyMs}ms，未钉住）`);
    }
    return {
      ok: true, action: 'switched', from: fromName, to: target.name,
      fromMs: results.find((x) => x.name === fromName)?.latencyMs ?? '?',
      toMs: target.latencyMs, pinned: false, measured: results,
    };
  }

  writeState() {
    const state = {
      pid: process.pid,
      startedAt: new Date(this.startTime).toISOString(),
      listenPort: this.cfg.listen.port,
      activeUplink: this.activeUplink ? this.activeUplink.name : null,
      pinnedUplink: this.pinnedUplink || null,
      uplinks: this.uplinks.map((l) => ({
        name: l.name,
        port: l.port,
        priority: l.priority,
        // pid 用于 status 里核对"占着这个端口的确实是我们自己的子进程"：
        // 残留孤儿进程会占着端口、健康探测还会"成功"，是唯一一种"看着正常其实不对"的状态
        pid: l.obj?.child?.pid ?? l.obj?.pid ?? null,
        ...this.health.get(l.name),
      })),
      stats: this.bridge.stats,
    };
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({
        port: this.cfg.listen.port,
        controlPort: this.controlPort ?? null,     // 控制端口：sendControl 靠它找到守护进程
        token: this.token,
        pid: process.pid,
        startedAt: state.startedAt,
      }, null, 2));
    } catch {}
  }

  async shutdown() {
    log('info', '收到停止信号，正在退出…');
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    await this.bridge.close().catch(() => {});
    // 同步杀进程树并等它们真的结束。
    // ★ 必须同步确认，不能只发个信号就走 ★
    //   子进程（ssh/xray/mihomo）要是不等它们退出就 process.exit，
    //   它们会变成孤儿继续占着 17891/17892/17893，下次启动就会"端口被占用"（已实测踩过）。
    for (const [name, obj] of [['ssh', this.ssh], ['xray', this.xray], ['clash', this.clash]]) {
      if (!obj) continue;
      const pid = obj.child?.pid ?? obj.pid ?? null;
      try { obj.stop?.(); } catch {}
      if (pid) {
        killTree(pid);
        log('info', `  ${name} (pid ${pid}) 已结束`);
      } else {
        log('info', `  ${name}: 无子进程，跳过`);
      }
    }
    for (const f of [PID_FILE, TOKEN_FILE, CHILDREN_FILE]) { try { fs.unlinkSync(f); } catch {} }
    log('info', '已停止');
    // 兜底：万一还有句柄没释放导致事件循环不退出，2 秒后强制结束
    setTimeout(() => process.exit(0), 2000).unref();
    process.exit(0);
  }
}

// ---------------------------------------------------------------- 测速（多出口对比）

/**
 * 测速用的下载源，按顺序尝试。
 * ★ 不能用 speed.cloudflare.com/__down?bytes=N ★
 *   实测：给它附加随机查询参数时会返回 0 字节（拿不到内容），
 *   表现为"下载速度 0.00 Mbps"，看着像网络问题其实是测速源的问题。
 *   改用 CDN 上的静态文件，稳定且带正常 Content-Length。
 */
const SPEED_SOURCES = [
  { host: 'cdnjs.cloudflare.com', path: '/ajax/libs/jquery/3.7.1/jquery.js' },
  { host: 'cdn.jsdelivr.net', path: '/npm/jquery@3.7.1/dist/jquery.js' },
];

/**
 * 实测一个出口的延迟与下载速度。
 *   latencySamples：做几次延迟取样，取最小值（最小值比平均值更能代表"最好能到多少"）
 *   dlBytes：下载多少字节来算吞吐
 * 返回 { name, ok, latencyMs, mbps, bytes, err }
 */
async function measureUplink(uplink, { latencySamples = 3, dlBytes = 262144 } = {}) {
  const samples = [];
  let lastErr = null;
  for (let i = 0; i < latencySamples; i++) {
    const r = await requestTiming(uplink.port, {
      host: 'www.gstatic.com', path: '/generate_204', maxBytes: 1, timeoutMs: 15000,
    });
    if (r.ok) samples.push(r.totalMs);
    else lastErr = r.err;
  }
  if (!samples.length) {
    return { name: uplink.name, ok: false, latencyMs: null, mbps: null, bytes: 0, err: lastErr || '探测失败' };
  }
  const latencyMs = Math.min(...samples);

  let dl = null, dlErr = null;
  for (const src of SPEED_SOURCES) {
    const r = await requestTiming(uplink.port, {
      host: src.host, path: src.path, maxBytes: dlBytes, timeoutMs: 30000,
    });
    if (r.ok && r.bytes > 0) { dl = r; dlErr = null; break; }
    dlErr = r.err || `下载为空（${src.host}）`;
  }
  if (!dl) {
    return { name: uplink.name, ok: true, latencyMs, mbps: null, bytes: 0, err: dlErr, samples };
  }
  const mbps = (dl.bytes * 8) / (dl.totalMs / 1000) / 1e6;
  return {
    name: uplink.name, ok: true, latencyMs, mbps, bytes: dl.bytes,
    // 带上这次下载的耗时与来源，供 speed 展示（早期漏了这两个字段，
    // 于是打印出来是 `[128.1KB/?ms]` —— 明明测到了却显示问号）
    totalMs: dl.totalMs, source: dl.source ?? null,
    samples, jitterMs: samples.length > 1 ? Math.max(...samples) - Math.min(...samples) : 0,
  };
}

// ---------------------------------------------------------------- 命令

/**
 * 控制端口：让 stop 能真正触发守护进程的优雅退出。
 *
 * 为什么不用信号：Windows 上 process.kill(pid,'SIGTERM') 是直接终止进程，
 * Node 的 'SIGTERM' 处理器根本不执行（已实测：日志里连一行都没有），
 * 于是 shutdown() 从不运行、xray/mihomo 全部变成孤儿继续占端口。
 * 所以这里开一个本机控制端口做 IPC：命令用 TOKEN_FILE 里的令牌鉴权。
 */
function startControlServer(daemon) {
  const srv = net.createServer((sock) => {
    let buf = '';
    let busy = false;                       // 长任务进行中：不再套用短空闲超时
    const reply = (obj) => { try { sock.end(JSON.stringify(obj)); } catch {} };

    // 空闲超时：只用来防"连上不发命令"的连接。
    // 注意必须能在长任务期间放宽 —— switch-best 要实测所有出口（每个出口取样+下载），
    // 中途不发任何数据，写死 8 秒会让服务端自己把连接断掉，客户端只拿到空响应，
    // 表现为"联系不上守护进程"而实际它正在正常干活（已实测踩过）。
    const idleMs = 8000;
    const busyMs = 300000;
    sock.setTimeout(idleMs, () => { if (!busy) sock.destroy(); });
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1 || buf.length > 4096) return;
      let msg;
      try { msg = JSON.parse(buf.slice(0, nl)); } catch { return reply({ ok: false, error: 'bad json' }); }
      if (msg.token !== daemon.token) return reply({ ok: false, error: 'bad token' });

      if (msg.cmd === 'stop') {
        reply({ ok: true, msg: 'stopping', pid: process.pid });
        setTimeout(() => { daemon.shutdown().catch(() => process.exit(1)); }, 60);
        return;
      }
      if (msg.cmd === 'ping') {
        return reply({ ok: true, pid: process.pid, uplink: daemon.activeUplink?.name ?? null, pinned: daemon.pinnedUplink ?? null });
      }
      if (msg.cmd === 'release-pin') {
        const was = daemon.releasePin();
        // 立刻落盘：不写的话 status 会继续显示"已强制指定"，最长 5 秒
        // （只有定时 writeState 才会刷新），看起来像 auto 没生效。
        daemon.writeState();
        return reply({ ok: true, released: was, current: daemon.activeUplink?.name ?? null });
      }
      if (msg.cmd === 'switch-best') {
        // 实测所有出口，切到延迟最低的那个。默认【不钉住】—— 最优选择本身就会满足
        // "暂不切换"的判定条件；只有 msg.args.pin 为真（use 命令）才强制钉住。
        busy = true;
        sock.setTimeout(busyMs, () => sock.destroy());
        daemon.measureAndSwitchBest(msg.args?.dlBytes, { pin: !!msg.args?.pin, name: msg.args?.name })
          .then((r) => reply(r))
          .catch((e) => reply({ ok: false, detail: e.message }));
        return;
      }
      reply({ ok: false, error: 'unknown cmd' });
    });
  });
  srv.on('error', () => { /* 控制端口开不起来不影响主功能，stop 会退回信号方式 */ });
  srv.listen(0, '127.0.0.1', () => {
    daemon.controlPort = srv.address().port;
    log('info', `控制端口已就绪 127.0.0.1:${daemon.controlPort}`);
    // ★ 必须把 controlPort 写进令牌文件 ★
    //   否则 sendControl 读不到控制端口，所有控制类命令（best/use/auto/优雅 stop）
    //   都会返回 null，表现为"联系不上守护进程"而实际它好好的。
    try { daemon.writeState(); } catch {}
  });
  return srv;
}

/**
 * 向守护进程的控制端口发一条命令。
 *
 * timeoutMs 必须可调：stop/ping 是毫秒级，但 switch-best 要在服务端实测所有出口的
 * 延迟+下载（几十秒），写死 6 秒会让客户端先超时、返回 null —— 表现为"联系不上守护进程"，
 * 而实际上守护进程正在正常干活（已实测踩过）。
 */
function sendControl(cmd, args = null, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const info = readJsonSafe(TOKEN_FILE);
    if (!info || !info.controlPort || !info.token) return resolve(null);
    const sock = net.connect({ host: '127.0.0.1', port: info.controlPort });
    let buf = '';
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeoutMs, () => done(null));
    sock.on('error', () => done(null));
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    sock.once('connect', () => {
      const msg = { cmd, token: info.token };
      if (args) msg.args = args;
      sock.write(JSON.stringify(msg) + '\n');
    });
  });
}

async function cmdDaemon(cfg) {
  openLog();
  const d = new Daemon(cfg);
  process.on('SIGINT', () => d.shutdown());
  process.on('SIGTERM', () => d.shutdown());
  process.on('uncaughtException', (e) => log('error', 'uncaught: ' + (e?.stack || e)));
  process.on('unhandledRejection', (e) => log('error', 'unhandled: ' + (e?.stack || e)));
  try {
    await d.init();
    startControlServer(d);
  } catch (e) {
    log('error', '初始化失败，进程退出：' + (e?.stack || e));
    await d.shutdown().catch(() => {});
    process.exit(1);
  }
  await new Promise(() => {});   // 常驻
}

function daemonPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    return Number.isFinite(pid) && isAlive(pid) ? pid : null;
  } catch {
    return null;      // pid 文件不存在/不可读 → 就是"没在运行"，不该抛异常
  }
}

async function cmdStart(cfg) {
  const pid = daemonPid();
  if (pid) { console.log(`codex-proxy 已在运行 (pid ${pid})`); return 0; }

  // ★ 先检查监听端口 ★
  //   不起这一步的话，端口被别人占着时我们会照常 spawn 守护进程，
  //   它绑不上端口就直接退出（日志里一句 EADDRINUSE），而 cmdStart 只报
  //   "启动失败" —— 看不出真正原因（实测踩过）。
  const port = Number(cfg.listen.port);
  const holder = pidListeningOn(port);
  if (holder) {
    // 端口被占但 pid 文件说没在跑 → 上一轮强杀留下的孤儿守护进程
    console.log(`监听端口 ${port} 被 pid ${holder} 占用（pid 文件说没在运行，判为上一轮残留），正在清理…`);
    killTree(holder);
    const freed = await waitPortFree(port, 8000);
    if (!freed) {
      console.error(`端口 ${port} 清理后仍被占用。请手动排查： netstat -ano | Select-String ${port}`);
      return 1;
    }
    console.log(`端口 ${port} 已释放`);
  }

  console.log('启动 codex-proxy 守护进程…');
  // ★ 先把上一轮的 state.json 删掉 ★
  //   否则新守护进程还在初始化时，这里会读到【上一轮】留下的状态文件，
  //   于是打印出过期的出口名（实测见过 "出口 = dead"，那是上次探测用的假出口）。
  try { fs.unlinkSync(STATE_FILE); } catch {}
  const spawnAt = Date.now();
  const logOut = fs.openSync(path.join(LOG_DIR, `launch-${new Date().toISOString().slice(0, 10)}.log`), 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], {
    detached: true, stdio: ['ignore', logOut, logOut], windowsHide: true, cwd: HERE,
  });
  child.unref();

  // 等待就绪。startedAt 校验：只认【本次】启动写下的状态，避免被过期文件骗到。
  //
  // ★ 不能"没看到 pid 就放弃" ★
  //   守护进程是 detached 启动的，它写完 pid 文件需要时间；而三出口全启更慢
  //   （回落出口要先把 mihomo 拉起来，实测累计 10 秒以上）。
  //   早期这里是 `if (!daemonPid() && i > 6) break;` —— 只等 3.5 秒就放弃，
  //   结果三出口就绪时 start 早就报了"启动失败"，而守护进程其实好好地跑着（实测踩过）。
  //   现在改成：只要【本地的代理端口已经在监听】就说明它活着，继续等它报出健康出口。
  const bootWaitMs = 60000;
  const deadline = Date.now() + bootWaitMs;
  for (let i = 0; Date.now() < deadline; i++) {
    await sleep(500);
    const st = readJsonSafe(STATE_FILE);
    const fresh = st && st.startedAt && Date.parse(st.startedAt) >= spawnAt - 1000;
    if (fresh && st.activeUplink && daemonPid()) {
      console.log(`已启动 (pid ${st.pid})，本地代理 127.0.0.1:${st.listenPort}，出口 = ${st.activeUplink}`);
      return 0;
    }
    // 三种"确实还活着"的证据，任一成立就继续等：
    //   ① pid 文件有效  ② 我们的监听端口在监听  ③ 状态文件是本次写的
    const portUp = cfg.listen.port ? !!pidListeningOn(cfg.listen.port) : false;
    const alive = daemonPid() || portUp || (fresh && st.pid);
    // 连续 10 秒（20 轮）完全没有任何存活证据才判定失败
    if (!alive && i > 20) break;
  }
  const st = readJsonSafe(STATE_FILE);
  const pidNow = daemonPid();
  if (pidNow) {
    console.log(`守护进程在跑 (pid ${pidNow})，但还没有健康出口（可能是出口都还没起来）。`);
    console.log(`  看日志：logs\\daemon-${new Date().toISOString().slice(0, 10)}.log`);
    console.log(`  看状态：.\\codex-proxy.ps1 status`);
    return 1;
  }
  if (cfg.listen.port && pidListeningOn(cfg.listen.port)) {
    console.log(`守护进程看起来在运行（127.0.0.1:${cfg.listen.port} 已监听），但写不出状态文件。`);
    console.log(`  看日志：logs\\daemon-${new Date().toISOString().slice(0, 10)}.log`);
    return 1;
  }
  console.error('启动失败。看日志：logs\\launch-*.log 与 logs\\daemon-*.log');
  return 1;
}

/** down：停代理 + 关掉 Codex 桌面应用（stop 只停代理） */
async function cmdDown(cfg) {
  // 先关 Codex，再停代理：顺序反过来的话 Codex 会短暂处于"没有代理可用"的状态
  const names = cfg.codex?.processNames || ['ChatGPT', 'Codex'];
  for (const n of names) {
    const pids = listProcesses(n);
    for (const pid of pids) {
      try { killTree(pid); console.log(`已结束 ${n} (pid ${pid})`); } catch {}
    }
  }
  return await cmdStop();
}

function cmdStop() {
  const pid = daemonPid();
  if (!pid) { console.log('codex-proxy 没有在运行'); return 0; }
  // 先用控制端口请求优雅退出；控制端口不可用时退回信号
  // （Windows 上信号是直接终止，子进程会变孤儿，所以优先走控制端口）
  return (async () => {
    const r = await sendControl('stop', null, 8000);
    if (r && r.ok) {
      console.log(`已请求停止 (pid ${pid})`);
      // 等它真的退出，最多 8 秒，避免"刚 stop 就 start"撞上端口占用
      for (let i = 0; i < 40; i++) {
        await sleep(200);
        if (!daemonPid()) return 0;
      }
      console.log('守护进程未在 8 秒内退出，将强制结束');
    }
    try { process.kill(pid, 'SIGTERM'); } catch (e) { console.error('停止失败: ' + e.message); return 1; }
    console.log(`已发送停止信号 (pid ${pid})`);
    return 0;
  })();
}

function cmdStatus() {
  const pid = daemonPid();
  const st = readJsonSafe(STATE_FILE);
  if (!pid) {
    console.log('状态：未运行');
    return 1;
  }
  console.log(`状态：运行中 (pid ${pid})`);
  if (!st) { console.log('（暂无状态文件）'); return 0; }
  const pinned = st.pinnedUplink ? `  【已强制指定：${st.pinnedUplink}】` : '';
  console.log(`监听：127.0.0.1:${st.listenPort}  出口：${st.activeUplink ?? '无'}${pinned}`);
  if (st.pinnedUplink) {
    console.log(`  ↑ 你强制指定了 ${st.pinnedUplink}，判定规则不接管；想恢复自动：.\\codex-proxy.ps1 auto`);
  }
  console.log('');
  console.log('出口            端口    优先级  健康   延迟*     握手    说明');
  console.log('-'.repeat(78));
  for (const u of st.uplinks) {
    const lat = (u.latencyFresh && typeof u.lastMs === 'number') ? u.lastMs + 'ms' : '-';
    const shake = (typeof u.handshakeMs === 'number') ? u.handshakeMs + 'ms' : '-';
    console.log(
      String(u.name).padEnd(15) +
      String(u.port).padEnd(8) +
      String(u.priority).padEnd(8) +
      String(u.ok ? 'OK' : 'DOWN').padEnd(7) +
      lat.padEnd(10) +
      shake.padEnd(8) +
      (u.lastDetail || '')
    );
  }
  console.log('  * 延迟 = 一次真实 HTTPS 往返（只取响应头）；握手 = 只到本地出口端口的 SOCKS 握手。');
  console.log('    本机出口的握手值恒为 0~2ms，不能当延迟用 —— 这就是为什么用真实往返作判据。');
  const s = st.stats || {};
  // 活动连接分布在哪个出口 —— 排查"切换后界面还是呆住"时最有用的一行：
  // 如果活动连接还挂在旧出口上，说明它们还没被断开重建。
  if ((s.active ?? 0) > 0) {
    const dist = Object.entries(s.byUplink || {})
      .filter(([, v]) => (v.active || 0) > 0)
      .map(([n, v]) => `${n} ${v.active} 条`)
      .join('，');
    console.log(`  活动连接分布：${dist || '(未标注)'}`);
  }
  console.log('');
  console.log(`连接数：${s.connects ?? 0}  失败：${s.errors ?? 0}  当前活动：${s.active ?? 0}  上行 ${fmtBytes(s.bytesUp)} / 下行 ${fmtBytes(s.bytesDown)}`);

  // 按出口分桶的流量 —— 回答"切换时流量实际走了哪条"最直接的证据。
  // 与上面那个总计的区别：这里带【出口名】，所以能看出切换前后各走了多少。
  const byU = s.byUplink || {};
  const names = Object.keys(byU);
  if (names.length) {
    console.log('');
    console.log('各出口实际承载的流量（累计，按连接建立时的出口归属）：');
    console.log('  出口            连接数   活动   上行        下行        最后使用');
    console.log('  ' + '-'.repeat(70));
    const ordered = [...names].sort((a, b) => (byU[b].connects || 0) - (byU[a].connects || 0));
    for (const n of ordered) {
      const u = byU[n];
      const last = u.lastAt ? new Date(u.lastAt).toLocaleTimeString('zh-CN', { hour12: false }) : '-';
      console.log('  ' + String(n).padEnd(15) +
        String(u.connects ?? 0).padStart(5) + '  ' +
        String(u.active ?? 0).padStart(5) + '  ' +
        fmtBytes(u.bytesUp).padStart(10) + '  ' +
        fmtBytes(u.bytesDown).padStart(10) + '  ' +
        last);
    }
    console.log('  说明：连接建立时就确定了走哪个出口；切换只影响【之后新建】的连接，');
    console.log('        已在传输的连接留在旧出口直到结束（切换时会主动断开旧出口的连接，');
    console.log('        让客户端尽快改走新出口）。');
  }

  // 端口归属检查：确认占着这些端口的确实是我们自己的子进程。
  // 为什么要查：上一轮强杀后可能残留孤儿进程继续占端口，那种情况下健康探测会"成功"，
  // 于是把孤儿当成自己的出口用 —— 这是唯一一种"看起来正常其实不对"的状态。
  const ports = [['本地代理', st.listenPort], ...(st.uplinks || []).map((u) => [u.name, u.port])];
  console.log('');
  console.log('端口归属：');
  // 先确认"能不能查"。查不到时不能显示成"无监听"，那会让人以为端口空闲（实测踩过：
  // 沙箱里孤儿占着 17890，这里却显示"无监听"）。
  if (!canLookupPorts()) {
    console.log('  （本环境禁止查询端口归属：netstat 被拒。可忽略 —— 正常 Windows 终端里会显示 PID）');
    return 0;
  }
  let foreign = 0;
  for (const [label, p] of ports) {
    if (!p) continue;
    const owner = pidListeningOn(p);
    if (!owner) { console.log(`  ${String(p).padEnd(6)} ${String(label).padEnd(14)} 无监听`); continue; }
    const pname = processNameOf(owner);
    const nameStr = pname ? pname.padEnd(12) : '(名字未知)'.padEnd(12);
    if (owner === pid) {
      console.log(`  ${String(p).padEnd(6)} ${String(label).padEnd(14)} PID=${String(owner).padEnd(7)} ${nameStr} 守护进程本身`);
      continue;
    }
    const uplink = (st.uplinks || []).find((u) => u.port === p);
    const isOurs = uplink?.pid && owner === uplink.pid;
    if (!isOurs) foreign++;
    console.log(`  ${String(p).padEnd(6)} ${String(label).padEnd(14)} PID=${String(owner).padEnd(7)} ${nameStr} ${isOurs ? '子进程' : '⚠ 不是我们的子进程（疑似上一轮残留）'}`);
  }
  // 显示进程名是为了让"是不是我们的"一眼可见：
  //   codex-core = 我们改过名的回落内核  ← 正常
  //   mihomo     = 退回用了 Clash Party 的内核（会触发它的高权限检测弹窗），
  //                或者干脆是 Clash Party 自己的内核占了端口
  const seenNames = ports.map(([, p]) => (p ? processNameOf(p) : null)).filter(Boolean);
  if (seenNames.includes('mihomo')) {
    console.log('');
    console.log('  ⚠ 上面有 mihomo 进程。两种可能：');
    console.log('     ① 我们的回落实例退回了 Clash Party 的内核（bin\\codex-core.exe 缺失）——');
    console.log('        跑 bin\\fetch-binaries.ps1 补上副本即可（不补会触发 Clash Party 的检测弹窗）');
    console.log('     ② 那是 Clash Party 自己的内核（它的进程名就是 mihomo）—— 与我们无关');
    console.log('     区分方法：.\\codex-proxy.ps1 stop 后再看这个端口还在不在');
  }
  if (foreign) console.log('  ⚠ 有端口被非本守护进程的子进程占用，建议 stop 后清理再 start');
  return 0;
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + u[i];
}

async function cmdCheck(cfg, argv) {
  const port = cfg.listen.port;
  const targets = cfg.health.targets;
  console.log(`本地代理 127.0.0.1:${port}`);
  console.log('');

  let ok = false;
  for (const t of targets) {
    const t0 = Date.now();
    try {
      const sock = await socksConnect(port, t.host, t.port, 12000);
      const ms = Date.now() - t0;
      sock.destroy();
      console.log(`  [OK]   ${t.host}:${t.port}  ${ms}ms`);
      ok = true;
    } catch (e) {
      console.log(`  [FAIL] ${t.host}:${t.port}  ${e.message}`);
    }
  }

  console.log('');
  console.log('出口 IP 实测：');
  for (const url of ['https://api.ipify.org/', 'https://ipinfo.io/json']) {
    const r = await httpsViaProxy(port, url);
    console.log(`  ${url} -> ${r}`);
  }

  const st = readJsonSafe(STATE_FILE);
  if (st) {
    console.log('');
    console.log(`当前出口链路：${st.activeUplink ?? '无'}`);
    console.log('');
    console.log('提示：上面显示的 IP 应该是你日本服务器的 YOUR_SERVER_IP。');
    console.log('      如果是机场节点 IP，说明 SSH 隧道不通、已经回落到 Clash Party 节点。');
  }
  return ok ? 0 : 1;
}

/** 用最朴素的方式经本地代理发一个 HTTPS 请求（CONNECT + TLS），避免依赖 fetch 的代理能力 */
function httpsViaProxy(proxyPort, url) {
  return new Promise(async (resolve) => {
    let tls, sock;
    try {
      const u = new URL(url);
      sock = await socksConnect(proxyPort, u.hostname, Number(u.port) || 443, 12000);
      tls = (await import('node:tls')).connect({ socket: sock, servername: u.hostname });
      const chunks = [];
      const timer = setTimeout(() => { try { tls.destroy(); } catch {} resolve('timeout'); }, 15000);
      tls.on('error', (e) => { clearTimeout(timer); resolve('tls error: ' + e.message); });
      tls.on('secureConnect', () => {
        tls.write(`GET ${u.pathname || '/'} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: codex-proxy-check\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
      });
      tls.on('data', (d) => chunks.push(d));
      tls.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
        resolve(body.replace(/\s+/g, ' ').slice(0, 200) || '(空响应)');
      });
    } catch (e) {
      try { sock?.destroy(); tls?.destroy(); } catch {}
      resolve('失败: ' + e.message);
    }
  });
}

function proxyEnv(port, extra = {}) {
  const url = `http://127.0.0.1:${port}`;
  const socks = `socks5h://127.0.0.1:${port}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    ALL_PROXY: socks,
    all_proxy: socks,
    // 本机地址一律不走代理。加上整个 127.0.0.0/8 —— 有些实现只按 CIDR 匹配，
    // 只写 127.0.0.1 的话，127.0.0.2 之类就会被绕进代理（罕见但没必要冒这个险）。
    NO_PROXY: 'localhost,127.0.0.1,::1,127.0.0.0/8',
    no_proxy: 'localhost,127.0.0.1,::1,127.0.0.0/8',
    CODEX_PROXY_ACTIVE: '1',
    CODEX_PROXY_ENDPOINT: url,
    ...extra,
  };
}

async function ensureRunning(cfg) {
  if (daemonPid()) return 0;
  const rc = await cmdStart(cfg);
  if (rc !== 0) return rc;
  return 0;
}

async function cmdRun(cfg, argv) {
  const rc = await ensureRunning(cfg);
  if (rc !== 0) return rc;
  const rest = argv.filter((a) => a !== '--');
  const exe = cfg.codex.cliExe || 'codex';
  console.log(`以代理 ${cfg.listen.port} 启动：${exe} ${rest.join(' ')}`);
  const child = spawn(exe, rest, {
    stdio: 'inherit',
    env: { ...process.env, ...proxyEnv(cfg.listen.port, cfg.codex.extraEnv) },
    shell: process.platform === 'win32',
  });
  return await new Promise((r) => child.on('exit', (code) => r(code ?? 0)));
}

function listProcesses(name) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`], { encoding: 'utf8' });
  return (r.stdout || '').split(/\s+/).filter(Boolean).map(Number);
}

/**
 * 判断已经在运行的 Codex 是否【正在使用我们的代理】。
 *
 * ★ 为什么需要它 ★
 *   `app` 命令如果无脑"杀掉再拉起"，每次执行都会打断你正在编辑的内容
 *   （实测踩过：写完一半的对话被重启清掉）。所以要能识别"它其实已经在用我们的代理了"，
 *   这种情况直接跳过，什么都不做。
 *
 * 判据（按可靠性排序）：
 *   1) 主进程命令行里有 `--proxy-server=127.0.0.1:<我们的端口>`（最可靠，Chromium 一定带）
 *   2) 进程里存在指向我们监听端口的已建立连接（命令行读不到时的兜底）
 */
function codexUsingOurProxy(cfg, pids) {
  if (!pids || !pids.length) return false;
  const port = cfg.listen.port;
  // 1) 命令行
  for (const pid of pids) {
    const cmd = processCommandLine(pid);
    if (cmd && new RegExp(`--proxy-server=(?:https?://)?127\\.0\\.0\\.1:${port}\\b`).test(cmd)) return true;
  }
  // 2) 已建立的连接
  for (const pid of pids) {
    if (pidHasConnectionTo(pid, port)) return true;
  }
  return false;
}

/** 读进程命令行（Windows 用 WMIC/PowerShell，读不到返回 null —— 受限环境会拿不到） */
function processCommandLine(pid) {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('powershell', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      if (out.error || !out.stdout) return null;
      return out.stdout.trim() || null;
    }
    const out = spawnSync('ps', ['-o', 'args=', '-p', String(Number(pid))], { encoding: 'utf8' });
    return out.error ? null : (out.stdout.trim() || null);
  } catch {
    return null;   // 拿不到就当"不知道"，交给下一层判据
  }
}

/** 该进程是否有连到指定本地端口的已建立连接 */
function pidHasConnectionTo(pid, port) {
  try {
    if (process.platform !== 'win32') return false;
    const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (out.error || !out.stdout) return false;
    const p = Number(pid);
    for (const line of out.stdout.split('\n')) {
      // 形如：  TCP    127.0.0.1:52341      127.0.0.1:17890       ESTABLISHED     12345
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+(\S+):(\d+)\s+ESTABLISHED\s+(\d+)\s*$/);
      if (!m) continue;
      if (Number(m[4]) !== p) continue;
      if (Number(m[3]) === Number(port)) return true;   // 远端是我们的端口
      if (Number(m[1]) === Number(port)) return true;   // 本地是我们的端口
    }
    return false;
  } catch {
    return false;
  }
}

async function cmdApp(cfg, argv = []) {
  const force = argv.includes('--force');
  const argOf = (name) => {
    const i = argv.indexOf(name);
    // ★ 必须用 i >= 0 而不是 i > 0 ★
    //   indexOf 返回 0 表示"参数就在第一个位置"，用 > 0 会把它当成"没找到"，
    //   于是 `app --prefer newest` 这种把选项放最前面的写法会被静默忽略、
    //   日志里还照样打印配置里的默认值 —— 说的和做的不一致（实测踩过）。
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  // 版本策略与版本号由 PowerShell 侧解析后传进来（那边能查 MSIX 包注册表）
  const prefer = argOf('--prefer') || cfg.codex?.desktopPrefer || 'registered';
  const desVer = argOf('--desktop-version');
  const exeArg = argOf('--desktop-exe');

  const rc = await ensureRunning(cfg);
  if (rc !== 0) return rc;

  const exe = exeArg || cfg.codex.desktopExe;
  if (!exe) {
    console.log('没有解析到 Codex 桌面应用的路径。');
    console.log('  看看装在哪：Get-AppxPackage -Name OpenAI.Codex | Select InstallLocation');
    console.log('  或在 codex-proxy.config.json 里设置 codex.desktopExe');
    return 1;
  }
  const verText = desVer ? `版本 ${desVer}` : '版本未知';
  const base = path.basename(exe, '.exe');
  const pids = listProcesses(base);

  // ★ 幂等：已经在用我们的代理就别动它 ★
  //   否则每次 app 都会杀掉重启，打断你正在编辑的内容（实测踩过）。
  //   这一条也覆盖了"更新之后"的场景：更新后的实例若碰巧保住了代理参数，
  //   这里会直接返回，不会白重启一次。
  if (pids.length && !force && codexUsingOurProxy(cfg, pids)) {
    console.log(`Codex 已在运行且已挂我们的代理（${verText}，pid ${pids.join(', ')}），跳过重启。`);
    console.log('  想强制重启：.\\codex-proxy.ps1 app --force');
    return 0;
  }

  if (pids.length) {
    console.log(`关闭已在运行的 Codex (pid ${pids.join(', ')})，以便用代理环境变量重新拉起…`);
    for (const p of pids) { try { killTree(p); } catch {} }
    await sleep(2500);
  }
  console.log(`启动 Codex 桌面应用（${verText}，策略 ${prefer}，已挂代理 127.0.0.1:${cfg.listen.port}）`);
  const child = spawn(exe, [], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...proxyEnv(cfg.listen.port, cfg.codex.extraEnv) },
    windowsHide: false,
  });
  child.unref();
  return 0;
}

// ---------------------------------------------------------------- 入口

/**
 * 判断"是不是被直接当脚本运行"。
 * ★ 必须保留这个守卫 ★：测试脚本要 import 本模块来用 Bridge/Daemon/decideLatencySwitch 等，
 * 如果 import 时无条件执行 main()，测试一 import 就会跑起 CLI（表现为莫名其妙的
 * "状态：未运行"输出 + 退出码 1）——实测踩过。
 */
function isMainModule() {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** fmtBytes 的可读输出（命令层多处要用） */

/**
 * speed：实测所有出口的真实延迟与下载速度。**只读**，不切换、不影响正在用的出口。
 * 这是"认真比较哪个出口好"该用的命令 —— 它多次取样取最小、还算抖动和吞吐，
 * 比 status 里那个单次延迟靠谱得多。
 */
async function cmdSpeed(cfg, argv) {
  let dlBytes = 262144;
  const bi = argv.indexOf('--bytes');
  if (bi > 0 && argv[bi + 1]) dlBytes = Number(argv[bi + 1]) || dlBytes;

  // ★ 端口要用【守护进程状态里记录的】实际端口，不能用配置里的 ★
  //   配置里的 port 只是"期望值"；出口如果启动失败就不会占用它，
  //   直接用配置端口会去连一个没人监听的端口，报出误导性的错误
  //   （最典型的是 ssh 的 port 字段被当成 SOCKS 端口，报 ECONNREFUSED 127.0.0.1:22）。
  const info = readJsonSafe(STATE_FILE);
  const list = (info?.uplinks || []).map((u) => ({ name: u.name, port: u.port }));
  if (!list.length) {
    console.log('守护进程还没记录任何出口，请先 .\\codex-proxy.ps1 start');
    return 1;
  }
  const cur = info?.activeUplink || null;

  console.log('');
  console.log('=== 各出口真实延迟与速度实测 ===');
  console.log(`（每个出口：${cfg.health.latencySamples || 3} 次延迟取样取最小 + 实际下载 ${fmtBytes(dlBytes)}）`);
  console.log(`当前出口：${cur || '无'}`);
  console.log('');
  const results = [];
  for (const l of list) {
    console.log(`  测量中：${l.name} …`);
    const m = await measureUplink(l, { latencySamples: cfg.health.latencySamples || 3, dlBytes });
    results.push(m);
    if (m.ok) {
      console.log(`    ${m.name.padEnd(13)} 延迟 ${String(m.latencyMs + 'ms').padStart(7)}   ` +
        `下载 ${m.mbps !== null ? m.mbps.toFixed(2) + ' Mbps' : '无法测速'}` +
        (m.bytes ? `  [${fmtBytes(m.bytes)}/${m.totalMs}ms${m.source ? ' @' + m.source : ''}]` : '') +
        (m.name === cur ? '  ←当前出口' : ''));
      if (m.samples?.length > 1) console.log(`                  取样 [${m.samples.join(', ')}]  抖动 ${m.jitterMs}ms`);
    } else {
      console.log(`    ${m.name.padEnd(13)} 不可用：${m.err}`);
    }
  }

  const usable = results.filter((r) => r.ok);
  if (usable.length) {
    console.log('');
    console.log('按延迟排序：');
    [...usable].sort((a, b) => a.latencyMs - b.latencyMs)
      .forEach((r, i) => console.log(`  ${i + 1}. ${r.name.padEnd(13)} ${r.latencyMs}ms`));
    const bySpeed = usable.filter((r) => r.mbps !== null).sort((a, b) => b.mbps - a.mbps);
    if (bySpeed.length) {
      console.log('按速度排序：');
      bySpeed.forEach((r, i) => console.log(`  ${i + 1}. ${r.name.padEnd(13)} ${r.mbps.toFixed(2)} Mbps`));
    }
    const fastest = [...usable].sort((a, b) => a.latencyMs - b.latencyMs)[0];
    console.log('');
    console.log(`延迟最低的是 ${fastest.name}（${fastest.latencyMs}ms）。`);
    if (fastest.name !== cur) console.log(`想立刻切过去：.\\codex-proxy.ps1 best`);
  }
  console.log('');
  console.log('说明：这是"直连各出口端口"的测量结果，不影响正在使用的出口，也不会触发切换。');
  console.log(`      自动切换的判据见 health 配置（slowMs 地板 / fastRatio / minGainMs / satisfiedPolls / cooldownMs）。`);
  return 0;
}

/** 打印一次"实测 + 切换"的结果（best 与 use 共用） */
function printSwitchResult(rc) {
  if (rc?.error === 'unknown cmd') {
    console.log('守护进程不认识该命令（运行的还是旧代码）。请先 .\\codex-proxy.ps1 restart');
    return 1;
  }
  if (!rc || rc.ok === false) { console.log(`失败：${rc?.detail || rc?.error || '联系不上守护进程'}`); return 1; }
  console.log(`已切换：${rc.from} -> ${rc.to}`);
  console.log(`  实测依据：${rc.from} ${rc.fromMs}ms  →  ${rc.to} ${rc.toMs}ms`);
  if (rc.measured?.length) {
    console.log('  本次实测全部出口：');
    for (const m of rc.measured) {
      console.log(`    ${String(m.name).padEnd(13)} ${m.ok ? (m.latencyMs + 'ms') : ('不可用 ' + m.err)}`);
    }
  }
  return 0;
}

/**
 * best：实测所有出口，切到延迟最低的。**不钉住**。
 * 为什么不用钉住：判定规则要求"候选超出宽容范围且明显更优"才会切，
 * 所以切到最优之后，规则自己就会认为"已经最优、没有明显更优候选"，自然不会把它换走 ——
 * 最优选择本身就满足"暂不切换"的条件。反过来，如果它确实又被换走了，
 * 说明另一个出口在那个时刻真的明显更优（那正是你想要的），或者它自己不健康了。
 */
async function cmdBest(cfg, argv) {
  let dlBytes = 65536;
  const bi = argv.indexOf('--bytes');
  if (bi > 0 && argv[bi + 1]) dlBytes = Number(argv[bi + 1]) || dlBytes;
  const rc = await sendControl('switch-best', { dlBytes }, 180000);
  const r = printSwitchResult(rc);
  if (r !== 0) return r;
  console.log('  没钉住：之后由判定规则接管 —— 只要它仍是最优就不会被换掉；');
  console.log('  若它变得不健康、或有出口在宽容范围之外明显更优，会自动调整。');
  console.log('  想强制固定某一条（无视判定规则）：.\\codex-proxy.ps1 use <名字>');
  return 0;
}

/** use <名字>：强制固定用某一条，判定规则不接管（唯一能压过判定规则的机制） */
async function cmdUse(cfg, argv) {
  const name = argv[1];
  const known = [];
  if (cfg.uplinks.ssh?.enabled) known.push('ssh:jp');
  if (cfg.uplinks.xray?.enabled) known.push('xray:jp');
  if (cfg.uplinks.clashParty?.enabled) known.push('clash-party');
  if (!name || !known.includes(name)) {
    console.log(`用法: node codex-proxy.mjs use <${known.join('|')}>`);
    return 2;
  }
  const rc = await sendControl('switch-best', { name, pin: true, dlBytes: 65536 }, 180000);
  const r = printSwitchResult(rc);
  if (r !== 0) return r;
  console.log(`  已强制指定：${rc.to}（钉住，判定规则不接管）`);
  console.log('  解除：.\\codex-proxy.ps1 auto');
  return 0;
}

/** auto：解除强制指定，交还判定规则 */
async function cmdAuto(cfg) {
  const rc = await sendControl('release-pin', null, 8000);
  if (!rc) { console.log('联系不上守护进程，请先 .\\codex-proxy.ps1 start'); return 1; }
  if (rc.released) {
    console.log(`已解除强制指定（${rc.released}），判定规则重新接管。`);
    console.log('  注意：不会立刻跳走 —— 当前出口健康就保持不动（粘性规则）。');
    console.log('  只有它变得不健康、或出现超出宽容范围且明显更优的候选时才会自动换。');
  } else {
    console.log('当前没有强制指定的出口，本来就是自动模式。');
  }
  return 0;
}

/** nodes：列出回落出口会用到哪些节点（只读，不启动任何东西） */
function cmdNodes(cfg) {
  let clash;
  try {
    clash = new ClashPartyUplink(cfg.uplinks.clashParty);
  } catch (e) {
    console.log('读取节点失败：' + e.message);
    return 1;
  }
  let nodes;
  try {
    nodes = clash.loadNodes();
  } catch (e) {
    console.log('读取节点失败：' + e.message);
    console.log('');
    console.log('提示：Clash Party 的节点在 %APPDATA%\\mihomo-party\\profiles\\<current>.yaml，');
    console.log('      索引在 profile.yaml（只有 current，不含节点）。若 Clash Party 没在运行过，');
    console.log('      这些文件可能还不存在。');
    return 1;
  }
  const core = clash.coreExe();
  console.log('');
  console.log(`回落出口（clash-party）会使用 ${nodes.length} 个节点：`);
  console.log('');
  console.log('  #  节点名                            类型      服务器');
  console.log('  ' + '-'.repeat(72));
  nodes.forEach((n, i) => {
    console.log('  ' + String(i + 1).padStart(2) + '  ' +
      String(n.name).padEnd(32) +
      String(n.type || '?').padEnd(9) +
      `${n.server}:${n.port}`);
  });
  console.log('');
  console.log(`mihomo 内核：${core || '（找不到）'}`);
  if (core && /mihomo\.exe$/i.test(core)) {
    console.log('  ⚠ 这是 Clash Party 自带的内核，进程名会触发它的"高权限内核"检测。');
    console.log(`    建议复制一份到 ${path.join(HERE, 'bin', 'codex-core.exe')} 并在配置里指定 clashParty.coreExe。`);
  }
  console.log('');
  console.log('这些节点是"按名字里的日本关键字优先"挑出来的。想逐个测延迟：.\\codex-proxy.ps1 node-test');
  return 0;
}

/**
 * node-test：逐个回落节点测真实延迟。
 * 做法是临时起一个只含单节点的 mihomo，测完就关 —— 这样能拿到"每个节点各自多少毫秒"，
 * 而 url-test 策略组只会告诉你"当前选中哪个"，看不到全貌。
 */
async function cmdNodeTest(cfg, argv) {
  let limit = 0;
  const li = argv.indexOf('--limit');
  if (li > 0 && argv[li + 1]) limit = Number(argv[li + 1]) || 0;

  const clash = new ClashPartyUplink(cfg.uplinks.clashParty);
  let nodes;
  try { nodes = clash.loadNodes(); } catch (e) { console.log('读取节点失败：' + e.message); return 1; }
  if (limit > 0) nodes = nodes.slice(0, limit);
  const core = clash.coreExe();
  if (!core) { console.log('找不到 mihomo 内核，无法测节点'); return 1; }

  console.log('');
  console.log(`=== 逐个回落节点测延迟（共 ${nodes.length} 个）===`);
  console.log('（每个节点：临时起一个单节点 mihomo，做一次真实 HTTPS 往返，测完立刻关掉）');
  console.log('');

  const results = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const port = await findFreePort();
    const dir = path.join(RUN_DIR, 'node-test', `n${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const cfgFile = path.join(dir, 'config.yaml');
    // 只含这一个节点，规则直接 MATCH 到它
    const yaml = [
      'mixed-port: ' + port,
      'allow-lan: false',
      'bind-address: 127.0.0.1',
      'mode: rule',
      'log-level: silent',
      'ipv6: false',
      'dns:',
      '  enable: true',
      '  ipv6: false',
      '  enhanced-mode: fake-ip',
      '  nameserver:',
      '    - 1.1.1.1',
      'proxies:',
      '  - { name: ' + JSON.stringify(n.name) + ', ' +
        Object.entries(n).filter(([k]) => k !== 'name').map(([k, v]) => `${k}: ${yamlScalar(v)}`).join(', ') + ' }',
      'rules:',
      '  - MATCH,' + (n.name.includes(',') ? JSON.stringify(n.name) : n.name),
      '',
    ].join('\n');
    fs.writeFileSync(cfgFile, yaml);

    const logOut = fs.openSync(path.join(dir, 'mihomo.log'), 'a');
    const child = spawn(core, ['-d', dir, '-f', cfgFile], { stdio: ['ignore', logOut, logOut], windowsHide: true });
    try {
      let up = false;
      for (let k = 0; k < 30; k++) {
        await sleep(300);
        if (await portOpen(port)) { up = true; break; }
        if (child.exitCode !== null) break;
      }
      if (!up) {
        results.push({ name: n.name, ok: false, err: '内核未就绪' });
        console.log(`  ${String(i + 1).padStart(2)}. ${String(n.name).padEnd(34)} 不可用（内核未就绪）`);
      } else {
        const r = await requestTiming(port, { host: 'www.gstatic.com', path: '/generate_204', maxBytes: 1, timeoutMs: 12000 });
        if (r.ok) {
          results.push({ name: n.name, ok: true, ms: r.totalMs });
          console.log(`  ${String(i + 1).padStart(2)}. ${String(n.name).padEnd(34)} ${String(r.totalMs + 'ms').padStart(8)}`);
        } else {
          results.push({ name: n.name, ok: false, err: r.err });
          console.log(`  ${String(i + 1).padStart(2)}. ${String(n.name).padEnd(34)} 失败：${r.err}`);
        }
      }
    } finally {
      try { killTree(child.pid); } catch {}
      try { fs.closeSync(logOut); } catch {}
      await sleep(200);
    }
  }

  const ok = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  if (ok.length) {
    console.log('');
    console.log('最快的 3 个：');
    ok.slice(0, 3).forEach((r, i) => console.log(`  ${i + 1}. ${r.name.padEnd(34)} ${r.ms}ms`));
  }
  console.log('');
  console.log(`说明：这是"每个节点单独起来测一次"的结果，与回落出口内部 url-test 策略组的挑选`);
  console.log(`      不完全一致（策略组会按它自己的间隔和容差选）。这个数字主要用来判断哪个节点更值得用。`);
  return 0;
}

/**
 * 组装 resolve 的输出文本（纯函数，便于测试直接调用 —— 不必 spawn 子进程）。
 * 参数含义同 cmdResolve。
 */
function formatResolveInfo(cfg, { desktopExe = null, desktopVersion = null, installed = null, shortcut = null, lnkAumid = null, lnkPath = null } = {}) {
  const L = [];
  const p = (s = '') => L.push(s);

  p('');
  p('=== Codex 可执行文件解析 ===');
  p('');
  p(`  版本策略（codex.desktopPrefer）：${cfg.codex?.desktopPrefer || 'registered'}`);
  p('    registered = 已注册的包里版本最高的（默认，等价于双击桌面快捷方式）');
  p('    newest     = 磁盘上版本号最大的（可能包含尚未注册完成的更新半成品）');
  p('    running    = 正在运行的那个实例');
  p('    临时覆盖：.\\codex-proxy.ps1 app --prefer newest');
  p('');
  if (desktopExe) {
    p(`  桌面应用（app 命令会用）：${desktopExe}`);
    p(`    版本：${desktopVersion || '从路径解析'}`);
    p(`    存在：${fs.existsSync(desktopExe) ? '是' : '否'}`);
    p('    └ 说明：直接启动 exe 会丢失 MSIX 包标识，应用内自动更新可能不可用。');
    p('      要更新时请用官方快捷方式启动一次，之后再跑 app 命令。');
  } else {
    p('  桌面应用（app 命令会用）：（未解析到，PowerShell 侧会用快捷方式兜底）');
  }

  if (Array.isArray(installed) && installed.length) {
    p('');
    p(`  磁盘上已装的 Codex 版本（共 ${installed.length} 个）：`);
    p('    版本                        已注册  有 exe');
    p('    ' + '-'.repeat(46));
    for (const row of installed) {
      const v = row.version, reg = !!row.registered, hasExe = !!row.hasExe;
      const runnable = reg && hasExe;
      p('    ' + String(v).padEnd(28) +
        (reg ? '是  ' : '否  ').padEnd(8) +
        (hasExe ? '是' : '否') +
        (runnable ? '' : '   ← 不能直接用'));
    }
    p('');
    p('  说明：更新 Codex 时磁盘目录会先落地、注册晚一步完成，');
    p('        所以可能出现"版本号更大但还没注册"的目录 —— 那种直接跑不起来。');
    p('        默认策略 registered 就是为此：只挑已注册的，更新后无需改配置。');
  }

  // ★ 版本一致性验证：把"我们会启动的"与"双击桌面图标会启动的"对照 ★
  //   桌面上的 codex.lnk 是 AUMID 型快捷方式（TargetPath 为空），真正的入口写在
  //   AppxManifest.xml 的 <Application Id="App" Executable="..."> 里。
  //   所以这个对照才是"版本是否一致"的权威答案 —— 比两边各自报版本号更可靠。
  if (shortcut && shortcut.exePath) {
    p('');
    p('  --- 版本一致性验证（与双击桌面图标对照）---');
    if (lnkPath) p(`  桌面快捷方式：${lnkPath}`);
    if (lnkAumid) p(`    快捷方式指向的 AUMID：${lnkAumid}`);
    p(`  包清单里 AUMID 的入口：${shortcut.aumid || '(未取到)'}`);
    p(`    对应的可执行文件：${shortcut.exePath}`);
    p(`    版本：${shortcut.version || '未知'}`);

    const sameExe = desktopExe && path.resolve(desktopExe).toLowerCase() === path.resolve(shortcut.exePath).toLowerCase();
    const sameVer = desktopVersion && shortcut.version && desktopVersion === shortcut.version;
    const bothKnown = !!desktopVersion && !!shortcut.version;
    p('');
    // ★ 版本不一致是【最严重】的情况，必须优先报出来 ★
    //   早期这里先判 sameExe 就 return 了 —— 如果路径相同但版本号不同（例如显式配置了
    //   codex.desktopExe 指向另一个版本、或策略解析出了偏差），版本不一致会被路径一致掩盖掉。
    //   那是这个验证最该抓的问题，不能漏。
    if (bothKnown && !sameVer) {
      p('  ⚠ 版本不一致！');
      p(`    我们会启动：${desktopVersion}`);
      p(`    双击图标会启动：${shortcut.version}`);
      p('    如果策略是 newest，这是预期的（它挑磁盘上版本号最大的，可能还没注册）；');
      p('    否则请检查：.\\codex-proxy.ps1 resolve --prefer registered');
      p('    想确认桌面图标到底指向哪个包，跑：.\\codex-proxy.ps1 resolve');
    } else if (sameExe) {
      p('  ✓ 我们会启动的就是双击图标启动的那个可执行文件（路径完全一致）');
      if (sameVer) p('  ✓ 版本号也一致 —— 双击图标与 app 命令拿到的是同一个版本');
    } else if (sameVer) {
      p('  ✓ 版本号一致（双击图标与 app 命令拿到同一个版本）');
      p(`    路径不同只是解析来源不同：我们 ${desktopExe}`);
      p(`                              清单 ${shortcut.exePath}`);
    } else {
      // 有一边版本未知，无法判定 —— 如实说明，不要假装通过
      p('  （版本信息不完整，无法判定一致性）');
      p(`    我们：${desktopVersion || '未知'}   清单：${shortcut.version || '未知'}`);
      p(`    路径：我们 ${desktopExe}`);
      p(`          清单 ${shortcut.exePath}`);
    }
    p('');
    p('  注：app 命令是直接启动 exe，会丢失 MSIX 包标识 —— 这是为了能传 --proxy-server');
    p('      （桌面应用是 Chromium，不读代理环境变量，只能靠命令行参数指定代理）。');
    p('      代价是应用内自动更新可能不可用；更新请用桌面快捷方式启动一次。');
  }

  p('');
  p(`  CLI（cli / run 命令用）：${cfg.codex?.cliExe || '（未配置 codex.cliExe，会按 PATH 找 codex）'}`);
  p('');
  p(`  代理监听：127.0.0.1:${cfg.listen.port}`);
  p('  注入的环境变量（只作用于 app 启动的那棵进程树）：');
  for (const [k, v] of Object.entries(proxyEnv(cfg.listen.port, cfg.codex?.extraEnv))) {
    p(`    ${k}=${v}`);
  }
  return L.join('\n');
}

/** 把 ps1 传过来的 "版本|已注册|有exe;..." 解析成数组 */
function parseInstalledArg(raw) {
  if (!raw) return [];
  return String(raw).split(';')
    .map((s) => s.split('|'))
    .filter((parts) => parts[0])
    .map(([version, registered, hasExe]) => ({
      version, registered: registered === 'True', hasExe: hasExe === 'True',
    }));
}

/** resolve：说明"脚本实际会启动哪个 Codex"，含版本与已装版本清单 */
function cmdResolve(cfg, argv) {
  const argOf = (name) => {
    const i = argv.indexOf(name);
    // ★ 必须用 i >= 0 而不是 i > 0 ★
    //   indexOf 返回 0 表示"参数就在第一个位置"，用 > 0 会把它当成"没找到"，
    //   于是 `app --prefer newest` 这种把选项放最前面的写法会被静默忽略、
    //   日志里还照样打印配置里的默认值 —— 说的和做的不一致（实测踩过）。
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  console.log(formatResolveInfo(cfg, {
    desktopExe: argOf('--desktop-exe'),
    desktopVersion: argOf('--desktop-version'),
    installed: parseInstalledArg(argOf('--installed')),
    shortcut: argOf('--shortcut-exe') ? {
      exePath: argOf('--shortcut-exe'),
      aumid: argOf('--shortcut-aumid'),
      version: argOf('--shortcut-version'),
    } : null,
    lnkAumid: argOf('--lnk-aumid'),
    lnkPath: argOf('--lnk-path'),
  }));
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'status';
  const cfg = loadConfig();

  switch (cmd) {
    case 'daemon': return await cmdDaemon(cfg);
    case 'start': return await cmdStart(cfg);
    case 'stop': return await cmdStop();
    case 'down': return await cmdDown(cfg);
    case 'restart': await cmdStop(); await sleep(1500); return await cmdStart(cfg);
    case 'status': return cmdStatus();
    case 'check': return await cmdCheck(cfg, argv);
    case 'speed': return await cmdSpeed(cfg, argv);
    case 'best': return await cmdBest(cfg, argv);
    case 'use': return await cmdUse(cfg, argv);
    case 'auto': return await cmdAuto(cfg);
    case 'nodes': return cmdNodes(cfg);
    case 'node-test': return await cmdNodeTest(cfg, argv);
    case 'resolve': return cmdResolve(cfg, argv);
    case 'run': return await cmdRun(cfg, argv.slice(1));
    case 'app': return await cmdApp(cfg, argv.slice(1));
    case 'env': {
      console.log(JSON.stringify(proxyEnv(cfg.listen.port, cfg.codex.extraEnv), null, 2));
      return 0;
    }
    default:
      console.log('用法: node codex-proxy.mjs <daemon|start|stop|down|restart|status|check|run|app|env|speed|best|use|auto|nodes|node-test|resolve>');
      return 2;
  }
}

if (isMainModule()) {
  main().then((rc) => {
    if (rc !== undefined && rc !== null) process.exitCode = rc;
    if (process.argv[2] !== 'daemon') process.exit(rc ?? 0);
  }).catch((e) => {
    console.error('错误: ' + (e?.stack || e));
    process.exit(1);
  });
}

// ---------------------------------------------------------------- 导出（供测试与外部调用）

export {
  // 核心组件
  Bridge,
  Daemon,
  SshTunnel,
  XrayUplink,
  ClashPartyUplink,
  // 供测试直接调用的函数
  loadConfig,
  socksConnect,
  probeVia,
  requestTiming,
  decideLatencySwitch,
  killTree,
  reapPreviousChildren,
  recordChildren,
  pidListeningOn,
  processNameOf,
  canLookupPorts,
  peerOf,
  codexUsingOurProxy,
  processCommandLine,
  pidHasConnectionTo,
  measureUplink,
  formatResolveInfo,
  parseInstalledArg,
  yamlScalar,
  parseProfileProxies,
  isMainModule,
  // 常量
  PID_FILE,
  TOKEN_FILE,
  STATE_FILE,
  CHILDREN_FILE,
  CONFIG_PATH,
  RUN_DIR,
  LOG_DIR,
};

