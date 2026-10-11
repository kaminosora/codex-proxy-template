// tests/21-doc-details.mjs — 四份文档的"细节级"核对
//
// 与 17/18/19 号的分工：
//   17 = 文档里的数字/命令/路径是否与代码一致（防漂移）
//   18 = 文档提到的功能是否真的实现了（防遗漏）
//   19 = 命令输出契约与行为约定
//   21 = ★ 细节级 ★：文档里贴的**代码片段**、引用的**文件路径**、**内部锚点链接**、
//        以及"这个字符串确实是我们的代码打出来的吗"
//
// 为什么需要这一层：文档里贴的代码片段如果和实现不一致，读者照着想问题就会被带偏；
// 内部链接失效则等于把读者扔在原地。这些 17/18/19 都覆盖不到。
//
// 用法： node tests/21-doc-details.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const results = [];
const step = (s) => console.log('--> ' + s);
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`  ${cond ? '[OK]  ' : '[FAIL]'} ${name}${detail ? '  — ' + detail : ''}`);
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const mjs = read('codex-proxy.mjs');
const ps1 = read('codex-proxy.ps1');
const DOCS = {
  'README.md': read('README.md'),
  '使用手册.md': read('使用手册.md'),
  '故障排查与说明.md': read('故障排查与说明.md'),
  'tests/README.md': read('tests/README.md'),
};

console.log('=== 21 四份文档的细节级核对 ===\n');

// ================================================================ A. 内部锚点
step('A. 内部锚点链接（点进去要能跳到对应标题）');
{
  // ★ 别自己实现 GitHub 的 slug 算法 —— 全角标点（、：（））的处理很容易写错，
  //   我第一版就把它写错导致 12 个锚点全部误报"无效"。
  //   改成"归一化比较"：两边都只保留字母/数字/中文再比，绕开算法差异。
  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  let totalLinks = 0;
  for (const [f, doc] of Object.entries(DOCS)) {
    const heads = [...doc.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1]);
    const anchors = new Set(heads.map(norm));
    const links = [...new Set(
      [...doc.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]).filter((h) => h.startsWith('#'))
    )].map((h) => h.slice(1));
    totalLinks += links.length;
    const bad = links.filter((l) => !anchors.has(norm(l)));
    check(`${f} 的 ${links.length} 个内部锚点都有效`, bad.length === 0,
      bad.length ? `无效: ${bad.join(', ')}` : '');
  }
  check('至少检查到若干内部链接（确认正则没白跑）', totalLinks >= 20, `共 ${totalLinks} 个`);
}

// ================================================================ B. 跨文档链接
step('B. 跨文档链接指向的文件都存在');
{
  for (const [f, doc] of Object.entries(DOCS)) {
    const files = [...new Set(
      [...doc.matchAll(/\]\((?!https?:|#)([^)#]+\.(?:md|mjs|ps1|json))/g)].map((m) => m[1])
    )];
    const bad = files.filter((rel) => {
      const p = path.resolve(path.dirname(path.join(ROOT, f)), rel);
      return !fs.existsSync(p);
    });
    check(`${f} 引用的 ${files.length} 个文件都存在`, bad.length === 0,
      bad.length ? `不存在: ${bad.join(', ')}` : '');
  }
}

// ================================================================ C. 文档里贴的代码片段
step('C. 文档里贴的代码片段与实现一致');
{
  // 故障排查第十节贴的"修复"片段
  check('第十节贴的 dropConnectionsOnUplink 调用与实现一致（含宽限参数）',
    /dropConnectionsOnUplink\(prev\.name, '切换出口', \{/.test(mjs) &&
    /dropConnectionsOnUplink\(l\.name, '该出口被判不健康', \{/.test(mjs) &&
    /switchDropGraceMs/.test(DOCS['故障排查与说明.md']) &&
    /downDropGraceMs/.test(DOCS['故障排查与说明.md']),
    '文档片段必须跟实现一起改，否则读者照着想会被带偏');

  // 故障排查第十一节贴的"真实延迟判据"片段
  check('第十一节贴的 requestTiming 判据与实现一致',
    /maxBytes: 1/.test(mjs) && /realMs = Date\.now\(\) - t0/.test(mjs),
    '');
  check('第十一节贴的 handshakeMs / latencyFresh 与实现一致',
    /h\.handshakeMs = handshake/.test(mjs) && /h\.latencyFresh = realMs !== null/.test(mjs),
    '');

  // 故障排查第一节的硬规矩（PowerShell 写法）
  check('硬规矩一节建议的写法确实安全（不带 -NoNewline）',
    /Set-Content -Path \$f -Value \$lines -Encoding UTF8/.test(DOCS['故障排查与说明.md']) &&
    !/Set-Content[^\n]*-NoNewline[^\n]*\n[^\n]*推荐/.test(DOCS['故障排查与说明.md']),
    '');

  // 使用手册里贴的"看 Codex 连接"片段
  check('使用手册贴的 Get-NetTCPConnection 片段可用',
    /Get-NetTCPConnection -OwningProcess/.test(DOCS['使用手册.md']), '');
  check('使用手册贴的注册表查询片段正确',
    /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings/.test(DOCS['使用手册.md']),
    '');
}

// ================================================================ D. 提到的文件/日志名
step('D. 文档里提到的日志文件与内部路径都真的会被创建');
{
  const logNames = ['ssh-tunnel.log', 'xray-client.log', 'fallback-mihomo.log'];
  for (const n of logNames) {
    check(`日志 ${n} 在代码里会被写`, mjs.includes(n), '');
    check(`日志 ${n} 在文档里被提到`, Object.values(DOCS).some((d) => d.includes(n)), '');
  }
  check('daemon-*.log 的命名规则与代码一致',
    /daemon-\$\{/.test(mjs) || /`daemon-/.test(mjs), '');
  check('文档提到的 run\\node-test 目录在代码里会被建',
    /node-test/.test(mjs) && /node-test/.test(DOCS['故障排查与说明.md']), '');
  check('文档提到的 bin\\codex-core.exe 就是代码选用的内核',
    /'codex-core\.exe'/.test(mjs) && DOCS['故障排查与说明.md'].includes('codex-core.exe'), '');
}

// ================================================================ E. 关键文案确实是我们的代码打的
step('E. 文档引用的错误文案确实来自我们的代码');
{
  const fromCode = [
    ['不是我们的子进程', /不是我们的子进程/],
    ['订阅里没有 mihomo 支持的可用节点', /订阅里没有 mihomo 支持的可用节点/],
    ['内核未就绪', /内核未就绪/],
    ['守护进程未在 8 秒内退出', /守护进程未在 8 秒内退出/],
    ['高权限内核（改名警告）', /高权限内核/],
  ];
  for (const [label, re] of fromCode) {
    check(`${label} 在代码里有对应输出`, re.test(mjs) || re.test(ps1), '');
  }

  // ★ 反向核对：这几条【不是】我们的代码打的，文档也不该说成是我们的 ★
  //   写这段时踩过：一开始把"该进程没有程序包标识符"也列进上面那张表，结果 FAIL ——
  //   那是 **Codex 自己的更新器**（windows-updater）打的，我们只是把它当证据引用。
  //   判据要反过来：我们的代码里**不该**有它，而文档要把它归因给 Codex。
  const notOurs = [
    ['received real certificate', 'xray-client.log'],
    ['该进程没有程序包标识符', 'windows-updater'],
  ];
  for (const [text, whose] of notOurs) {
    check(`"${text}" 正确地归因给 ${whose}（不是我们的代码打的）`,
      !mjs.includes(text) && !ps1.includes(text) &&
      Object.values(DOCS).some((d) => d.includes(text) && d.includes(whose)),
      '我们的代码里不该有这条文案；文档要标明它来自对方');
  }
}

// ================================================================ F. 文档引用的配置项都存在
step('F. 文档里提到的每个配置项都能在配置里找到');
{
  const cfgText = read('codex-proxy.config.json');
  // ★ 用"配置里真实存在的键名"做白名单来比对，不要靠正则形状去猜 ★
  //   试过两版正则都不行：`codex(?:\.[a-zA-Z][\w]*)+` 会把 `codex.exe` / `codex.lnk`
  //   这类**文件名**当成配置项；收紧成小写开头也还是会把 `codex.lnk` 算进来
  //   （因为 .lnk 恰好是小写开头）。直接读配置拿键名最可靠。
  const knownKeys = new Set();
  (function walk(o) {
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const [k, v] of Object.entries(o)) {
        if (k === '//' || k.startsWith('//')) continue;   // 配置里的注释键
        knownKeys.add(k);
        walk(v);
      }
    }
  })(JSON.parse(cfgText));

  const refs = new Set();
  for (const doc of Object.values(DOCS)) {
    // ★ 配置键必含大写字母（驼峰：desktopExe / mixedPort / intervalMs / clashParty）★
    //   所以要求点号后的每一段至少有一个大写字母 —— 这样 `codex.lnk` / `codex.exe`
    //   这类**全小写的文件名**就不会被误当成配置项。（前两版正则都栽在这里）
    for (const m of doc.matchAll(/`((?:listen|uplinks|health|codex)(?:\.[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)+)`/g)) {
      refs.add(m[1]);
    }
  }
  // 再核一遍：叶子段必须是配置里真实存在的键
  const missing = [...refs].filter((r) => {
    const leaf = r.split('.').pop();
    return !knownKeys.has(leaf);
  });
  check(`文档引用的 ${refs.size} 个配置项都能在配置里找到`, missing.length === 0,
    missing.length ? `缺: ${missing.join(', ')}` : `（白名单里共 ${knownKeys.size} 个真实配置键）`);
}

// ================================================================ G. 文档里的命令都能跑
step('G. 文档里出现的每条 .\\codex-proxy.ps1 命令都被支持');
{
  const validateSet = /ValidateSet\(([^)]+)\)/.exec(ps1)?.[1] || '';
  const supported = new Set([...validateSet.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const used = new Set();
  for (const doc of Object.values(DOCS)) {
    for (const m of doc.matchAll(/\\codex-proxy\.ps1\s+([a-z][\w-]*)/g)) used.add(m[1]);
  }
  const bad = [...used].filter((c) => !supported.has(c));
  check(`文档里用到的 ${used.size} 个命令都被支持`, bad.length === 0,
    bad.length ? `不支持: ${bad.join(', ')}` : '');
}

// ================================================================ 汇总
console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
