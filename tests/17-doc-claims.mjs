// tests/17-doc-claims.mjs — 文档承诺 vs 代码实现 的一致性审计
//
// 目的：四份文档里写了很多具体数字与行为（默认值、命令、路径、测试数、退出码…）。
//       代码改了但文档忘改（或反过来）就会误导人。这个测试把那些"可以机器核对"的部分
//       全部抽成断言，让文档漂移在 CI/测试阶段就暴露出来。
//
// 覆盖来源：
//   README.md              架构图、三层出口、探测间隔、失败阈值、文件清单、文档链接
//   使用手册.md             命令表、配置默认值、退出码、命令行为
//   故障排查与说明.md        设计取舍里的具体数值与端口
//   tests/README.md        脚本清单一览表与 pass 计数
//
// 用法： node tests/17-doc-claims.mjs
import fs from 'node:fs';
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

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const README = read('README.md');
const MANUAL = read('使用手册.md');
const TROUBLE = read('故障排查与说明.md');
const TESTS = read('tests/README.md');
const ALL = [README, MANUAL, TROUBLE, TESTS].join('\n');

const cfg = M.loadConfig();
const ps1 = read('codex-proxy.ps1');
const mjs = read('codex-proxy.mjs');

console.log('=== 17 文档承诺 vs 代码实现 ===\n');

// ---------------------------------------------------------------- 1 README
step('1. README.md 里的具体声明');
{
  check('架构图说的监听端口 17890 与配置一致',
    /127\.0\.0\.1:17890/.test(README) && cfg.listen.port === 17890, `cfg=${cfg.listen.port}`);

  // 三层出口：名字与优先级
  const names = ['ssh:jp', 'xray:jp', 'clash-party'];
  check('三层出口的名字都在 README 与配置里出现',
    names.every((n) => README.includes(n) && mjs.includes(n)), '');

  // "8 节点自动测速切换"
  const nodeCount = cfg.uplinks.clashParty.maxNodes;
  check(`README 说"8 节点"与配置 maxNodes 一致`,
    /8 节点/.test(README) && nodeCount === 8, `maxNodes=${nodeCount}`);

  // "每 15 秒探测一次，连续 2 次失败"
  check('README 说"每 15 秒探测"与 intervalMs 一致',
    /每 15 秒/.test(README) && cfg.health.intervalMs === 15000, `intervalMs=${cfg.health.intervalMs}`);
  check('README 说"连续 2 次失败"与 failThreshold 一致',
    /连续 2 次失败/.test(README) && cfg.health.failThreshold === 2, `failThreshold=${cfg.health.failThreshold}`);

  // 不修改系统代理 / 不开 TUN
  const writesProxy = /Set-ItemProperty[^\n]*Internet Settings/i.test(mjs + ps1);
  check('README 声明"不修改系统代理"—— 代码里确实没有写注册表', !writesProxy, '');
  const hasTun = /^\s*tun\s*:/m.test(mjs);
  check('README 声明"不开 TUN"—— 生成的配置里没有 tun 段', !hasTun, '');

  // 文件清单里列的文件都存在
  for (const f of ['codex-proxy.ps1', 'codex-proxy.mjs', 'codex-proxy.config.json', 'bin/xray.exe']) {
    const p = path.join(ROOT, f);
    // bin\xray.exe 是 gitignore 的大文件，本地存在即可
    check(`README 文件清单里的 ${f} 存在`, fs.existsSync(p), '');
  }

  // 文档链接
  check('README 链向的三份文档都存在',
    ['使用手册.md', '故障排查与说明.md', 'tests/README.md'].every((f) => fs.existsSync(path.join(ROOT, f))), '');

  // ★ 测试脚本数（这里踩过：加了新测试忘记改 README）★
  //   两个易错点：
  //     ① 套件注册表在 tests/run-all.ps1 里，**不是** codex-proxy.ps1 —— 读错文件会永远得 0
  //     ② run-all.ps1 的写法是 `Id = '01';`（数字带引号），正则写成 Id = '\d+' 匹配不到
  const runAll = read('tests/run-all.ps1');
  const suiteCount = (runAll.match(/Id = '[^']+';/g) || []).length;
  const claimedRaw = /测试套件（(\d+) 个脚本/.exec(README);
  const claimed = claimedRaw ? Number(claimedRaw[1]) : null;
  check(`README 里的测试脚本数与 run-all 注册数一致（都应是 ${suiteCount}）`,
    claimed === suiteCount, `README 说 ${claimed}，实际 ${suiteCount}`);

  const claimedMRaw = /测试套件（(\d+) 个脚本/.exec(MANUAL);
  const claimedM = claimedMRaw ? Number(claimedMRaw[1]) : null;
  check(`使用手册里的测试脚本数也一致（都应是 ${suiteCount}）`,
    claimedM === suiteCount, `手册说 ${claimedM}，实际 ${suiteCount}`);
}

// ---------------------------------------------------------------- 2 命令表
step('2. 使用手册命令表 vs ps1/CLI 实际支持');
{
  // ★ 只取"命令参考"那一节的表格 ★
  //   两个易错点：
  //     ① 手册别处也有表格（第十一节的配置项表里有 slowMs/fastRatio 这些配置名），
  //        一把梭抓所有 `xxx` 开头的表格行会把配置名当命令，误报"ps1 不支持 slowMs"。
  //        所以先用小节标题把范围切开。
  //     ② 命令名后面可能还带参数占位（`use <名字>`），正则不能要求名字后立刻是反引号 ——
  //        写成 `([a-z][\w-]*)`` 会把 use 漏掉，然后误报"use 未写文档"。
  const cmdSection = MANUAL.split('## 八、命令参考')[1]?.split('\n## ')[0] || '';
  const cmds = [...new Set(
    [...cmdSection.matchAll(/^\|\s*`([a-z][\w-]*)[^`]*`/gm)].map((m) => m[1])
  )];
  const validateSet = /ValidateSet\(([^)]+)\)/.exec(ps1)?.[1] || '';
  const ps1Cmds = [...validateSet.matchAll(/'([^']+)'/g)].map((m) => m[1]);

  const missing = cmds.filter((c) => !ps1Cmds.includes(c));
  check('手册命令表里的命令 ps1 都支持', missing.length === 0,
    missing.length ? `缺: ${missing.join(', ')}` : `检查了 ${cmds.length} 个: ${cmds.join(' ')}`);

  // 反向：ps1 支持但手册没写的（可能漏文档）
  const native = ['cli', 'logs', 'test', 'tests', 'help'];
  const undocumented = ps1Cmds.filter((c) => !cmds.includes(c) && !native.includes(c));
  check('ps1 的命令都在手册里有说明（cli/logs/test/tests/help 除外）',
    undocumented.length === 0, undocumented.length ? `未写文档: ${undocumented.join(', ')}` : '');
}

// ---------------------------------------------------------------- 3 配置默认值
step('3. 手册/故障排查里写的默认值 vs 实际配置');
{
  const expectations = [
    ['探测间隔 15000', cfg.health.intervalMs, 15000],
    ['失败阈值 2', cfg.health.failThreshold, 2],
    ['slowMs 地板 250', cfg.health.slowMs, 250],
    ['fastRatio 2', cfg.health.fastRatio, 2],
    ['minGainMs 150', cfg.health.minGainMs, 150],
    ['satisfiedPolls 3', cfg.health.satisfiedPolls, 3],
    ['cooldownMs 120000', cfg.health.cooldownMs, 120000],
  ];
  for (const [label, actual, want] of expectations) {
    check(`${label}`, actual === want, `实际 ${actual}`);
  }

  // 手册里写出来的数字必须能在手册里找到（防手册与配置脱节）
  check('手册里写了 slowMs 的默认值 250', /slowMs`?\s*\|\s*\*?\*?250/.test(MANUAL) || /250/.test(MANUAL), '');
  check('手册里写了 cooldownMs 的默认值（2 分钟）', /120000|2 分钟/.test(MANUAL), '');
  check('手册里写了 connIdleTimeoutSec', /connIdleTimeoutSec/.test(MANUAL), '');
  check('配置里确实有 connIdleTimeoutSec', 'connIdleTimeoutSec' in cfg.health,
    String(cfg.health.connIdleTimeoutSec));
}

// ---------------------------------------------------------------- 4 故障排查表
step('4. 故障排查速查表里的每条都能对上');
{
  // 表里提到的日志文件名必须真的会被写出来
  const logFiles = ['ssh-tunnel.log', 'xray-client.log', 'fallback-mihomo.log'];
  for (const f of logFiles) {
    check(`速查表提到的 ${f} 在代码里会被写`, mjs.includes(f), '');
  }
  check('速查表提到的 daemon-*.log 命名规则对得上',
    /daemon-\$\{new Date|daemon-' \+|`daemon-\$\{/.test(mjs) || mjs.includes("`daemon-${"), '');
  check('速查表提到的 windows-updater 报错文案与文档一致',
    /程序包标识符/.test(TROUBLE), '');

  // 手册里用 "17890~17893" 这个写法（在 stop/down 对比表里）。
  // 注意两点：
  //   ① 这个写法在【使用手册】里，故障排查文档用的是 netstat 表达式形式 —— 别抓错文档
  //   ② 必须用 socksPort（17891），不能用 ssh.port（22 是 SSH 登录端口，不是出口端口）
  const socksPortDoc = cfg.uplinks.ssh.socksPort ?? cfg.uplinks.ssh.port;
  const portList = [cfg.listen.port, socksPortDoc, cfg.uplinks.xray.port, cfg.uplinks.clashParty.mixedPort];
  check('手册提到的端口范围 17890~17893 与配置一致',
    /17890~17893/.test(MANUAL) && portList.join(',') === '17890,17891,17892,17893',
    portList.join('/'));
  check('故障排查文档里的 netstat 端口表达式覆盖同样四个端口',
    /\(17890\|17891\|17892\|17893\)/.test(TROUBLE), '');

  check('速查表提到的 mihomo 内核检测（点取消会退出）有对应说明',
    /高权限内核/.test(TROUBLE) && /退出/.test(TROUBLE), '');
}

// ---------------------------------------------------------------- 5 tests/README
step('5. tests/README.md 的脚本清单 vs 实际文件');
{
  const files = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter((f) => /^\d\d-/.test(f)).sort();
  const listed = [...TESTS.matchAll(/\| `(\d\d-[\w.-]+)`/g)].map((m) => m[1]);
  const listedSet = new Set(listed);

  const notListed = files.filter((f) => !listedSet.has(f));
  check('tests/ 下每个脚本都在 README 清单里', notListed.length === 0,
    notListed.length ? `未列出: ${notListed.join(', ')}` : `检查了 ${files.length} 个`);

  const notExist = listed.filter((f) => !files.includes(f));
  check('README 清单里的脚本都存在（没有已删除却还列着的）', notExist.length === 0,
    notExist.length ? `已不存在: ${notExist.join(', ')}` : '');

  // 辅助文件与调度器
  check('README 提到 _helpers.mjs 并说明用途', /_helpers\.mjs/.test(TESTS), '');
  check('README 提到 run-all.ps1', /run-all\.ps1/.test(TESTS), '');
}

// ---------------------------------------------------------------- 6 端口与路径一致性
step('6. 文档里的端口/路径与代码一致');
{
  // ★ 注意：ssh 出口有两个端口概念，别搞混 ★
  //   uplinks.ssh.port      = 22    → SSH【登录】端口（连服务器的 22）
  //   uplinks.ssh.socksPort = 17891 → 本地 -D 动态转发的 SOCKS 端口（出口端口）
  //   早期这里读了 ssh.port 去比 17891，得出"配置=22，不一致"的误报。
  const socksPort = cfg.uplinks.ssh.socksPort ?? cfg.uplinks.ssh.port;
  const ports = {
    17890: cfg.listen.port,
    17891: socksPort,
    17892: cfg.uplinks.xray.port,
    17893: cfg.uplinks.clashParty.mixedPort,
  };
  for (const [doc, actual] of Object.entries(ports)) {
    check(`端口 ${doc} 与配置一致`, Number(doc) === actual, `配置=${actual}`);
  }
  check('ssh 登录端口单独配置（不该与 SOCKS 出口端口混用）',
    typeof cfg.uplinks.ssh.port === 'number' && cfg.uplinks.ssh.socksPort === 17891,
    `登录端口=${cfg.uplinks.ssh.port} SOCKS=${cfg.uplinks.ssh.socksPort}`);
  check('配置里的 dataDir 指向 Clash Party（文档说只读它）',
    /mihomo-party$/.test(cfg.uplinks.clashParty.dataDir), cfg.uplinks.clashParty.dataDir);
  check('故障排查说明文档承诺"只读"Clash Party 数据目录',
    /只读|绝不写入|不写入/.test(TROUBLE), '');
}

// ---------------------------------------------------------------- 汇总
console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
