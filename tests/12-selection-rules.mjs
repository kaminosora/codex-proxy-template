// tests/12-selection-rules.mjs — 出口选择规则的完整验证
//
// 核心设计原则（本测试要守住的东西）：
//   **priority 只在"第一次必须挑一个出来"时起作用；
//     之后无论自动切换还是手动 best，都由性能判定规则在宽容范围之外选最优，
//     与谁优先级高无关。**
//
// 决策顺序：
//   第 1 层  手动强制指定（use）——唯一能压过判定规则的机制
//   第 2 层  粘性：当前出口健康 → 保持不动
//   第 3 层  当前出口不可用 → 用 priority 挑第一个健康的（priority 的唯一用途）
//   第 4 层  性能判定：存在"超出宽容范围且明显更优"的候选 → 换过去（与 priority 无关）
//
// 覆盖（共 13 项）：
//   1) 初始选择用 priority（没有任何当前出口时）
//   2) 粘性：当前出口健康就保持不动
//   3) 当前出口不健康 → 用 priority 回落到第一个健康的
//   4) 性能判定能往【任意方向】换（含优先级更高的那个）
//   5) 性能判定取所有候选里【最快】的，而不是第一个满足的
//   6) 宽容范围内不切换（当前够快）
//   7) 候选不够快（未达 fastRatio / fastMs）不切换
//   8) 连续 satisfiedPolls 次才切换
//   9) 冷静期内不切换
//   10) 切换后不会立刻被反向切回（闸门对称 → 防横跳）
//   11) use 强制指定压过判定规则
//   12) 强制指定的出口不健康 → 自动解除
//   13) releasePin 解除后，性能判定重新接管
//
// 用法： node tests/12-selection-rules.mjs
// 预期： 13/13 通过
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

/** 造一个可控 Daemon：健康状态与延迟全由测试指定，不发网络请求 */
function makeDaemon(spec, opts = {}) {
  const cfg = M.loadConfig();
  cfg.health.latencyAware = opts.latencyAware !== false;
  if (opts.cfg) Object.assign(cfg.health, opts.cfg);
  const d = new M.Daemon(cfg);
  d.uplinks = spec.map((s) => ({ name: s.name, port: 65000, priority: s.priority }));
  d.health = new Map(spec.map((s) => [s.name, {
    ok: s.ok !== false,
    lastMs: s.ms ?? 100,
    latencyFresh: s.fresh !== false,
    failStreak: 0,
    okStreak: 1,
  }]));
  d.writeState = () => {};
  return d;
}
const named = (d, n) => d.uplinks.find((l) => l.name === n);
/** 跑一次"探测周期结束后的决策" */
function tick(d) { d.applyUplink(d.selectUplink()); }

// ssh 最优先但慢；clash-party 最不优先但最快 —— 用来验证"优先级只在初始生效"
const SPEC = [
  { name: 'ssh:jp', priority: 1, ms: 900 },
  { name: 'xray:jp', priority: 2, ms: 600 },
  { name: 'clash-party', priority: 3, ms: 300 },
];

console.log('=== 12 出口选择规则 ===\n');

// ---------------------------------------------------------------- 1
step('1. 初始选择（还没有当前出口）→ 用 priority');
{
  const d = makeDaemon(SPEC);
  check('activeUplink 为空', !d.activeUplink);
  tick(d);
  check('挑中优先级最高的 ssh:jp（即使它最慢）',
    d.activeUplink?.name === 'ssh:jp', `active=${d.activeUplink?.name}`);
}

// ---------------------------------------------------------------- 2
step('2. 粘性：当前出口健康就保持不动');
{
  const d = makeDaemon(SPEC);
  d.activeUplink = named(d, 'clash-party');    // 手动放到最不优先但最快的那个
  for (let i = 0; i < 5; i++) tick(d);
  check('连续 5 轮都不被"按优先级重排"搬走（粘性生效）',
    d.activeUplink?.name === 'clash-party', `active=${d.activeUplink?.name}`);
}

// ---------------------------------------------------------------- 3
step('3. 当前出口不健康 → 用 priority 回落');
{
  const d = makeDaemon(SPEC);
  d.activeUplink = named(d, 'clash-party');
  d.health.get('clash-party').ok = false;
  tick(d);
  check('回落到优先级最高的健康出口 ssh:jp',
    d.activeUplink?.name === 'ssh:jp', `active=${d.activeUplink?.name}`);
}

// ---------------------------------------------------------------- 4~5
step('4~5. 性能判定与 priority 无关，且取最快候选');
{
  // 当前是优先级最高的 ssh:jp(900ms)，最快的 clash-party(300ms) 优先级最低
  const d = makeDaemon(SPEC);
  d.activeUplink = named(d, 'ssh:jp');
  for (let i = 0; i < 3; i++) tick(d);
  check('能往【优先级更低】的方向换到最优的 clash-party',
    d.activeUplink?.name === 'clash-party', `active=${d.activeUplink?.name}`);

  // 反向：当前是最低优先级的 clash-party(900ms)，ssh:jp(200ms) 优先级最高
  const spec2 = [
    { name: 'ssh:jp', priority: 1, ms: 200 },
    { name: 'xray:jp', priority: 2, ms: 700 },
    { name: 'clash-party', priority: 3, ms: 900 },
  ];
  const d2 = makeDaemon(spec2);
  d2.activeUplink = named(d2, 'clash-party');
  for (let i = 0; i < 3; i++) tick(d2);
  check('也能往【优先级更高】的方向换（不再是单向）',
    d2.activeUplink?.name === 'ssh:jp', `active=${d2.activeUplink?.name}`);

  // 取最快而不是第一个满足的：当前 2000ms，候选 xray=500ms、clash=250ms 都满足
  const spec3 = [
    { name: 'ssh:jp', priority: 1, ms: 2000 },
    { name: 'xray:jp', priority: 2, ms: 500 },
    { name: 'clash-party', priority: 3, ms: 250 },
  ];
  const d3 = makeDaemon(spec3);
  d3.activeUplink = named(d3, 'ssh:jp');
  for (let i = 0; i < 3; i++) tick(d3);
  check('取所有候选里最快的（clash-party 250ms，而非先遇到的 xray 500ms）',
    d3.activeUplink?.name === 'clash-party', `active=${d3.activeUplink?.name}`);
}

// ---------------------------------------------------------------- 6
step('6. slowMs 是【地板】语义：低于它不折腾，高于它且明显更优就换');
{
  // (a) 当前 150ms < slowMs(250) → 够快了，即使别人快 3 倍也不折腾
  const specA = [
    { name: 'ssh:jp', priority: 1, ms: 150 },
    { name: 'clash-party', priority: 3, ms: 50 },
  ];
  const dA = makeDaemon(specA);
  dA.activeUplink = named(dA, 'ssh:jp');
  for (let i = 0; i < 5; i++) tick(dA);
  check('当前 150ms（低于地板 250）→ 即使别人 50ms 也不换',
    dA.activeUplink?.name === 'ssh:jp', `active=${dA.activeUplink?.name}`);

  // (b) 当前 300ms > 地板，且候选快一倍 → 应当换
  //     这一条专门守住"早期 slowMs=800 造成的死区"不再回归
  const specB = [
    { name: 'ssh:jp', priority: 1, ms: 300 },
    { name: 'clash-party', priority: 3, ms: 150 },
  ];
  const dB = makeDaemon(specB);
  dB.activeUplink = named(dB, 'ssh:jp');
  for (let i = 0; i < 3; i++) tick(dB);
  check('当前 300ms（高于地板）且候选快一倍 → 换过去（无死区）',
    dB.activeUplink?.name === 'clash-party', `active=${dB.activeUplink?.name}`);

  // (c) 高一点：600ms → 300ms（正好 2 倍）也要算满足，且这曾经被误判为"不够快"
  const specC = [
    { name: 'xray:jp', priority: 2, ms: 600 },
    { name: 'clash-party', priority: 3, ms: 300 },
  ];
  const dC = makeDaemon(specC);
  dC.activeUplink = named(dC, 'xray:jp');
  for (let i = 0; i < 3; i++) tick(dC);
  check('600ms → 300ms（正好 2 倍）算满足，换过去',
    dC.activeUplink?.name === 'clash-party', `active=${dC.activeUplink?.name}`);
}

// ---------------------------------------------------------------- 7
step('7. 候选不够快 → 不切换');
{
  const spec = [
    { name: 'ssh:jp', priority: 1, ms: 2000 },
    { name: 'clash-party', priority: 3, ms: 1200 },   // 需 < min(2000/2, 600) = 600
  ];
  const d = makeDaemon(spec);
  d.activeUplink = named(d, 'ssh:jp');
  for (let i = 0; i < 5; i++) tick(d);
  check('候选 1200ms 未达阈值（600ms）→ 不换',
    d.activeUplink?.name === 'ssh:jp', `active=${d.activeUplink?.name}`);
}

// ---------------------------------------------------------------- 8
step('8. 连续 satisfiedPolls 次才切换');
{
  const d = makeDaemon(SPEC);
  d.activeUplink = named(d, 'ssh:jp');
  tick(d); check('第 1 次：不切', d.activeUplink?.name === 'ssh:jp', `active=${d.activeUplink?.name}`);
  tick(d); check('第 2 次：不切', d.activeUplink?.name === 'ssh:jp', `active=${d.activeUplink?.name}`);
  tick(d); check('第 3 次：切换', d.activeUplink?.name === 'clash-party', `active=${d.activeUplink?.name}`);
}

// ---------------------------------------------------------------- 9
step('9. 冷静期内不切换');
{
  const d = makeDaemon(SPEC);
  d.activeUplink = named(d, 'ssh:jp');
  d.latencyCooldownUntil = Date.now() + 60000;      // 模拟"刚切过"
  for (let i = 0; i < 5; i++) tick(d);
  check('冷静期内即使条件是"明显更优"也不换',
    d.activeUplink?.name === 'ssh:jp', `active=${d.activeUplink?.name}`);
}

// ---------------------------------------------------------------- 10
step('10. 切换后不会立刻被反向切回（闸门对称 → 防横跳）');
{
  const d = makeDaemon(SPEC);
  d.activeUplink = named(d, 'ssh:jp');
  for (let i = 0; i < 3; i++) tick(d);
  check('先切到最优的 clash-party', d.activeUplink?.name === 'clash-party', `active=${d.activeUplink?.name}`);

  // 再跑多轮：ssh:jp(900ms) 现在是"候选"，它不可能比 clash-party(300ms) 更快，
  // 所以反向条件永远不成立 → 不会切回去
  for (let i = 0; i < 10; i++) tick(d);
  check('之后连续 10 轮都不会被切回慢的 ssh:jp（无横跳）',
    d.activeUplink?.name === 'clash-party', `active=${d.activeUplink?.name}`);
}

// ---------------------------------------------------------------- 11~13
step('11~13. 强制指定（use）与解除');
{
  const d = makeDaemon(SPEC);
  d.activeUplink = named(d, 'clash-party');     // 已经是最优
  d.pinnedUplink = 'ssh:jp';                     // 但强制指定慢的那个
  for (let i = 0; i < 5; i++) tick(d);
  check('强制指定压过判定规则（钉在慢的 ssh:jp 也不被换走）',
    d.activeUplink?.name === 'ssh:jp', `active=${d.activeUplink?.name}`);

  // 强制指定的出口不健康 → 自动解除
  d.health.get('ssh:jp').ok = false;
  tick(d);
  check('强制指定的出口不健康 → 自动解除指定', d.pinnedUplink === null, `pinned=${d.pinnedUplink}`);
  check('解除后先按 priority 回落（xray:jp，第 3 层的职责）',
    d.activeUplink?.name === 'xray:jp', `active=${d.activeUplink?.name}`);
  // 再跑几轮：性能判定需要连续 satisfiedPolls(3) 次才换，所以不会立刻跳到最优
  for (let i = 0; i < 3; i++) tick(d);
  check('随后性能判定接管 → 换到最优的 clash-party（而不是停在 xray）',
    d.activeUplink?.name === 'clash-party', `active=${d.activeUplink?.name}`);

  // releasePin：解除后判定规则重新接管
  const d2 = makeDaemon(SPEC);
  d2.activeUplink = named(d2, 'ssh:jp');
  d2.pinnedUplink = 'ssh:jp';
  const was = d2.releasePin();
  check('releasePin 返回被解除的名字', was === 'ssh:jp', `was=${was}`);
  for (let i = 0; i < 3; i++) tick(d2);
  check('解除后判定规则重新接管 → 换到最优',
    d2.activeUplink?.name === 'clash-party', `active=${d2.activeUplink?.name}`);
}

console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
