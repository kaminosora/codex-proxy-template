// tests/_helpers.mjs — 测试脚本共用的路径解析
//
// Clash Party 的文件结构（实测）：
//   %APPDATA%\mihomo-party\profile.yaml        订阅【索引】：current + items[].id/url，**不含节点**
//   %APPDATA%\mihomo-party\profiles\<id>.yaml  真正的节点配置（由 profile.yaml 的 current 指向）
//   %APPDATA%\mihomo-party\mihomo.yaml         Clash Party 的运行配置（可能含节点）
//
// 所以想拿节点，必须顺着 profile.yaml 的 `current` 去找 profiles\<current>.yaml，
// 直接读 profile.yaml 会得到 0 个节点（这是踩过的坑）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CLASH_DIR = path.join(process.env.APPDATA || '', 'mihomo-party');

/** 解析出当前生效的订阅文件路径，找不到返回 null */
export function resolveProfileFile(explicit = null) {
  if (explicit && fs.existsSync(explicit)) return explicit;

  const indexPath = path.join(CLASH_DIR, 'profile.yaml');
  if (fs.existsSync(indexPath)) {
    try {
      const text = fs.readFileSync(indexPath, 'utf8');
      // current: <id>   （极简解析，避免为此引入 yaml 依赖）
      const m = text.match(/^current:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/m);
      if (m) {
        const p = path.join(CLASH_DIR, 'profiles', `${m[1]}.yaml`);
        if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
      }
      // current 没写或文件为空：挑 profiles 下最大的一个（最可能是有内容的订阅）
      const dir = path.join(CLASH_DIR, 'profiles');
      if (fs.existsSync(dir)) {
        const best = fs.readdirSync(dir)
          .map((n) => ({ n, p: path.join(dir, n), s: (() => { try { return fs.statSync(path.join(dir, n)).size; } catch { return 0; } })() }))
          .filter((x) => x.n.endsWith('.yaml') && x.s > 1024)
          .sort((a, b) => b.s - a.s)[0];
        if (best) return best.p;
      }
    } catch { /* 往下兜底 */ }
  }

  const runtime = path.join(CLASH_DIR, 'mihomo.yaml');
  if (fs.existsSync(runtime) && fs.statSync(runtime).size > 0) return runtime;

  return null;
}

/**
 * 找 mihomo 内核可执行文件。
 *
 * ⚠️ **这份函数找的是"Clash Party 自带的内核"，不是我们生产用的那个。**
 *   我们生产（回落出口 / node-test）用的是 `bin\codex-core.exe` —— mihomo 的【改名副本】，
 *   目的是避开 Clash Party 启动时的"高权限内核检测"（它纯按进程名匹配
 *   `mihomo.exe` / `mihomo-alpha.exe` / `mihomo-smart.exe`，一旦命中就弹窗要求提权，
 *   **点取消它会直接退出**）。
 *
 *   所以**测试不要用这个函数去起实例** —— 那会：
 *     ① 起一堆 `mihomo.exe`，正好撞上那个检测（04 号会起 8 个实例，风险最集中）
 *     ② 测的不是生产路径（生产用的是改名副本）
 *   正确做法是拿生产的选择结果：
 *
 *     const M = await import(pathToFileURL(path.join(ROOT, 'codex-proxy.mjs')).href);
 *     const exe = new M.ClashPartyUplink(M.loadConfig().uplinks.clashParty).coreExe();
 *
 *   本函数保留，只用于"报告参照信息"（比如日志里说明 Clash Party 自带哪个版本的内核）。
 */
export function findMihomo() {
  const candidates = ['mihomo.exe', 'mihomo', 'clash-meta.exe', 'clash.exe', 'verge-mihomo.exe'];
  const tries = [];
  for (const c of candidates) {
    tries.push(path.join(CLASH_DIR, c), path.join(CLASH_DIR, 'sidecar', c));
  }
  tries.push('D:\\Program Files\\Mihomo Party\\Clash Party\\resources\\sidecar\\mihomo.exe');
  for (const c of candidates) {
    for (const base of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) tries.push(path.join(base, 'Mihomo Party', 'Clash Party', 'resources', 'sidecar', c));
    }
  }
  for (const t of tries) { try { if (t && fs.existsSync(t)) return t; } catch {} }
  return null;
}

/**
 * 取【生产实际会用】的内核路径（优先 `bin\codex-core.exe` 改名副本）。
 * 测试起实例时一律用这个，不要用 findMihomo()。
 *
 * @param {string} root 项目根目录
 */
export async function productionCoreExe(root) {
  const M = await import(pathToFileURL(path.join(root, 'codex-proxy.mjs')).href);
  const up = new M.ClashPartyUplink(M.loadConfig().uplinks.clashParty);
  return up.coreExe();
}

/** 判断名字是否像日本节点 */
export const JP_RE = /日本|JP|Japan|Tokyo|东京|大阪|Osaka|Nagoya|名古屋/i;
