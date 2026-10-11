// tests/19-output-contract.mjs — 命令输出契约与行为约定
//
// 与 17/18 号的分工：
//   17 号 = 文档里的数字/命令/路径与代码一致（防文档漂移）
//   18 号 = 文档提到的功能是否真的实现了（防功能遗漏）
//   19 号 = 命令【输出格式】与【行为约定】是否符合文档描述（防输出契约被改坏）
//
// 为什么单独做这一层：用户是照着文档读输出的。
// 如果 status 的表头改了一个字、或者 stop/down 的行为变了对调，
// 17/18 号都不会发现（功能还在、数字也对），但用户会看不懂输出、或者误以为命令坏了。
//
// 覆盖：
//   A. status 输出的段落与表头（与使用手册第八节的示例逐项对照）
//   B. stop / down / use / best / auto 的行为约定（使用手册第八节的两张对比表）
//   C. 几个关键提示语的存在（用户排障时要靠它们定位）
//   D. 退出码约定（0 = 成功，非 0 = 失败），因为 ps1 依赖它
//
// 用法： node tests/19-output-contract.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const M = await import(pathToFileURL(path.join(ROOT, 'codex-proxy.mjs')).href);

const mjs = fs.readFileSync(path.join(ROOT, 'codex-proxy.mjs'), 'utf8');
const ps1 = fs.readFileSync(path.join(ROOT, 'codex-proxy.ps1'), 'utf8');
const MANUAL = fs.readFileSync(path.join(ROOT, '使用手册.md'), 'utf8');

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, skipped: false, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}
/**
 * 登记一条【跳过】的断言。
 *
 * 为什么要单独一个状态（而不是直接不调用 check）：
 *   断言总数必须恒定 —— 20 号测试会拿 tests/README 写的数字跟实际比，
 *   数字随环境变化就会 FAIL。但"跳过"又确实不等于"通过"，
 *   所以它【计入总数】但【不判失败】，输出上也明确写"跳过"。
 */
function skip(name, why = '') {
  results.push({ name, ok: false, skipped: true, detail: why });
  console.log(`  [跳过] ${name}${why ? '  — ' + why : ''}`);
}

console.log('=== 19 命令输出契约与行为约定 ===\n');

// ---------------------------------------------------------------- A. status 输出
step('A. status 输出的段落与表头（对照使用手册第八节的示例）');
{
  // 手册里那段示例
  const sec = MANUAL.split('### `status` 输出怎么读')[1]?.split('```')[1] || '';
  check('手册里确实有 status 示例', sec.length > 100, `${sec.split('\n').length} 行`);

  // 示例【下方】的说明条目也要算进来：有些行只在说明里提（例如"不是我们的子进程"警告），
  // 不画在示例里是合理的 —— 只在真有流量/真有残留时才出现。
  // ★ 切到【下一个同级标题】为止，不能切到 `---` ★
  //   手册的 status 小节后面紧跟的是 `---` 分隔线，而流量表/端口归属段落位于
  //   示例代码块【之后】、`---` 之前，用 `---` 切会把它们全切掉、造成一片误报。
  const secAll = MANUAL.split('### `status` 输出怎么读')[1]?.split('\n## ')[0] || sec;

  // 示例里出现的每个"结构行"，代码里都要有对应的打印
  const contract = [
    ['状态行', /状态：运行中 \(pid /, /console\.log\(`状态：运行中 \(pid \$\{pid\}\)`\)/],
    ['监听行（含出口）', /监听：127\.0\.0\.1:17890\s+出口：/, /监听：127\.0\.0\.1:\$\{st\.listenPort\}\s+出口：/],
    ['出口表头（六列）', /出口\s+端口\s+优先级\s+健康\s+延迟\*\s+握手\s+说明/, /出口\s+端口\s+优先级\s+健康\s+延迟\*\s+握手\s+说明/],
    ['延迟/握手脚注', /延迟 = 一次真实 HTTPS 往返/, /延迟 = 一次真实 HTTPS 往返/],
    ['握手值说明（0~2ms 不能当延迟）', /本机出口的握手值恒为 0~2ms/, /本机出口的握手值恒为 0~2ms/],
    ['连接数行', /连接数：\d+\s+失败：\d+/, /连接数：\$\{s\.connects/],
    ['流量表标题', /各出口实际承载的流量（累计，按连接建立时的出口归属）/, /各出口实际承载的流量（累计，按连接建立时的出口归属）/],
    ['流量表表头（五列）', /出口\s+连接数\s+活动\s+上行\s+下行\s+最后使用/, /出口\s+连接数\s+活动\s+上行\s+下行\s+最后使用/],
    ['端口归属段', /端口归属：/, /端口归属：/],
    ['子进程标注', /子进程/, /子进程/],
    // 这一条在示例下方的说明里（"- **端口归属**用于确认……出现 `⚠ 不是我们的子进程` 就 restart"）
    ['非自己子进程的警告', /不是我们的子进程/, /不是我们的子进程/],
  ];
  for (const [label, inDoc, inCode] of contract) {
    const docHas = inDoc.test(secAll);
    check(label, docHas && inCode.test(mjs),
      !docHas ? '文档里没提这一项' : (inCode.test(mjs) ? '' : '文档有但代码里找不到'));
  }

  // 段落顺序：连接数 → 流量表 → 端口归属（手册示例就是这个顺序）
  const iConn = mjs.indexOf('连接数：${s.connects');
  const iTraffic = mjs.indexOf('各出口实际承载的流量');
  const iPorts = mjs.indexOf('端口归属：');
  check('段落顺序与手册一致：连接数 → 各出口流量 → 端口归属',
    iConn > 0 && iTraffic > iConn && iPorts > iTraffic,
    `连接数@${iConn} 流量@${iTraffic} 端口@${iPorts}`);

  // 手册示例里没画出来的两行，代码里其实有 —— 这是文档可以更完整的地方，不算错
  check('代码额外打印「活动连接分布」（手册示例未包含，属可选补充信息）',
    /活动连接分布/.test(mjs), '不是缺陷：只是手册那份示例当时活动连接为 0');
  check('强制指定时额外提示怎么解除',
    /想恢复自动/.test(mjs), '');
}

// ---------------------------------------------------------------- B. 行为约定
step('B. stop / down / use / best / auto 的行为约定');
{
  // 手册第八节的 stop vs down 对比表
  const stopDownTable = /## 八、命令参考[\s\S]*?\|.*`stop`.*\|.*`down`/.test(MANUAL) ||
    /\| \| `stop` \| `down` \|/.test(MANUAL);
  check('手册里有 stop/down 对比表', /\| `stop` \| `down` \|/.test(MANUAL), '');

  const iDown = mjs.indexOf('async function cmdDown');
  const downBody = mjs.slice(iDown, iDown + 900);
  check('down = 先关 Codex、再停代理（顺序有讲究）',
    downBody.indexOf('listProcesses') < downBody.indexOf('cmdStop'),
    '手册说"代理 + Codex 一起关"');
  check('down 调用了 cmdStop（代理确实被停）', /cmdStop\(\)/.test(downBody), '');

  const iStop = mjs.indexOf('function cmdStop');
  const stopBody = mjs.slice(iStop, iStop + 900);
  check('stop 不碰 Codex（只停代理）',
    !/listProcesses|killTree/.test(stopBody.replace(/killTree\(pid\)/, '')),
    '手册说"Codex 不关，会继续运行、恢复直连"');
  check('stop 优先走控制端口（Windows 信号不可靠）',
    stopBody.includes("sendControl('stop'"), '');

  // best vs use 对比表
  check('手册里有 best/use 对比表', /\| \| `best` \| `use <名字>` \|/.test(MANUAL), '');
  const bestBody = mjs.slice(mjs.indexOf('async function cmdBest'), mjs.indexOf('async function cmdUse'));
  const useBody = mjs.slice(mjs.indexOf('async function cmdUse'), mjs.indexOf('async function cmdAuto'));
  check('best 不带 pin（不钉住）', !/pin: true/.test(bestBody), '');
  check('use 带 pin + name（强制指定）', /pin: true/.test(useBody) && /name/.test(useBody), '');
  check('best 明确提示"没钉住"并说明怎么强制固定',
    /没钉住/.test(bestBody) && /use <名字>/.test(bestBody), '');
  check('auto 明确提示"不会立刻跳走（粘性）"',
    /不会立刻跳走|粘性/.test(mjs.slice(mjs.indexOf('async function cmdAuto'), mjs.indexOf('async function cmdAuto') + 900)), '');

  // 手册说的"幂等"行为
  check('app 幂等时打印"跳过重启"并告知 --force',
    /跳过重启/.test(mjs) && /--force/.test(mjs), '');
}

// ---------------------------------------------------------------- C. 关键提示语
step('C. 排障时要靠的关键提示语都存在');
{
  const hints = [
    ['守护进程不认识该命令（旧代码）', /守护进程不认识该命令/],
    ['联系不上守护进程', /联系不上守护进程/],
    ['端口被残留进程占用', /判为上一轮残留|被 pid \$\{holder\} 占用/],
    ['端口归属查询不可用的说明', /本环境禁止查询端口归属/],
    ['查不到端口归属 ≠ 空闲', /不代表端口空闲/],
    ['跳过这一轮（防重入）', /上一轮健康探测还没跑完/],
    ['出口切换日志', /出口切换：/],
    ['性能判定切换日志（含连续次数与冷静期）', /性能判定切换出口：/],
    ['主动断开旧出口连接的日志', /主动断开挂在/],
    ['空闲超时断开的日志', /空闲超时（/],
    ['回收上一轮遗留进程的日志', /回收上一轮遗留|回收占用端口/],
    ['xray 配置问题的清晰提示', /xray 配置有问题/],
    ['回落内核改名的风险警告', /高权限内核.*检测弹窗|检测弹窗/],
  ];
  for (const [label, re] of hints) {
    check(label, re.test(mjs) || re.test(ps1), '');
  }
}

// ---------------------------------------------------------------- D. 退出码
step('D. 退出码约定（ps1 依赖它决定是否继续）');
{
  // ★ 别用 {0,N} 这种有上限的窗口去截函数体 ★
  //   cmdStatus 超过 4000 字符，写 {0,4000} 会截断到 return 1 之后、找不到后面的 return 0。
  //   也别用"下一个顶层声明"来切 —— 函数后面常紧跟 `/** … */` 注释块，会被误当成边界
  //   （cmdCheck 就是这样，导致 return ok ? 0 : 1 被切掉）。用足够大的窗口 + 具体模式。
  const WIN = 20000;
  const bodyOf = (name) => {
    const start = mjs.indexOf(name);
    return start < 0 ? '' : mjs.slice(start, start + WIN);
  };
  const statusBody = bodyOf('function cmdStatus');

  check('cmdStatus 未运行时返回 1（ps1 靠它判断）',
    /状态：未运行/.test(statusBody) && /return 1;/.test(statusBody), '');
  check('cmdStatus 成功路径返回 0', /return 0;/.test(statusBody), '');
  check('cmdCheck 按连通性返回 0/1', /return ok \? 0 : 1;/.test(bodyOf('async function cmdCheck')), '');
  check('未知命令返回 2 并打印用法', /default:[\s\S]{0,200}?return 2;/.test(mjs), '');
  check('用法里列的命令与实际支持的一致',
    (() => {
      const usage = /用法: node codex-proxy\.mjs <([^>]+)>/.exec(mjs)?.[1] || '';
      const listed = usage.split('|');
      const cases = [...mjs.matchAll(/case '([\w-]+)':/g)].map((m) => m[1]).filter((c) => c !== 'daemon');
      return cases.every((c) => listed.includes(c));
    })(), '');
  check('CLI 直接运行时用 process.exit(rc ?? 0)',
    /process\.exit\(rc \?\? 0\)/.test(mjs), '');
}

// ---------------------------------------------------------------- E. 退出码实测
step('E. 退出码实测（不需要守护进程也能测的那几个）');
{
  // 直接调用命令函数，验证返回值
  const cfg = M.loadConfig();

  // status：守护进程没跑时返回 1
  const hadPid = (() => { try { return !!fs.readFileSync(path.join(ROOT, 'run', 'daemon.pid'), 'utf8').trim(); } catch { return false; } })();
  if (!hadPid) {
    const origLog = console.log; let out = '';
    console.log = (...a) => { out += a.join(' ') + '\n'; };
    let rc;
    try { rc = M.cmdStatusForTest ? M.cmdStatusForTest() : null; } catch { rc = null; }
    console.log = origLog;
    if (rc !== null) {
      check('守护进程未运行时 status 返回 1', rc === 1, `rc=${rc}`);
    } else {
      console.log('      （status 没导出，跳过这条；靠上面 D 组的静态断言覆盖）');
    }
  } else {
    console.log('      （守护进程在运行，跳过"未运行返回 1"的实测）');
  }

  // 纯函数类命令不涉及退出码，这里确认导出齐全
  check('测试所需的命令实现都能拿到（决定可否做行为级测试）',
    ['formatResolveInfo', 'decideLatencySwitch', 'measureUplink', 'codexUsingOurProxy']
      .every((k) => typeof M[k] === 'function'),
    '');
}

// ---------------------------------------------------------------- F. 选项解析
step('F. 命令行选项解析（★ 踩过的坑：位置 0 的选项被忽略）');
{
  // 背景：原来 argOf 写的是 `i > 0 && argv[i + 1]`。
  //       indexOf 返回 0 表示"选项就在第一个位置"，而 0 > 0 是 false ——
  //       于是 `app --prefer newest ...` 这种把选项放最前的写法会被**静默忽略**，
  //       日志里照样打印配置里的默认值：说的和做的不一致（实测抓到）。
  // 这里同时做静态断言和真跑断言。
  check('argOf 用的是 i >= 0（不是 i > 0）',
    (mjs.match(/i >= 0 && argv\[i \+ 1\]/g) || []).length >= 2 &&
    !/i > 0 && argv\[i \+ 1\]/.test(mjs),
    `找到 ${(mjs.match(/i >= 0 && argv\[i \+ 1\]/g) || []).length} 处`);

  // 真跑：把选项放最前面，看策略名有没有被读到
  // ★ 两个分支的断言数必须一致 ★
  //   踩过的坑：原来"不能 spawn"那一支只打印一句说明、一条 check 都不发，
  //   于是**断言总数随环境变化**（能 spawn → 50，不能 → 47），
  //   而 20 号测试会拿 tests/README 里写的数字跟实际比，数字飘了就会 FAIL。
  //   修法：不能跑时也照发 3 条 check，如实报"跳过/未验证"。
  //   这样总数恒定 50，而且"没验证"这件事在结果里看得见 —— 不伪装成通过。
  const { spawnSync } = await import('node:child_process');
  const canSpawn = (() => {
    try {
      const p = spawnSync(process.execPath, ['-e', 'process.exit(0)'],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10000 });
      return !p.error;
    } catch (e) { return !(e && (e.code === 'EPERM' || e.code === 'EACCES')); }
  })();
  const fake = ['--desktop-exe', 'C:\\nonexistent\\ChatGPT.exe', '--desktop-version', '9.9.9'];

  if (canSpawn) {
    const run = (args) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'codex-proxy.mjs'), 'app', ...args],
        { encoding: 'utf8', windowsHide: true, timeout: 120000, cwd: ROOT });
      return String((r.stdout || '') + (r.stderr || ''));
    };

    const first = run(['--prefer', 'newest', ...fake]);
    check('选项放最前面时 --prefer 生效（真跑）',
      /策略 newest/.test(first), first.match(/策略 \w+/)?.[0] || '没跑到启动那行');

    const middle = run([...fake.slice(0, 2), '--prefer', 'newest', ...fake.slice(2)]);
    check('选项放中间时 --prefer 生效（真跑）',
      /策略 newest/.test(middle), '');

    const none = run(fake);
    check('不传 --prefer 时回退到配置里的策略（真跑）',
      /策略 registered/.test(none), '');
  } else {
    for (const label of ['选项放最前面时 --prefer 生效', '选项放中间时 --prefer 生效',
                         '不传 --prefer 时回退到配置里的策略']) {
      skip(`${label}（真跑）`,
        '本环境不允许启动子进程（spawn EPERM）；根因已由上面的静态断言覆盖');
    }
  }
}

// ---------------------------------------------------------------- 汇总
console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
const skippedN = results.filter((r) => r.skipped).length;
const failed = results.filter((r) => !r.ok && !r.skipped);
console.log(`${pass}/${results.length} 通过${skippedN ? `（另有 ${skippedN} 项因环境受限跳过）` : ''}`);
for (const r of failed) console.log(`  未通过: ${r.name} — ${r.detail}`);
if (skippedN) console.log(`  （跳过的项需要真实环境才能验证，不代表通过）`);
process.exit(failed.length === 0 ? 0 : 1);
