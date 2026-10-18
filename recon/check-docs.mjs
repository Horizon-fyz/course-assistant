// 检查文档与代码是否一致，防止文档漂移
//
// 用法：node recon\check-docs.mjs     （退出码 0 一致 / 1 有漂移）
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const problems = [];
const notes = [];

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const tools = JSON.parse(read('docs/tools.json'));
const cliDoc = read('docs/API-cli.md');
const nodeDoc = read('docs/API-node.md');
const dataDoc = read('docs/DATA-CONTRACT.md');
const zhs = read('zhs.mjs');

// ---------- 1) tools.json 里的命令都必须真的实现，且出现在 CLI 文档里 ----------
const implemented = new Set(Object.keys(
  Object.fromEntries([...zhs.matchAll(/^\s{2}([a-z][a-z-]*):\s*cmd/gm)].map((m) => [m[1], 1])),
));
for (const c of tools.commands) {
  const name = c.name;
  if (!implemented.has(name) && !['help', '--help', '-h'].includes(name)) {
    if (!implemented.has(name)) problems.push(`tools.json 声明了命令 "${name}"，但 zhs.mjs 未实现`);
  }
  if (!cliDoc.includes(`node zhs.mjs ${name}`) && name !== 'help') {
    problems.push(`命令 "${name}" 未出现在 docs/API-cli.md 中`);
  }
}
// 反向：代码里有但文档没写
for (const name of implemented) {
  if (!tools.commands.some((c) => c.name === name)) {
    problems.push(`zhs.mjs 实现了命令 "${name}"，但 tools.json 未登记`);
  }
}
notes.push(`命令：代码实现 ${implemented.size} 个，tools.json 登记 ${tools.commands.length} 个`);

// ---------- 2) tools.json 声明的产物路径必须存在（或标注为需先生成） ----------
for (const [p, meta] of Object.entries(tools.artifacts)) {
  const abs = join(ROOT, p);
  if (!existsSync(abs)) {
    // 只有 fetch 产物缺失可以接受（还没抓过）
    if (meta.producedBy === 'fetch') notes.push(`产物待生成（正常）：${p}`);
    else problems.push(`tools.json 声明的产物不存在：${p}`);
  }
  if (!dataDoc.includes(p.split('/').pop())) {
    notes.push(`产物 ${p} 未在 DATA-CONTRACT.md 中详述`);
  }
}

// ---------- 3) API-node.md 里写的每个导出都必须真实存在 ----------
const exportChecks = [
  ['src/core/browser.mjs', ['HOME', 'findChromium', 'cdpAlive', 'findLiveCdp', 'ensureChromium', 'connect', 'findPage', 'readyPage', 'tidy', 'focusWindow', 'waitContent']],
  ['src/core/login-flow.mjs', ['LOGIN_URL', 'API_USERINFO', 'loadAccount', 'checkLogin', 'captchaVisible', 'fillLoginForm', 'ensureLoggedIn']],
  ['src/flows/session.mjs', ['ensureSession']],
  ['src/core/python.mjs', ['PY']],
];

// 允许在「其他模块」章节里集中记录、不必逐个展开的导出
const NODE_DOC_OPTIONAL = new Set(['askLine', 'askSecret', 'STORE', 'LEGACY', 'FIELD_ALIASES']);
for (const [file, names] of [
  ['src/core/accounts.mjs', ['resolveAccount', 'normalizeAccount', 'saveAccount', 'importAccount', 'exportAccount', 'mask', 'fieldHelp', 'harden', 'STORE', 'LEGACY', 'FIELD_ALIASES']],
  ['src/core/prompt.mjs', ['askLine', 'askSecret']],
]) {
  if (!existsSync(join(ROOT, file))) { problems.push(`模块不存在：${file}`); continue; }
  const src = read(file);
  for (const n of names) {
    const re = new RegExp(`export\\s+(async\\s+)?(function|const|class)\\s+${n}\\b`);
    if (!re.test(src)) problems.push(`${file} 未导出 ${n}，但 check-docs 期望它存在`);
  }
  if (!nodeDoc.includes(file) && !dataDoc.includes(file)) {
    notes.push(`模块 ${file} 未被 API-node.md / DATA-CONTRACT.md 提及`);
  }
}

for (const [file, names] of exportChecks) {
  if (!existsSync(join(ROOT, file))) { problems.push(`模块不存在：${file}`); continue; }
  const src = read(file);
  for (const n of names) {
    const re = new RegExp(`export\\s+(async\\s+)?(function|const|class)\\s+${n}\\b`);
    if (!re.test(src)) problems.push(`${file} 未导出 ${n}，但 docs/API-node.md 写了它`);
    if (!nodeDoc.includes(n)) problems.push(`${file} 导出了 ${n}，但 docs/API-node.md 没有记录`);
  }
}

// ---------- 4) Schema 文件必须存在且可解析 ----------
for (const s of ['docs/schemas/papers.schema.json', 'docs/schemas/courses-resolved.schema.json']) {
  if (!existsSync(join(ROOT, s))) { problems.push(`缺少 Schema：${s}`); continue; }
  try { JSON.parse(read(s)); } catch (e) { problems.push(`Schema 解析失败 ${s}: ${String(e).slice(0, 80)}`); }
}

// ---------- 5) 文档里提到的校验入口必须存在 ----------
for (const script of ['recon/validate-data.mjs', 'recon/verify-md.mjs']) {
  if (!existsSync(join(ROOT, script))) problems.push(`文档提到的脚本不存在：${script}`);
  const base = script.split('/').pop();
  const mentioned = cliDoc.includes(base) || nodeDoc.includes(base) || dataDoc.includes(base);
  if (!mentioned) notes.push(`脚本 ${script} 未被任何文档提及`);
}

// ---------- 6) 退出码一致性 ----------
const exitCodes = Object.keys(tools.exitCodes).sort().join(',');
if (!cliDoc.includes('`0` 成功') || !cliDoc.includes('`3`')) {
  problems.push('docs/API-cli.md 未完整记录退出码');
}
notes.push(`退出码：${exitCodes}`);

// ---------- 输出 ----------
const C = process.stdout.isTTY
  ? { r: '\x1b[0m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', d: '\x1b[2m' }
  : { r: '', b: '', g: '', y: '', red: '', d: '' };

console.log(`${C.b}文档一致性检查${C.r}`);
for (const n of notes) console.log(`  ${C.d}·${C.r} ${n}`);
console.log('');
if (problems.length) {
  console.log(`${C.red}发现 ${problems.length} 处漂移：${C.r}`);
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log(`${C.g}✓ 文档与代码一致${C.r}`);
process.exit(0);
