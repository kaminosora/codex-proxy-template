// tests/05-reaper.mjs — killTree 与孤儿回收的验证
//
// 这个测试专门针对 Windows 上"杀不干净"的问题：
//   * SIGTERM 对 Windows GUI 程序（xray.exe / mihomo.exe）基本无效
//   * taskkill 可能被拒绝
//   * 强杀守护进程会留下还在占端口的孤儿
//
// 关于 children.json 的格式（别猜，按生产代码来）：
//   recordChildren() 写入的是  { daemon: <pid>, pids: [pid1, pid2, ...] }
//   早期版本的测试写成了 [{ name, pid, port }]，格式不匹配 → rec.pids 为 undefined
//   → 保险 1 空转，而"保险 2 生效"会让测试看起来通过。所以这里必须按真实格式写。
//
// 覆盖：
//   1) killTree 能杀掉进程树（父 + 子）
//   2) killTree 对不存在的 pid 不抛异常（幂等）
//   3) killTree 对非自己的 pid 不会误杀（安全边界）
//   4) reapPreviousChildren 保险 1：按 children.json 记录的 pid 回收
//      （仿制孤儿的端口是随机的，不在清扫列表里 → 只能靠读 pids 清掉）
//   5) reapPreviousChildren 保险 2：按端口反查回收
//      （仿制孤儿占 17893，但 children.json 里不记它 → 只能靠端口反查清掉）
//   6) 整个清理过程没有失控（不挂死）
//
// ⚠️ 副作用（必须知道）：本测试需要让进程占住 17891/17893 来验证"端口反查"，
//    而 reapPreviousChildren 会忠实地把占这些端口的进程当孤儿清掉 ——
//    **包括正在运行的守护进程的 xray / 回落 mihomo 子进程**。
//    跑完 status 会看到 xray:jp / clash-party 变 DOWN，这是预期现象。
//    恢复：.\codex-proxy.ps1 restart
//    想避免副作用：先 .\codex-proxy.ps1 stop，跑完再 start。
//
// 用法： node tests/05-reaper.mjs
// 预期： 16/16 通过
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
// Windows 上动态 import 必须用 file:// URL
const { killTree, reapPreviousChildren, pidListeningOn, loadConfig } =
  await import(pathToFileURL(path.join(ROOT, 'codex-proxy.mjs')).href);

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const CHILDREN_FILE = path.join(ROOT, 'run', 'children.json');

/** 起一个"父进程 + 子进程"的树，用来验证 /T 是否真的连带杀掉子进程 */
function spawnTree() {
  const script = `
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-e', 'require("net").createServer().listen(0,"127.0.0.1");setInterval(()=>{},1000)'], { stdio: 'ignore' });
    console.log(JSON.stringify({ childPid: child.pid }));
    setInterval(() => {}, 1000);
  `;
  const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  p.on('error', () => {});
  return p;
}

/** 起一个占住端口的进程（preferredPort=0 时用随机端口），返回 { pid, port } */
function spawnPortHolder(preferredPort = 0) {
  const script = `
    const net = require('net');
    const srv = net.createServer();
    srv.listen(${preferredPort}, '127.0.0.1', function () {
      console.log(this.address().port);
      setInterval(() => {}, 1000);
    });
    srv.on('error', function (e) { console.error('LISTENFAIL ' + e.code); process.exit(1); });
  `;
  const p = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.on('error', () => {});
  return new Promise((resolve) => {
    let b = '';
    p.stdout.on('data', (d) => {
      b += d;
      const m = b.match(/(\d{4,5})/);
      if (m) resolve({ proc: p, pid: p.pid, port: Number(m[1]) });
    });
    setTimeout(() => resolve({ proc: p, pid: p.pid, port: null }), 6000);
  });
}

function firstJson(p) {
  return new Promise((resolve) => {
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      try { resolve(JSON.parse(buf.split('\n')[0])); } catch {}
    });
    setTimeout(() => resolve(null), 5000);
  });
}

/**
 * 受限环境（沙箱）里跑不了这个测试：必须真的起进程、还要用管道读子进程输出。
 * spawn 失败可能是同步抛，也可能是异步 error —— 两种都要接住，
 * 直接说明原因退出，而不是抛一堆栈让人误以为代码坏了。
 */
const SANDBOX_HINT = '跳过：当前环境不允许启动子进程（spawn EPERM）。\n' +
  '      请在普通终端里运行： node tests/05-reaper.mjs';
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

console.log('=== 05 killTree / 孤儿回收验证 ===\n');

if (!canSpawn()) {
  console.log(SANDBOX_HINT);
  process.exit(0);
}

// 备份真实的 children.json，测完还原（不能破坏用户的运行状态）
const childrenBackup = fs.existsSync(CHILDREN_FILE) ? fs.readFileSync(CHILDREN_FILE, 'utf8') : null;
function restoreChildren() {
  try {
    if (childrenBackup !== null) fs.writeFileSync(CHILDREN_FILE, childrenBackup);
    else if (fs.existsSync(CHILDREN_FILE)) fs.unlinkSync(CHILDREN_FILE);
  } catch {}
}

const cleanup = new Set();
const t0 = Date.now();

try {
  // ---------------------------------------------------------------- 1~3 killTree
  step('1. killTree 杀掉父子进程树');
  const tree = spawnTree();
  cleanup.add(tree.pid);
  const info = await firstJson(tree);
  check('测试用进程树已建立', !!info?.childPid, JSON.stringify(info));
  if (info?.childPid) {
    cleanup.add(info.childPid);
    check('父进程与子进程初始都存活', alive(tree.pid) && alive(info.childPid),
      `父=${tree.pid} 子=${info.childPid}`);
    const tA = Date.now();
    killTree({ pid: tree.pid });
    await sleep(1500);
    check('父进程已被杀掉', !alive(tree.pid), `${Date.now() - tA}ms`);
    check('子进程也被连带杀掉（/T 生效）', !alive(info.childPid), `子 pid=${info.childPid}`);
  }

  step('2. killTree 对不存在的 pid 不抛异常（幂等）');
  let threw = null;
  try { killTree({ pid: 999999999 }); } catch (e) { threw = e.message; }
  check('killTree(不存在的 pid) 不抛异常', threw === null, threw ? '抛了: ' + threw : '');
  await sleep(200);

  step('3. killTree 不会误杀无关进程');
  const innocent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  innocent.on('error', () => {});
  cleanup.add(innocent.pid);
  await sleep(1200);
  check('先起一个"无辜进程"', alive(innocent.pid), `pid=${innocent.pid}`);
  killTree({ pid: 999999999 });
  await sleep(600);
  check('对不存在的 pid 操作后，无辜进程仍存活', alive(innocent.pid), `pid=${innocent.pid}`);

  const cfg = loadConfig();

  // ---------------------------------------------------------------- 4 保险 1
  step('4. 保险 1 —— 按 children.json 记录的 pid 回收');
  const orphanA = await spawnPortHolder(0);
  cleanup.add(orphanA.pid);
  check('仿制孤儿 A 已占住端口', !!orphanA.port && alive(orphanA.pid), `pid=${orphanA.pid} port=${orphanA.port}`);

  // 按生产代码的真实格式写（见文件头注释）
  fs.mkdirSync(path.dirname(CHILDREN_FILE), { recursive: true });
  fs.writeFileSync(CHILDREN_FILE, JSON.stringify({ daemon: 999999, pids: [orphanA.pid] }), 'utf8');
  const fmtOk = (() => {
    try {
      const r = JSON.parse(fs.readFileSync(CHILDREN_FILE, 'utf8'));
      return Array.isArray(r.pids) && r.pids[0] === orphanA.pid;
    } catch { return false; }
  })();
  check('children.json 已按生产格式写入 {daemon, pids}', fmtOk, `pids=[${orphanA.pid}]`);

  const t1 = Date.now();
  let reapErr = null;
  try { reapPreviousChildren(cfg); } catch (e) { reapErr = e.message; }
  await sleep(1500);

  check('reapPreviousChildren 不抛异常', reapErr === null, reapErr || `${Date.now() - t1}ms`);
  check('保险 1：孤儿 A 已被回收（其端口是随机的，只能靠读 pids 清掉）',
    !alive(orphanA.pid), `pid=${orphanA.pid}`);
  check('保险 1：它占的端口已释放',
    !pidListeningOn(orphanA.port),
    pidListeningOn(orphanA.port) ? `仍被 ${pidListeningOn(orphanA.port)} 占用` : `port=${orphanA.port}`);

  // ---------------------------------------------------------------- 5 保险 2
  step('5. 保险 2 —— 按端口反查回收');
  const orphanB = await spawnPortHolder(17893);
  cleanup.add(orphanB.pid);

  // ★ 两个分支的断言数必须一致（各 3 条）★
  //   踩过的坑：原来"占不到 17893"那一支只发 1 条 check，正常那支发 3 条，
  //   于是**断言总数随环境变化**：
  //     - 没开 Clash Party（17893 空着）→ 17/17
  //     - 开着 Clash Party（17893 被它占）→ 16/16
  //   而 20 号测试会拿 tests/README 里写的数字跟实际比 —— 数字飘了就会 FAIL，
  //   看起来像测试坏了，其实是"同一套断言的两种环境表现"。
  //   修法：让两支都发满 3 条，总数恒定。
  if (orphanB.port !== 17893) {
    check('仿制孤儿 B 占住 17893（Clash 回落端口）', false,
      orphanB.port ? `只占到了 ${orphanB.port}（17893 被别的程序占用，多半是 Clash Party 在跑）` : '监听失败');
    check('保险 2：孤儿 B 已被回收（children.json 里没记它，只能靠端口反查）', false,
      '跳过：本环境占不到 17893，无法验证端口反查（先 .\\codex-proxy.ps1 stop 并退出 Clash Party 再跑）');
    check('保险 2：17893 已释放', !pidListeningOn(17893),
      pidListeningOn(17893) ? `仍被 ${pidListeningOn(17893)} 占用（那是别的程序，不是我们的孤儿）` : '未被占用');
  } else {
    check('仿制孤儿 B 占住 17893（Clash 回落端口）', alive(orphanB.pid), `pid=${orphanB.pid}`);
    // children.json 里【不写】orphanB → 它只能被保险 2 清掉
    fs.writeFileSync(CHILDREN_FILE, JSON.stringify({ daemon: 999999, pids: [] }), 'utf8');
    const t2 = Date.now();
    try { reapPreviousChildren(cfg); } catch {}
    await sleep(1800);
    check('保险 2：孤儿 B 已被回收（children.json 里没记它，只能靠端口反查）',
      !alive(orphanB.pid), `pid=${orphanB.pid}`);
    check('保险 2：17893 已释放', !pidListeningOn(17893), `耗时 ${Date.now() - t2}ms`);
  }

  // ---------------------------------------------------------------- 6 不挂死
  step('6. 清理过程没有失控（不挂死）');
  // 阈值说明：每次 killTree 成功前会依次尝试 taskkill → Stop-Process → WMI，每层各等超时。
  // 本测试共跑 6 次回收，实测累计约 14 秒属正常。这里只验证"没有无限挂住"，
  // 所以给到 40 秒 —— 定得太紧会把正常行为判成失败（早期版本定 8 秒就误报了）。
  const total = Date.now() - t0;
  check('整个测试在 40 秒内完成（无失控挂起）', total < 40000, `累计 ${total}ms`);
} finally {
  restoreChildren();
  for (const pid of cleanup) { try { killTree({ pid }); } catch {} }
}

console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
