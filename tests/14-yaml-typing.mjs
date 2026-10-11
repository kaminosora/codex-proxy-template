// tests/14-yaml-typing.mjs — 订阅解析与 YAML 输出的类型正确性
//
// 背景（都是实测踩过的坑）：
//   1) Clash Party 的订阅用【流式】写法 `- { name: '…', type: ss, … }`。
//      早期解析器只认块式，把每行当成"只有一个键"丢弃 → 55 个节点全变空对象 →
//      "回落出口没有可用节点"，而文件里明明有 55 个。
//   2) 解析出来的值虽然都是字符串，但 YAML 有类型：
//        udp: 'true'       → mihomo: expected type 'bool', got unconvertible type 'string'
//        ech-opts: '{…}'   → mihomo: expected a map, got 'string'
//      一律加引号会让内核直接启动失败（node-test / 回落出口都用不了）。
//   3) 节点名里有冒号和逗号（`'官网: www.雨燕云.com'`），
//      按第一个冒号切分、按顶层逗号切分才不会切坏。
//
// 用法： node tests/14-yaml-typing.mjs
// 预期： 12/12 通过
import path from 'node:path';
import fs from 'node:fs';
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

console.log('=== 14 订阅解析与 YAML 输出类型 ===\n');

// ---------------------------------------------------------------- 1 流式解析
step('1. 流式（flow-style）节点必须能解析出来');
{
  const yaml = [
    'proxies:',
    "  - { name: '官网: www.雨燕云.com', type: ss, server: 1.1.1.1, port: 10001, cipher: chacha20-ietf-poly1305 }",
    "  - { name: '🇯🇵 日本1|BGP优化', type: anytls, server: jp1.example.vin, port: 10017, password: abc, udp: true }",
    'rules:',
    '  - MATCH,DIRECT',
    '',
  ].join('\n');
  const nodes = M.parseProfileProxies(yaml);
  check('解析出 2 个节点（不是 2 个空对象）', nodes.length === 2, `得到 ${nodes.length} 个`);
  check('第 1 个节点有 name/type/server/port',
    nodes[0]?.name && nodes[0]?.type === 'ss' && nodes[0]?.server === '1.1.1.1' && nodes[0]?.port === 10001,
    JSON.stringify(nodes[0]));
  check('节点名里的冒号和逗号没被切坏',
    nodes[0]?.name === '官网: www.雨燕云.com', `name=${JSON.stringify(nodes[0]?.name)}`);
  check('port 解析成 number（mihomo 要求数字）', typeof nodes[0]?.port === 'number', typeof nodes[0]?.port);
  check('proxies 段之后的内容不会被当节点',
    nodes.length === 2 && !nodes.some((n) => n.name === 'MATCH'), '');
}

// ---------------------------------------------------------------- 2 块式仍要支持
step('2. 块式（block-style）也要继续支持');
{
  const yaml = [
    'proxies:',
    '  - name: 香港A',
    '    type: ss',
    '    server: hk.example.com',
    '    port: 11001',
    '  - name: 日本A',
    '    type: vmess',
    '    server: jp.example.com',
    '    port: 11002',
    'rules:',
    '  - MATCH,DIRECT',
    '',
  ].join('\n');
  const nodes = M.parseProfileProxies(yaml);
  check('块式解析出 2 个节点', nodes.length === 2, `得到 ${nodes.length} 个`);
  check('块式字段正确', nodes[0]?.server === 'hk.example.com' && nodes[1]?.port === 11002,
    JSON.stringify(nodes.map((n) => [n.name, n.server, n.port])));
}

// ---------------------------------------------------------------- 3 YAML 类型
step('3. yamlScalar 必须按类型输出（布尔/数字/嵌套 map 不能加引号）');
{
  check('true → 裸 true', M.yamlScalar('true') === 'true', M.yamlScalar('true'));
  check('false → 裸 false', M.yamlScalar('false') === 'false', M.yamlScalar('false'));
  check('布尔值 → 裸 true', M.yamlScalar(true) === 'true', M.yamlScalar(true));
  check('10017 → 裸数字', M.yamlScalar('10017') === '10017', M.yamlScalar('10017'));
  check('流式 map → 原样输出（不加引号）',
    M.yamlScalar('{ enable: true, config: AEz+ }') === '{ enable: true, config: AEz+ }',
    M.yamlScalar('{ enable: true, config: AEz+ }'));
  check('含冒号的字符串仍要加引号（如节点名 官网: www.x.com）',
    M.yamlScalar('官网: www.x.com') === '"官网: www.x.com"', M.yamlScalar('官网: www.x.com'));
  // 注意：仅"内部含空格"【不需要】引号 —— YAML 明文标量允许内部空格。
  // （但含 `|` `:` `#` 等指示符的仍要引号，所以像 `🇯🇵 日本1|BGP优化` 会被加引号，这是对的。）
  check('内部含空格的普通字符串不加引号（明文标量本就允许）',
    M.yamlScalar('日本 东京 节点') === '日本 东京 节点', M.yamlScalar('日本 东京 节点'));
  check('含 | 的必须加引号（YAML 里 | 是块标量指示符）',
    M.yamlScalar('🇯🇵 日本1|BGP优化') === '"🇯🇵 日本1|BGP优化"', M.yamlScalar('🇯🇵 日本1|BGP优化'));
  check('首尾有空白的才加引号（否则会被 YAML 吃掉）',
    M.yamlScalar(' a b ') === '" a b "', M.yamlScalar(' a b '));
  check('看起来像 null 字面量的要加引号',
    M.yamlScalar('null') === '"null"', M.yamlScalar('null'));
  check('空串要加引号', M.yamlScalar('') === '""', M.yamlScalar(''));
}

// ---------------------------------------------------------------- 4 嵌套不被切碎
step('4. 嵌套的流式 map 不能被逗号切碎');
{
  const yaml = [
    'proxies:',
    "  - { name: JP1, type: anytls, server: jp1.x, port: 10017, udp: true, ech-opts: { enable: true, config: AEz+DQBI } }",
    '',
  ].join('\n');
  const nodes = M.parseProfileProxies(yaml);
  check('ech-opts 被完整保留为一个 map（不是被切碎）',
    nodes[0]?.['ech-opts'] === '{ enable: true, config: AEz+DQBI }',
    JSON.stringify(nodes[0]?.['ech-opts']));
  check('udp 保留原值', nodes[0]?.udp === 'true', JSON.stringify(nodes[0]?.udp));

  // 生成的配置片段里，udp 必须是裸 true、ech-opts 必须是裸 map
  const frag = Object.entries(nodes[0]).filter(([k]) => k !== 'name')
    .map(([k, v]) => `${k}: ${M.yamlScalar(v)}`).join(', ');
  check('生成片段里 udp: true（无引号）', /(^|, )udp: true($|, )/.test(frag), frag.slice(0, 120));
  check('生成片段里 ech-opts: {…}（无引号）', /ech-opts: \{ enable: true/.test(frag), '');
}

// ---------------------------------------------------------------- 汇总
console.log('\n=== 汇总 ===');
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
for (const r of results.filter((x) => !x.ok)) console.log(`  未通过: ${r.name} — ${r.detail}`);
process.exit(pass === results.length ? 0 : 1);
