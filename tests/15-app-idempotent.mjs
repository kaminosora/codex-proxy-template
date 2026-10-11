// tests/15-app-idempotent.mjs — `app` 命令的幂等判断（避免每次执行都杀掉重启 Codex）
//
// 背景（用户实测反馈）：
//   早期 `app` 无脑"杀掉已运行的 Codex 再拉起"，结果是**每次执行都会打断正在编辑的内容**。
//   修法是先判断"它其实已经在用我们的代理了"，在用就跳过（`app --force` 可强制重启）。
//
// 这里的难点：真判断要读进程命令行 / 查端口连接，而这两件事都需要启动子进程
// （受限沙箱里是 EPERM）。所以本测试分两层：
//   1) 真调 codexUsingOurProxy —— 验证它在"拿不到信息"时不会抛异常、不会误判成"在用"
//      （安全方向：拿不到信息时必须倾向于【重启】而不是【跳过】，否则改了配置也不生效）
//   2) 用假 pid 验证各判据的边界行为
//
// 判据本身（命令行里的 --proxy-server / 连到我们端口的 ESTABLISHED 连接）在 08 号
// 审计脚本里由真实 Codex 进程覆盖；这里守住的是"不会崩、不会误跳过"。
//
// 用法： node tests/15-app-idempotent.mjs
// 预期： 7/7 通过
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

const cfg = M.loadConfig();
const port = cfg.listen.port;

console.log('=== 15 app 命令幂等判断 ===\n');
console.log(`  本地代理端口: ${port}\n`);

// ---------------------------------------------------------------- 1 空输入
step('1. 没有 Codex 在运行时 → 判为"没在用"（不能误判成在用）');
{
  check('codexUsingOurProxy([]) === false', M.codexUsingOurProxy(cfg, []) === false, '');
  check('codexUsingOurProxy(null) === false', M.codexUsingOurProxy(cfg, null) === false, '');
}

// ---------------------------------------------------------------- 2 拿不到信息
step('2. 拿不到进程信息时 → 不会抛异常，且倾向"没在用"（宁可重启也不能误跳过）');
{
  // 用一个几乎不可能存在的 pid，读命令行大概率拿不到
  const fakePid = 999999999;
  let threw = null, value = null;
  try { value = M.codexUsingOurProxy(cfg, [fakePid]); } catch (e) { threw = e.message; }
  check('不抛异常', threw === null, threw || '');
  check('判为"没在用"（false）', value === false, `value=${value}`);
  check('这个方向是安全的：拿不到信息时不会误跳过，改了配置能生效',
    value === false, '（若返回 true，就会出现"app 什么都不做"的假象）');
}

// ---------------------------------------------------------------- 3 底层判据的容错
step('3. 底层判据对异常输入容错');
{
  let e1 = null, e2 = null;
  try { M.processCommandLine(999999999); } catch (e) { e1 = e.message; }
  try { M.pidHasConnectionTo(999999999, port); } catch (e) { e2 = e.message; }
  check('processCommandLine(不存在的 pid) 不抛异常', e1 === null, e1 || '');
  check('pidHasConnectionTo(不存在的 pid) 不抛异常', e2 === null, e2 || '');
}

// ---------------------------------------------------------------- 4 端口/查询能力
step('4. 端口归属查询能力自报（沙箱里会如实说查不到，不假装端口空闲）');
{
  const can = M.canLookupPorts();
  console.log(`    canLookupPorts() = ${can}`);
  // 不论能不能查，函数本身必须是布尔值、且不抛异常
  check('canLookupPorts() 返回布尔值', typeof can === 'boolean', String(can));
  // 查不到时 pidListeningOn 必须返回 null（而不是 0 或抛异常）
  const owner = M.pidListeningOn(port);
  check('pidListeningOn 返回 pid 或 null（不抛异常）',
    owner === null || (Number.isInteger(owner) && owner > 0), String(owner));
}

// ---------------------------------------------------------------- 汇总
console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
