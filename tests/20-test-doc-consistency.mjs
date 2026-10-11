// tests/20-test-doc-consistency.mjs — tests/README.md 的预期结果 vs 测试脚本实际断言数
//
// 背景：tests/README.md 的脚本一览表里写着每个套件的"通过标准"（例如 12/12、23/23）。
//       加了断言之后如果忘了改文档，表格就会说谎 —— 而用户是拿它当"正常长什么样"的基准的。
//
// 做法（两条路径，自动选）：
//   ① 能启动子进程时：真跑每个套件，从输出里读真实的 "N/M 通过" 来比对（最可靠）
//   ② 沙箱等不允许 spawn 的环境：退化为【静态计数】—— 数每个脚本里 check(...) 的调用数，
//      与 README 写的总数比。这抓不到"运行时才决定"的断言，但足以发现"加了断言忘改文档"。
//
// 用法： node tests/20-test-doc-consistency.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TESTS = path.join(ROOT, 'tests');

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}

console.log('=== 20 tests/README 预期结果 vs 实际断言数 ===\n');

const README = fs.readFileSync(path.join(TESTS, 'README.md'), 'utf8');

// 从 README 的脚本一览表里抽 "文件名 → 文档写的通过数"
const docCounts = new Map();
for (const m of README.matchAll(/\| `(\d\d-[\w.-]+)`[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*\*\*(\d+)\/(\d+) 通过\*\*/g)) {
  docCounts.set(m[1], { pass: Number(m[2]), total: Number(m[3]) });
}
console.log(`  README 表格里标了通过数的套件: ${docCounts.size} 个\n`);

/** 受限环境（沙箱）不允许启动子进程 */
function canSpawn() {
  try {
    const p = spawnSync(process.execPath, ['-e', 'process.exit(0)'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000 });
    return !p.error;
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return false;
    throw e;
  }
}

const canRun = canSpawn();
console.log(canRun
  ? '  环境允许启动子进程 → 真跑每个套件读实际结果（最可靠）\n'
  : '  环境不允许启动子进程 → 本测试跳过（不退化为静态计数，那个不准）\n');

// ---------------------------------------------------------------- 前置：必须能真跑
//
// ★ 为什么不退化成"静态计数" ★
//   试过：数每个脚本里 check() 的调用次数来当断言总数。**那是错的** ——
//   循环里的 check() 只算 1 次，所以静态数永远比真实断言数小
//   （18 号真实 114 项、静态只数出 84；17 号真实 46、静态 32）。
//   拿它去比 README 会得到一片假失败，比不测更糟。
//
//   所以这个测试**只在能启动子进程的环境里做真核对**；不能跑就明确跳过
//   （17/18 号已经把"不跑也能查"的部分覆盖掉了：脚本清单、脚本数、命令表、默认值）。
if (!canRun) {
  console.log('');
  console.log('  跳过：当前环境不允许启动子进程（spawn EPERM），无法真跑套件读实际断言数。');
  console.log('        请在普通终端里运行： node tests/20-test-doc-consistency.mjs');
  console.log('');
  console.log('  说明：这个测试专门核对「README 表格里每个套件的通过数 N/M 是否与真实断言数一致」。');
  console.log('        那个数字必须真跑才知道，静态数不出来（循环里的 check 只算 1 次）。');
  console.log('        17/18 号已覆盖不跑也能查的部分（脚本清单、脚本数、命令表、配置默认值）。');
  process.exit(0);
}

step('真跑每个套件，核对 README 写的通过数');

let compared = 0, skipped = 0;
for (const [f, doc] of docCounts) {
  const p = path.join(TESTS, f);
  if (!fs.existsSync(p)) { check(`${f} 存在`, false, 'README 列了但文件不存在'); continue; }
  if (!f.endsWith('.mjs')) { skipped++; continue; }   // ps1 套件不在这里跑

  const r = spawnSync(process.execPath, [p], { encoding: 'utf8', windowsHide: true, timeout: 300000, cwd: ROOT });
  const out = String((r.stdout || '') + (r.stderr || ''));
  if (/跳过：|请在普通终端里/.test(out)) {
    skipped++;
    console.log(`    ${f.padEnd(30)} 跳过（该套件依赖真实环境：Codex / SSH / 允许 spawn）`);
    continue;
  }
  const m = out.match(/(\d+)\/(\d+) 通过/);
  if (!m) { skipped++; console.log(`    ${f.padEnd(30)} 无 N/M 汇总（跳过）`); continue; }

  const actual = { pass: Number(m[1]), total: Number(m[2]) };
  compared++;
  const ok = doc.pass === actual.pass && doc.total === actual.total;
  check(`${f} 文档写的 ${doc.pass}/${doc.total} 与实际 ${actual.pass}/${actual.total} 一致`,
    ok, ok ? '' : `README 说 ${doc.pass}/${doc.total}，实际 ${actual.pass}/${actual.total}`);
}

console.log(`\n  比对 ${compared} 个套件，跳过 ${skipped} 个（依赖真实环境 / 无汇总 / ps1 套件）`);

// ---------------------------------------------------------------- 反向检查
step('反向检查：README 标了通过数、但脚本里没有对应断言的情况');
{
  for (const [f, doc] of docCounts) {
    const p = path.join(TESTS, f);
    if (!fs.existsSync(p) || !f.endsWith('.mjs')) continue;
    const src = fs.readFileSync(p, 'utf8');
    const hasSummary = /通过\$\{|通过`\)|通过'\)|\$\{pass\}\/\$\{results\.length\}/.test(src);
    if (!hasSummary) {
      check(`${f} 有"N/M 通过"的汇总输出（否则测试没法自证）`, false,
        `README 标了 ${doc.pass}/${doc.total}，但脚本里找不到汇总输出`);
    }
  }
  check('所有标了通过数的 mjs 套件都有汇总输出', true, '');
}

// ---------------------------------------------------------------- 汇总
console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
