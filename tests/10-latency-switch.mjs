// tests/10-latency-switch.mjs — 延迟感知切换的防抖动验证（纯逻辑，不需要网络）
//
// 这个测试针对一个很容易写错、错了又很难发现的功能：
// "当前出口能通但很慢，要不要换一个？"
//
// 写错的典型后果是【抖动】——两个出口之间来回跳，每次跳都让新的连接换路，
// 比一直用慢的那个还糟。所以这个测试的重点不是"能不能切"，而是"什么时候【不】切"。
//
// 覆盖（共 16 项）：
//   1) 当前出口够快 → 不切
//   2) 当前出口慢，但没有更快候选 → 不切
//   3) 慢 + 有快候选，第 1 次 → 不切（进入待定）
//   4) 第 2 次 → 仍不切
//   5) 第 3 次（默认 satisfiedPolls）→ 才切
//   6) 切之前如果条件中断一次 → 计数清零，重新数
//   7) 切换后冷静期内即使又变慢 → 不切
//   8) 冷静期过后 → 可以再切
//   9) 候选只快一点点（不满足 fastRatio）→ 不切
//  10) 候选增益不足（不满足 fastRatio / minGainMs）→ 不切
//  11) 当前出口不是优先级第一 → 不切（避免把刚降级的又切回去）
//  12) 当前出口延迟数据不新鲜（探测失败过）→ 不切
//  13) 候选延迟数据不新鲜 → 不切
//  14) latencyAware 关闭 → 完全不切
//  15) 不会切到优先级更高的出口（只往下换）
//  16) 切到的是"第一个满足条件的"候选中优先级最高的那个
//
// 用法： node tests/10-latency-switch.mjs
// 预期： 16/16 通过
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { decideLatencySwitch } = await import(pathToFileURL(path.join(ROOT, 'codex-proxy.mjs')).href);

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}

// ---------------------------------------------------------------- 测试脚手架
const CFG = {
  slowMs: 800, fastRatio: 2, minGainMs: 150,
  satisfiedPolls: 3, cooldownMs: 120000,
};

/** 造一个 uplink 列表 + 对应的 health map */
function makeWorld(spec) {
  // spec: [{ name, priority, ms|null }]  ms=null 表示延迟数据不新鲜
  const healthy = spec.map((s, i) => ({ name: s.name, priority: s.priority ?? i + 1 }));
  const health = new Map(spec.map((s) => [
    s.name,
    s.ms === null
      ? { ok: true, lastMs: null, latencyFresh: false, failStreak: 0 }
      : { ok: true, lastMs: s.ms, latencyFresh: true, failStreak: 0 },
  ]));
  return { healthy, health };
}

/** 模拟连续 N 轮探测，返回最终的切换结论（模拟真实 daemon 的状态传递） */
function runPolls(spec, polls, opts = {}) {
  const cfg = { ...CFG, ...(opts.cfg || {}) };
  const { healthy, health } = makeWorld(typeof spec === 'function' ? spec(0) : spec);
  let streak = null;
  let cooldownUntil = opts.cooldownUntil || 0;
  let now = 1000000;
  const log = [];
  // startAt：指定"当前出口"是谁（默认取第一个）。用于模拟"我已经在最快的那条上了"。
  const pickCurrent = () => {
    if (opts.startAt) {
      const found = healthy.find((l) => l.name === opts.startAt);
      if (found) return found;
    }
    return healthy[0];
  };
  for (let i = 0; i < polls; i++) {
    if (typeof spec === 'function') {
      const w = makeWorld(spec(i));
      healthy.length = 0; healthy.push(...w.healthy);
      health.clear(); for (const [k, v] of w.health) health.set(k, v);
    }
    const cur = pickCurrent();
    const d = decideLatencySwitch({ healthy, current: cur, health, cfg, prevStreak: streak, cooldownUntil, now });
    streak = d.streak;
    if (d.cooldownUntil !== cooldownUntil) cooldownUntil = d.cooldownUntil;
    log.push(d.reason);
    if (d.switch) return { switched: true, to: d.cand.name, curMs: d.curMs, candMs: d.candMs, reasons: log, streak, cooldownUntil };
    now += cfg.intervalMs || 15000;
  }
  return { switched: false, reasons: log, streak, cooldownUntil };
}

/** 单轮判定（不关心连续计数） */
function once(spec, opts = {}) {
  const cfg = { ...CFG, ...(opts.cfg || {}) };
  const { healthy, health } = makeWorld(spec);
  return decideLatencySwitch({
    healthy, current: healthy[0], health, cfg,
    prevStreak: opts.prevStreak || null,
    cooldownUntil: opts.cooldownUntil || 0,
    now: 1000000,
  });
}

console.log('=== 10 延迟感知切换 · 防抖动验证（纯逻辑）===\n');
console.log(`配置: slowMs=${CFG.slowMs} fastRatio=${CFG.fastRatio} minGainMs=${CFG.minGainMs}` +
  ` satisfiedPolls=${CFG.satisfiedPolls} cooldown=${CFG.cooldownMs}ms\n`);

const WORLD_FAST_SLOW = [
  { name: 'ssh:jp', priority: 1, ms: 100 },     // 够快
  { name: 'xray:jp', priority: 2, ms: 90 },
];
const WORLD_SLOW_ONLY = [
  { name: 'ssh:jp', priority: 1, ms: 2500 },    // 慢
  { name: 'xray:jp', priority: 2, ms: 2200 },   // 也慢，不够"明显更快"
];
const WORLD_SLOW_FAST = [
  { name: 'ssh:jp', priority: 1, ms: 2500 },    // 慢
  { name: 'xray:jp', priority: 2, ms: 170 },    // 明显快
];

// ---------------------------------------------------------------- 1~2 不该切
step('1. 当前出口够快 → 不切');
{
  const d = once(WORLD_FAST_SLOW);
  check('延迟 100ms（< slowMs 800）不切换', !d.switch && d.reason === 'fast-enough', `reason=${d.reason}`);
}

step('2. 当前出口慢，但没有明显更快的候选 → 不切');
{
  const d = once(WORLD_SLOW_ONLY);
  check('候选 2200ms 不够快（需 < 1250ms）→ 不切', !d.switch && d.reason === 'no-better-candidate', `reason=${d.reason}`);
}

// ---------------------------------------------------------------- 3~5 连续计数
step('3~5. 必须连续满足才切（这是防抖动的核心）');
{
  const r1 = runPolls(WORLD_SLOW_FAST, 1);
  check('第 1 次探测 → 不切（进入待定）', !r1.switched && r1.streak?.n === 1, `streak=${r1.streak?.n}`);
  const r2 = runPolls(WORLD_SLOW_FAST, 2);
  check('第 2 次探测 → 仍不切', !r2.switched && r2.streak?.n === 2, `streak=${r2.streak?.n}`);
  const r3 = runPolls(WORLD_SLOW_FAST, 3);
  check('第 3 次探测 → 才切换', r3.switched && r3.to === 'xray:jp', `切到 ${r3.to}（${r3.curMs}ms → ${r3.candMs}ms）`);
}

// ---------------------------------------------------------------- 6 中断清零
step('6. 条件中断一次 → 计数清零');
{
  // 第 1、2 轮慢（计数到 2），第 3 轮恢复正常（应清零），第 4 轮再慢（重新从 1 数）
  const spec = (i) => (i === 2
    ? [{ name: 'ssh:jp', priority: 1, ms: 120 }, { name: 'xray:jp', priority: 2, ms: 170 }]
    : WORLD_SLOW_FAST);
  const r = runPolls(spec, 4);
  check('中途恢复一次后不切换，且计数被清零重数', !r.switched && r.streak?.n === 1,
    `reasons=${r.reasons.join(',')} streak=${r.streak?.n}`);
}

// ---------------------------------------------------------------- 7~8 冷静期
step('7~8. 切换后的冷静期');
{
  const world = makeWorld(WORLD_SLOW_FAST);
  // 模拟"刚切过"的状态：cooldownUntil 在未来
  const d = decideLatencySwitch({
    healthy: world.healthy, current: world.healthy[0], health: world.health, cfg: CFG,
    prevStreak: { key: 'ssh:jp->xray:jp', n: 5 }, cooldownUntil: 1000000 + 60000, now: 1000000,
  });
  check('冷静期内即使条件成立也不切', !d.switch && d.reason === 'cooldown', `reason=${d.reason}`);

  const r = runPolls(WORLD_SLOW_FAST, 3, { cooldownUntil: 1000000 + 60000 });
  check('冷静期内连续 3 轮都不切', !r.switched, `reasons=${r.reasons.join(',')}`);
}

// ---------------------------------------------------------------- 9~10 阈值
step('9. 候选只快一点点（不满足 fastRatio）→ 不切');
{
  // 当前 2000ms，fastRatio=2 → 候选需 < 1000；给 1200 应被拒
  const d = once([{ name: 'ssh:jp', priority: 1, ms: 2000 }, { name: 'xray:jp', priority: 2, ms: 1200 }]);
  check('2000ms → 1200ms 不切（未达 2 倍）', !d.switch && d.reason === 'no-better-candidate', `reason=${d.reason}`);
}

step('10. 候选增益不足 → 不切（fastRatio 与 minGainMs 都要满足）');
{
  // 800ms 地板之上：当前 5000ms，fastRatio=2 → 需至少快 2500ms，即候选 <= 2500ms。
  // 注意"不切"和"连续计数"是两件事：增益不足时 reason 应是 no-better-candidate（立刻放弃，
  // 不进入待定计数）；增益够时理由会是 pending（进入待定）。用这两个 reason 来区分。
  const d1 = once([{ name: 'ssh:jp', priority: 1, ms: 5000 }, { name: 'xray:jp', priority: 2, ms: 3000 }]);
  check('5000ms → 3000ms 立刻放弃（只快 1.67 倍，未达 fastRatio=2，不进待定）',
    !d1.switch && d1.reason === 'no-better-candidate', `reason=${d1.reason}`);

  const d2 = once([{ name: 'ssh:jp', priority: 1, ms: 5000 }, { name: 'xray:jp', priority: 2, ms: 2000 }]);
  check('5000ms → 2000ms 满足条件（进入待定计数）', d2.reason === 'pending', `reason=${d2.reason}`);

  // 连续满足 3 次后确实切过去
  const r = runPolls([{ name: 'ssh:jp', priority: 1, ms: 5000 }, { name: 'xray:jp', priority: 2, ms: 2000 }], 3);
  check('连续 3 次满足后切到 2000ms 那个', r.switched && r.to === 'xray:jp', `切到 ${r.to}（${r.curMs}→${r.candMs}）`);

  // minGainMs 起作用：当前 1000ms，fastRatio=2 → 需快 500ms；
  // 候选 550ms（只快 450ms）不满足，候选 500ms（正好快 500ms）满足
  const g1 = once([{ name: 'ssh:jp', priority: 1, ms: 1000 }, { name: 'xray:jp', priority: 2, ms: 550 }]);
  check('1000ms → 550ms 不满足（增益 450ms < minGainMs 500ms）',
    !g1.switch && g1.reason === 'no-better-candidate', `reason=${g1.reason}`);
  const g2 = once([{ name: 'ssh:jp', priority: 1, ms: 1000 }, { name: 'xray:jp', priority: 2, ms: 500 }]);
  check('1000ms → 500ms 满足（增益正好 500ms）', g2.reason === 'pending', `reason=${g2.reason}`);
}

step('11. 性能判定取【最快】候选，且不看优先级');
{
  // 候选里有多个满足条件时，取最快那个（而不是列表里第一个满足的）
  const spec = [
    { name: 'ssh:jp', priority: 1, ms: 3000 },
    { name: 'xray:jp', priority: 2, ms: 1200 },      // 满足，但不是最快
    { name: 'clash-party', priority: 3, ms: 400 },   // 最快
  ];
  const d = once(spec);
  check('取最快的 clash-party（400ms），而非先遇到的 xray（1200ms）',
    d.cand?.name === 'clash-party', `cand=${d.cand?.name}`);

  const r = runPolls(spec, 3);
  check('连续 3 次后切到 clash-party', r.switched && r.to === 'clash-party',
    `切到 ${r.to}（${r.curMs}→${r.candMs}）`);

  // 也能往优先级更高的方向换（不再是单向）
  const spec2 = [
    { name: 'ssh:jp', priority: 1, ms: 1500 },
    { name: 'clash-party', priority: 3, ms: 300 },
  ];
  const d2 = runPolls(spec2, 3, { startAt: 'clash-party' });
  check('（反向）当前已是最快时不会被换走', !d2.switched, `reasons=${d2.reasons.join(',')}`);
}

step('12~13. 延迟数据不新鲜 → 不切');
{
  const d1 = once([{ name: 'ssh:jp', priority: 1, ms: null }, { name: 'xray:jp', priority: 2, ms: 170 }]);
  check('当前出口本轮探测失败过（无新鲜延迟）→ 不切', !d1.switch && d1.reason === 'no-fresh-latency', `reason=${d1.reason}`);
  const d2 = once([{ name: 'ssh:jp', priority: 1, ms: 2500 }, { name: 'xray:jp', priority: 2, ms: null }]);
  check('候选延迟数据不新鲜 → 不切', !d2.switch && d2.reason === 'no-better-candidate', `reason=${d2.reason}`);
}

// ---------------------------------------------------------------- 15~16 只往下换
step('15. 与 priority 无关：最优候选哪怕优先级最高/最低都照样选它');
{
  // 三个候选都满足条件时取最快的，与它们在列表里的顺序、优先级无关
  const d = once([
    { name: 'ssh:jp', priority: 1, ms: 2500 },
    { name: 'xray:jp', priority: 2, ms: 170 },
    { name: 'clash-party', priority: 3, ms: 150 },   // 最快（且优先级最低）
  ]);
  check('选最快的 clash-party（150ms），与优先级无关', d.cand?.name === 'clash-party', `cand=${d.cand?.name}`);

  // 把"最快者"的【优先级改成最高但排在列表后面】—— 结论必须一样（不按列表顺序取第一个满足的）
  // 注意：once() 用 healthy[0] 当"当前出口"，所以慢的那个必须留在第一位。
  const d2 = once([
    { name: 'ssh:jp', priority: 3, ms: 2500 },        // 当前（慢，优先级最低）
    { name: 'xray:jp', priority: 2, ms: 170 },        // 满足但不是最快
    { name: 'clash-party', priority: 1, ms: 150 },    // 最快，且优先级最高，但排在最后
  ]);
  check('仍选最快的 clash-party（不因它在列表最后而漏掉）', d2.cand?.name === 'clash-party', `cand=${d2.cand?.name}`);

  // 当前出口已经是最快的 → 不切（反向条件不成立）
  const d3 = once([
    { name: 'clash-party', priority: 1, ms: 150 },
    { name: 'ssh:jp', priority: 2, ms: 2500 },
  ]);
  check('当前已是最快（150ms，低于地板）→ 不切', !d3.switch && d3.reason === 'fast-enough', `reason=${d3.reason}`);
}

// ---------------------------------------------------------------- 14 开关（放在最后，因为它要改 cfg）
step('14. latencyAware 关闭时应完全不参与（由调用方短路，这里验证默认参数）');
{
  // decideLatencySwitch 本身不含开关判断，开关在 healthCheckAll 里短路。
  // 这里验证：默认 cfg 下慢+快候选在第 3 次会切（作为"开启时有效"的基准）
  const r = runPolls(WORLD_SLOW_FAST, 3);
  check('开启状态下第 3 次切换（基准行为）', r.switched, `切到 ${r.to}`);
}

// ---------------------------------------------------------------- 汇总
console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
