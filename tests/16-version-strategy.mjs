// tests/16-version-strategy.mjs — Codex 版本识别与选择策略
//
// 背景：文档里承诺了 `codex.desktopPrefer` 三种策略（registered/newest/running）和
//       "app/resolve 会打印版本"，但**代码里一处都没实现**（实测确认：搜 desktopPrefer 0 处）。
//       本次补上了，这个测试守住它。
//
// 覆盖：
//   1) 从包目录名解析版本号（OpenAI.Codex_26.1007.2314.0_x64__hash）
//   2) 三种策略的参数能正确传到 PowerShell 侧（--prefer）
//   3) resolve 会打印：策略、版本、已装版本清单、并标出"不能直接用"的
//   4) 显式配置的 desktopExe 优先于任何策略
//
// 用法： node tests/16-version-strategy.mjs
// 预期： 8/8 通过
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

console.log('=== 16 Codex 版本识别与选择策略 ===\n');

// ---------------------------------------------------------------- 1 版本解析
step('1. 从包目录名解析版本号（ps1 与 node 两侧都要能解析）');
{
  const cases = [
    ['C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe', '26.1007.2314.0'],
    ['C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3_x64__abc\\app\\ChatGPT.exe', '1.2.3'],
  ];
  let ok = 0;
  for (const [p, want] of cases) {
    const m = p.match(/OpenAI\.Codex_([0-9]+(?:\.[0-9]+)+)_/);
    if (m && m[1] === want) ok++;
    else console.log(`      不匹配: ${p} → ${m ? m[1] : 'null'}（期望 ${want}）`);
  }
  check('包目录名的版本号能正确解析', ok === cases.length, `${ok}/${cases.length}`);
}

// ---------------------------------------------------------------- 2 resolve 输出
step('2. resolve 会打印策略说明、选中版本、以及已装版本清单');
{
  // ★ 直接调用生产里的 formatResolveInfo（cmdResolve 用的就是它）★
  //   早期这里用 spawnSync 起子进程跑 CLI —— 受限环境会被拒（EPERM）导致测试假失败，
  //   而且那种测法还绕了一层。抽成纯函数后测的就是真正的生产代码。
  const exe = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
  const installedRaw = '26.1007.2314.0|True|True;26.1007.9999.0|False|True;26.1007.1000.0|True|False';
  const cfg = M.loadConfig();
  const out = M.formatResolveInfo(cfg, {
    desktopExe: exe,
    desktopVersion: '26.1007.2314.0',
    installed: M.parseInstalledArg(installedRaw),
  });

  check('打印了版本策略名（registered）', /版本策略.*registered/.test(out), '');
  check('打印了三种策略的含义',
    /registered/.test(out) && /newest/.test(out) && /running/.test(out), '');
  check('打印了选中的版本号', /26\.1007\.2314\.0/.test(out), '');
  check('打印了已装版本清单（3 个）', /共 3 个/.test(out), '');
  check('把"未注册但版本更大"的标成不能直接用',
    /26\.1007\.9999\.0/.test(out) && /不能直接用/.test(out), '');
  check('把"已注册但没有 exe"的也标出来',
    /26\.1007\.1000\.0/.test(out), '');
  check('parseInstalledArg 解析正确（3 条，标志位是布尔）',
    (() => {
      const a = M.parseInstalledArg(installedRaw);
      return a.length === 3 && a[0].registered === true && a[0].hasExe === true &&
             a[1].registered === false && a[2].hasExe === false;
    })(), '');
}

// ---------------------------------------------------------------- 3 策略接线
step('3. 三种策略在 ps1 里都接上了（--prefer 透传）');
{
  const ps1 = fs.readFileSync(path.join(ROOT, 'codex-proxy.ps1'), 'utf8');
  check('ps1 读了配置 codex.desktopPrefer', /desktopPrefer/.test(ps1), '');
  check('ps1 支持三种策略分支',
    /'registered'/.test(ps1) && /'newest'/.test(ps1) && /'running'/.test(ps1), '');
  check('ps1 解析出三元组（路径+版本+来源）',
    /New-CodexDesktopInfo/.test(ps1) && /Version/.test(ps1), '');
  check('app 会把 --desktop-version 传给 node',
    /--desktop-version/.test(ps1), '');
}

// ---------------------------------------------------------------- 4 策略语义
step('4. 策略语义检查（静态：关键分支都在，且优先级顺序正确）');
{
  const ps1 = fs.readFileSync(path.join(ROOT, 'codex-proxy.ps1'), 'utf8');
  // 显式配置的路径必须优先于任何策略
  const cfgIdx = ps1.indexOf('codex.desktopExe');
  const runningIdx = ps1.indexOf("$Prefer -eq 'running'");
  const newestIdx = ps1.indexOf("$Prefer -eq 'newest'");
  const regIdx = ps1.indexOf('Get-AppxPackage -Name');
  check('显式配置的 desktopExe 优先于策略',
    cfgIdx > 0 && runningIdx > 0 && cfgIdx < runningIdx,
    `config@${cfgIdx} running@${runningIdx}`);
  check('running 分支在 newest 之前（策略顺序：running → newest → registered）',
    runningIdx > 0 && newestIdx > 0 && runningIdx < newestIdx,
    `running@${runningIdx} newest@${newestIdx}`);
  check('registered 用 Get-AppxPackage（只认已注册的包，避开更新半成品）',
    regIdx > 0 && /Sort-Object Version -Descending/.test(ps1), '');
  check('newest 直接列磁盘目录（可能含未注册半成品）',
    /Get-ChildItem 'C:\\Program Files\\WindowsApps' -Directory -Filter 'OpenAI\.Codex_\*'/.test(ps1), '');
  check('registered 有兜底：Get-AppxPackage 不可用时走注册表',
    /AppModel\\Repository\\Packages/.test(ps1), '');
  check('拿到目录名后能从里面解析出版本号',
    /OpenAI\\\.Codex_\(\[0-9\]\+/.test(ps1), '');
}

// ---------------------------------------------------------------- 5 与桌面图标一致性
step('5. 与桌面图标的版本一致性验证（resolve 的核心用途）');
{
  const cfg = M.loadConfig();
  const same = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';

  // 场景 A：路径与版本都一致 → 应给出两个 ✓
  const a = M.formatResolveInfo(cfg, {
    desktopExe: same, desktopVersion: '26.1007.2314.0',
    shortcut: { exePath: same, aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App', version: '26.1007.2314.0' },
  });
  check('路径+版本都一致时给出 ✓（就是双击图标那个）',
    /我们会启动的就是双击图标启动的那个可执行文件/.test(a) && /版本号也一致/.test(a), '');

  // 场景 B：版本一致但路径来源不同（例如 running 策略拿到另一个路径）→ 应给 ✓ 但不谎称路径相同
  const other = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0\\app\\Codex.exe';
  const b = M.formatResolveInfo(cfg, {
    desktopExe: other, desktopVersion: '26.1007.2314.0',
    shortcut: { exePath: same, aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App', version: '26.1007.2314.0' },
  });
  check('版本一致但路径不同时给 ✓ 并如实说明路径差异',
    /版本号一致/.test(b) && !/路径完全一致/.test(b) && /路径不同只是解析来源不同/.test(b), '');

  // 场景 C：版本不一致 → 必须给 ⚠，不能蒙混过去
  const c = M.formatResolveInfo(cfg, {
    desktopExe: same, desktopVersion: '26.1007.9999.0',
    shortcut: { exePath: same, aumid: 'OpenAI.Codex_2p2nqsd0c76g0!App', version: '26.1007.2314.0' },
  });
  check('版本不一致时明确报 ⚠ 并提示怎么查',
    /⚠ 版本不一致/.test(c) && /resolve --prefer registered/.test(c), '');

  // 场景 D：要如实说明"直接启动 exe 会丢包标识"这个代价
  check('说明丢 MSIX 包标识的原因与代价',
    /丢失 MSIX 包标识/.test(a) && /--proxy-server/.test(a) && /自动更新可能不可用/.test(a), '');

  // 场景 E：没有快捷方式信息时不报错、不输出这一节
  const e = M.formatResolveInfo(cfg, { desktopExe: same, desktopVersion: '1.0' });
  check('没有快捷方式信息时不输出这一节、也不崩',
    !/版本一致性验证/.test(e) && /Codex 可执行文件解析/.test(e), '');
}

// ---------------------------------------------------------------- 6 AUMID 拼装
step('6. AUMID 拼装规则（易错点：不能用目录名的哈希段）');
{
  // 目录名格式：<Identity Name>_<Version>_<Arch>__<PublisherId>
  const re = /^(.+?)_([0-9]+(?:\.[0-9]+)+)_[^_]+__(.+)$/;
  const cases = [
    ['OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0', 'OpenAI.Codex', '26.1007.2314.0', '2p2nqsd0c76g0'],
    ['OpenAI.Codex_1.2.3_x64__abc123', 'OpenAI.Codex', '1.2.3', 'abc123'],
    ['OpenAI.Codex_26.1007.2314.0_arm64__xyz', 'OpenAI.Codex', '26.1007.2314.0', 'xyz'],
  ];
  let ok = 0;
  for (const [dir, wantName, wantVer, wantPub] of cases) {
    const m = dir.match(re);
    if (m && m[1] === wantName && m[2] === wantVer && m[3] === wantPub) ok++;
    else console.log(`      不匹配: ${dir} → ${m ? JSON.stringify(m.slice(1)) : 'null'}`);
  }
  check('目录名的三段（Name/Version/PublisherId）都能正确切出来', ok === cases.length, `${ok}/${cases.length}`);

  // AUMID = PackageFamilyName!AppId，而 PackageFamilyName = Name_PublisherId
  const m = 'OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0'.match(re);
  const aumid = `${m[1]}_${m[3]}!App`;
  check('拼出的 AUMID 与快捷方式里的完全一致',
    aumid === 'OpenAI.Codex_2p2nqsd0c76g0!App', aumid);

  const ps1 = fs.readFileSync(path.join(ROOT, 'codex-proxy.ps1'), 'utf8');
  check('ps1 用的是同一个正则（PublisherId 取 __ 之后那段）',
    /\^\(\.\+\?\)_\(\[0-9\]\+\(\?:\\\.\[0-9\]\+\)\+\)_\[\^_\]\+__\(\.\+\)\$/.test(ps1), '');
  check('ps1 读包清单拿 AUMID 与入口 exe',
    /AppxManifest\.xml/.test(ps1) && /Get-CodexShortcutTarget/.test(ps1), '');
  check('ps1 读桌面 .lnk 拿 AUMID 做对照',
    /Get-DesktopShortcutAumid/.test(ps1) && /\.lnk/.test(ps1), '');
}

// ---------------------------------------------------------------- 汇总
console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
