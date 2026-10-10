#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  智慧树题库工具 · 统一入口
//
//  一个命令，可持续产出：抓取 → 校验 → 生成 Markdown / Word / PDF / Excel
//
//  常用：
//    node zhs.mjs doctor              环境与登录态自检（先跑这个）
//    node zhs.mjs all                 全流程：抓题 + 生成全部格式 + 自检
//    node zhs.mjs login               登录并固化会话（重启不丢）
//    node zhs.mjs fetch               只抓题
//    node zhs.mjs docs                只按现有数据重新生成文档
//    node zhs.mjs verify              校验产物是否完整
//    node zhs.mjs status              看一眼当前状态
//
//  细参：
//    node zhs.mjs fetch --course 国家安全教育     只抓某一门课
//    node zhs.mjs fetch --dry-run                 只发现课程，不抓题
//    node zhs.mjs all  --formats md,pdf           只产出指定格式
//    node zhs.mjs docs --out D:\题库              产物输出到别处
//
//  退出码：0 成功 / 1 出错 / 2 未登录 / 3 校验不通过
// ═══════════════════════════════════════════════════════════════════
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ACC from './src/accounts.mjs';
import { askLine, askSecret } from './src/prompt.mjs';

const ROOT = join(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), '.');
const EXPORT = join(ROOT, 'export');

// ---------- 输出小工具 ----------
const C = process.stdout.isTTY
  ? { r: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', c: '\x1b[36m' }
  : { r: '', b: '', d: '', g: '', y: '', red: '', c: '' };

const say = (m = '') => process.stdout.write(m + '\n');
const ok = (m) => say(`${C.g}✓${C.r} ${m}`);
const warn = (m) => say(`${C.y}!${C.r} ${m}`);
const bad = (m) => say(`${C.red}✗${C.r} ${m}`);
const info = (m) => say(`${C.d}${m}${C.r}`);
const head = (m) => say(`\n${C.b}${C.c}${m}${C.r}`);

// ---------- 参数解析 ----------
const ARGV = process.argv.slice(2);
const command = (ARGV[0] && !ARGV[0].startsWith('-')) ? ARGV[0] : 'help';
const flags = {};
for (let i = 0; i < ARGV.length; i++) {
  const a = ARGV[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = ARGV[i + 1];
  if (next === undefined || next.startsWith('--')) { flags[key] = true; }
  else { flags[key] = next; i++; }
}
const flag = (n, d = null) => (flags[n] === undefined ? d : flags[n]);
const has = (n) => flags[n] !== undefined && flags[n] !== false;

// 输出目录可重定向（--out）：所有产物写到该目录，读取仍以 export 为准
const OUTDIR = flag('out') ? resolve(flag('out')) : EXPORT;
if (OUTDIR !== EXPORT) mkdirSync(OUTDIR, { recursive: true });
const o = (name) => join(OUTDIR, name);

const FILES = {
  papers: join(EXPORT, 'papers.json'),
  courses: join(EXPORT, 'courses-resolved.json'),
  md: o('智慧树作业题库_打印版.md'),
  mdBare: o('智慧树作业题库.md'),
  docx: o('智慧树作业题库_打印版.docx'),
  pdf: o('智慧树作业题库_打印版.pdf'),
  html: o('智慧树作业题库_打印预览.html'),
  xlsx: o('智慧树课程数据.xlsx'),
  raw: join(EXPORT, 'raw.json'),
};

const PY = process.env.ZHS_PYTHON || (() => {
  const cand = [
    join(process.env.DSH_HOME || '', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'python',
  ];
  return cand.find((p) => p === 'python' || existsSync(p)) ?? 'python';
})();

const node = process.execPath;
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

// 浏览器运行时目录：统一在这里兜底，调用方不需要自己设环境变量
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(ROOT, 'ms-playwright');

// ---------- 打印数据概况 ----------
function summarize() {
  if (!existsSync(FILES.papers)) return null;
  let data;
  try { data = JSON.parse(readFileSync(FILES.papers, 'utf8')); } catch { return null; }
  const courses = Object.entries(data);
  const rows = [];
  let hw = 0, q = 0;
  for (const [name, items] of courses) {
    const cq = items.reduce((a, it) =>
      a + ((it.paper?.rt?.examBase?.workExamParts ?? []).flatMap((p) => p.questionDtos ?? []).length), 0);
    rows.push({ name, hw: items.length, q: cq });
    hw += items.length; q += cq;
  }
  return { rows, hw, q, courses: courses.length };
}

function readAccount() {
  const r = ACC.resolveAccount({ argv: ARGV });
  return r.complete ? { file: describeSource(r), ...r.acc } : null;
}

function describeSource(r) {
  const files = [...new Set(Object.values(r.source).filter((s) => s && s !== 'cli' && s !== 'env'))];
  const extra = Object.entries(r.source).filter(([, v]) => v === 'cli' || v === 'env').map(([k, v]) => `${k}:${v}`);
  return [...files, ...extra].join(' + ') || '(未知)';
}

function accountLabel() {
  const r = ACC.resolveAccount({ argv: ARGV });
  const { school, studentId, realName } = r.acc;
  if (realName && school) return `${realName}（${school}）`;
  if (school && studentId) return `${school} ${studentId}`;
  return school || studentId || '';
}

function accountNames() {
  const r = ACC.resolveAccount({ argv: ARGV });
  const a = r.acc;
  return {
    student: a.realName || '',
    school: a.school || '',
    studentId: a.studentId || '',
    label: accountLabel(),
    complete: r.complete,
  };
}

// ═════════════════ 命令实现 ═════════════════

function cmdHelp() {
  head('智慧树题库工具 · 统一入口');
  say('一个命令，可持续产出：抓取 → 校验 → 生成 Markdown / Word / PDF / Excel');
  say(`${C.d}接口文档见 docs/README.md（CLI / Node API / 数据契约 / 机器可读清单）${C.r}`);
  head('常用命令');
  const rows = [
    ['doctor', '环境与登录态自检（先跑这个）'],
    ['all', '全流程：抓题 + 生成全部格式 + 自检'],
    ['login', '登录并固化会话（浏览器重启不丢）'],
    ['fetch', '只抓题（不生成文档）'],
    ['docs', '只按现有数据重新生成文档'],
    ['verify', '校验产物：数据契约 + 文档完整性 + 产物清单'],
    ['status', '看一眼当前状态'],
  ];
  for (const [c, d] of rows) say(`  ${C.b}${c.padEnd(9)}${C.r} ${d}`);
  head('细参');
  say('  fetch --course 国家安全教育    只抓某一门课');
  say('  fetch --dry-run                只发现课程，不抓题');
  say('  fetch --browser firefox        指定浏览器（默认 Edge）');
  say('  docs  --formats md,pdf         只产出指定格式（md / md-bare / docx / pdf / xlsx）');
  say('  docs  --out D:\\题库            产物输出到别的目录');
  say('  login --restart-check          登录后顺带验证「关掉浏览器再开仍在线」');
  head('退出码');
  say('  0 成功　1 出错　2 未登录　3 校验不通过');
  say('');
  say(`${C.d}当前工作区 ${ROOT}${C.r}`);
}

function cmdStatus() {
  head('当前状态');
  const acc = readAccount();
  say(`工作区      ${ROOT}`);
  say(`凭据文件    ${acc ? `config\\${acc.file}（${accountLabel()}）` : `${C.red}未找到${C.r}`}`);

  const s = summarize();
  if (!s) {
    warn('还没有抓到题库数据（export\\papers.json 不存在）');
    say('下一步：node zhs.mjs all');
    return 0;
  }
  say(`题库数据    ${s.courses} 门课 · ${s.hw} 份作业 · ${s.q} 道题`);
  for (const r of s.rows) say(`            · ${r.name}　${r.hw} 份 / ${r.q} 题`);

  const when = (p) => (existsSync(p) ? statSync(p).mtime.toLocaleString('zh-CN') : '—');
  const kb = (p) => (existsSync(p) ? `${(statSync(p).size / 1024).toFixed(1)} KB` : '缺失');
  head('产物');
  const rows = [
    ['papers.json', FILES.papers], ['courses-resolved.json', FILES.courses],
    ['Markdown', FILES.md], ['纯 Markdown', FILES.mdBare],
    ['Word', FILES.docx], ['PDF', FILES.pdf], ['打印预览 HTML', FILES.html],
    ['Excel', FILES.xlsx],
  ];
  for (const [label, p] of rows) say(`  ${label.padEnd(18)} ${kb(p).padEnd(10)} ${when(p)}`);

  const stale = [FILES.md, FILES.docx, FILES.pdf, FILES.xlsx]
    .filter((p) => existsSync(p) && statSync(p).mtime < statSync(FILES.papers).mtime);
  if (stale.length) warn(`有 ${stale.length} 个产物比题库数据旧，建议重跑：node zhs.mjs docs`);
  return 0;
}

function cmdDoctor() {
  head('环境自检');
  let problems = 0;
  const line = (name, good, detail) => {
    say(`  ${good ? `${C.g}✓${C.r}` : `${C.red}✗${C.r}`} ${name.padEnd(22)} ${detail}`);
    if (!good) problems++;
  };

  line('Node', true, process.version);
  const pyOk = (() => {
    try { const r = spawnSync(PY, ['-c', 'import docx, openpyxl; print("ok")'], { encoding: 'utf8' }); return r.status === 0; } catch { return false; }
  })();
  line('Python + 文档库', pyOk, pyOk ? PY : `不可用（docx/openpyxl 缺失）：${PY}`);

  const pwOk = existsSync(join(ROOT, 'node_modules', 'playwright'));
  line('Playwright', pwOk, pwOk ? 'node_modules/playwright' : '未安装：npm install playwright');

  const browserDir = process.env.PLAYWRIGHT_BROWSERS_PATH || join(ROOT, 'ms-playwright');
  const bOk = existsSync(browserDir);
  line('浏览器运行时目录', bOk, bOk ? browserDir : `缺失：${browserDir}（Playwright Firefox 需要）`);

  const acc = readAccount();
  line('凭据文件', !!acc, acc ? `config\\${acc.file}` : '未找到 config\\account-live.json');

  const profDir = join(ROOT, 'browser-profile-edge');
  const profOk = existsSync(profDir);
  line('Edge 登录资料', profOk, profOk ? 'browser-profile-edge（会话已固化）' : '还没登录过：node zhs.mjs login');

  // 题库数据
  const s = summarize();
  line('题库数据', !!s, s ? `${s.courses} 门课 / ${s.hw} 份 / ${s.q} 题` : '暂无：node zhs.mjs all');

  say('');
  if (problems) warn(`发现 ${problems} 项问题，按上面提示处理。`);
  else ok('环境就绪。直接跑：node zhs.mjs all');
  return problems ? 1 : 0;
}

function cmdLogin() {
  head('登录并固化会话');
  const script = join(ROOT, 'recon', 'login-and-persist.mjs');
  if (!existsSync(script)) { bad('缺少 recon\\login-and-persist.mjs'); return 1; }

  // 凭据来源检查：命令行/环境变量/凭据库/指定文件
  const r = ACC.resolveAccount({ argv: ARGV });
  if (!r.complete) {
    bad(`凭据不完整，缺：${r.missing.join('、')}`);
    say('');
    say('可用这些方式提供（优先级从高到低）：');
    say('  1) 命令行： node zhs.mjs login --school 示例大学 --student-id 00000000000 --password "***"');
    say('  2) 环境变量： $env:ZHS_STUDENT_ID="..."; $env:ZHS_PASSWORD="..."');
    say('  3) 导入文件： node zhs.mjs import <任意来源.json>');
    say('  4) 交互录入： node zhs.mjs import --prompt');
    say('  5) 凭据库：   ' + ACC.STORE);
    if (r.problems.length) { say(''); for (const p of r.problems) warn(p); }
    return 1;
  }
  say(`凭据来源：${describeSource(r)}`);
  say(`  school=${r.acc.school}　studentId=${r.acc.studentId}　password=${ACC.mask(r.acc.password)}${r.acc.realName ? '　realName=' + r.acc.realName : ''}`);

  const args = [script];
  if (has('restart-check')) args.push('--restart-check');
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(ROOT, 'ms-playwright');
  const res = run(node, args);
  const code = res.status ?? 1;

  // 登录成功后回写「平台真值」到凭据库
  const stateFile = join(ROOT, 'session', 'storage-state.json');
  if (code === 0 && existsSync(stateFile)) {
    say('');
    say(`提示：可跑 node zhs.mjs whoami 把平台返回的真实姓名/学校写回凭据库`);
  }
  return code;
}

async function cmdImport() {
  head('导入个人信息');
  const prompt = has('prompt');
  const src = typeof flag('from') === 'string' ? flag('from')
    : (ARGV[1] && !ARGV[1].startsWith('--') ? ARGV[1] : null);
  const out = typeof flag('save-to') === 'string' ? resolve(flag('save-to')) : ACC.STORE;

  // 字段映射覆盖（把别人文件里的字段名指到标准字段）
  const fields = {};
  for (const [f, key] of [['school', 'school'], ['student-id', 'studentId'], ['real-name', 'realName'], ['password', 'password']]) {
    const v = flag(f);
    if (typeof v === 'string' && v) fields[key] = v;
  }

  if (prompt) {
    say('交互录入（密码不回显；姓名可留空）');
    const acc = {};
    acc.school = fields.school ?? await askLine('  学校名（例如 示例大学）: ');
    acc.studentId = fields.studentId ?? await askLine('  学号: ');
    acc.realName = fields.realName ?? await askLine('  姓名（可留空）: ');
    acc.password = fields.password ?? await askSecret('  密码: ');
    if (!acc.realName) delete acc.realName;
    if (!acc.school || !acc.studentId || !acc.password) { bad('三项必填（学校 / 学号 / 密码），已取消'); return 1; }
    const r = ACC.saveAccount(acc, { file: out });
    ok(`已写入 ${r.file}${r.secured ? '（权限已收紧）' : ''}`);
    say('  字段: ' + r.saved.join(', '));
    if (out === ACC.STORE) say('  之后直接跑：node zhs.mjs login');
    return 0;
  }

  if (!src) {
    bad('用法：node zhs.mjs import <文件.json> 或 node zhs.mjs import --prompt');
    say('');
    say('导入时会自动识别字段别名，例如下面这些都能直接用：');
    say(ACC.fieldHelp());
    return 1;
  }

  const res = ACC.importAccount(src, { file: out, fields });
  if (!res.ok) { bad(res.error); if (res.mapped) say('  已识别: ' + JSON.stringify(res.mapped)); return 1; }
  ok(`导入成功 → ${res.file}${res.secured ? '（权限已收紧）' : ''}`);
  if (Object.keys(res.mapped).length) say('  字段映射: ' + Object.entries(res.mapped).map(([k, v]) => `${v} → ${k}`).join('，'));
  if (res.unknown.length) warn('未识别字段（已忽略）: ' + res.unknown.slice(0, 8).join(', '));
  say('  写入字段: ' + res.saved.join(', '));
  return 0;
}

function cmdWhoami() {
  head('当前身份');
  const r = ACC.resolveAccount({ argv: ARGV });
  say('凭据来源：' + describeSource(r));
  for (const [k, label] of [['school', '学校'], ['studentId', '学号'], ['realName', '姓名'], ['password', '密码']]) {
    const v = k === 'password' ? ACC.mask(r.acc[k]) : (r.acc[k] ?? '(未设置)');
    say(`  ${label.padEnd(4)} ${v}   ${C.d}← ${r.source[k] ?? '—'}${C.r}`);
  }
  if (!r.complete) { warn('凭据不完整，缺：' + r.missing.join('、')); }

  say('');
  process.stdout.write('  查询平台真实身份… ');
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(ROOT, 'ms-playwright');
  const probe = spawnSync(node, [join(ROOT, 'src', 'session.mjs')], { cwd: ROOT, encoding: 'utf8' });
  let got = null;
  try { got = JSON.parse(probe.stdout || '{}'); } catch {}
  if (!got || !got.ok) {
    say(`${C.y}未登录或浏览器不可用${C.r}`);
    if (got?.reason) info('    ' + got.reason);
    say('    先跑：node zhs.mjs login');
    return got && got.ok === false && got.user ? 0 : 2;
  }
  ok(`已登录：${got.user?.realName}`);
  const user = got.user ?? {};
  say(`    姓名 ${user.realName ?? '—'}　uuid ${user.uuid ?? '—'}`);

  // 把平台真值写回凭据库
  const merged = { ...r.acc, realName: user.realName ?? r.acc.realName };
  const changed = merged.realName !== r.acc.realName;
  const saved = ACC.saveAccount(merged, { file: ACC.STORE });
  if (changed) ok(`已把真实姓名写回凭据库：realName = ${merged.realName}`);
  else info(`凭据库已是最新（${saved.file}）`);
  say(`    文档封面将显示：${merged.realName ? merged.realName + '（' + (merged.school || '') + '）' : accountLabel()}`);
  return 0;
}

function cmdFetch() {
  head('抓取题库');
  const script = join(ROOT, 'src', 'pipeline.mjs');
  if (!existsSync(script)) { bad('缺少 src\\pipeline.mjs'); return 1; }
  const args = [script];
  if (has('dry-run')) args.push('--dry-run');
  const course = flag('course');
  if (course) args.push('--course', course);
  if (flag('browser') === 'firefox') args.push('--browser', 'firefox');
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(ROOT, 'ms-playwright');
  // 文档生成交给 zhs.mjs docs 统一做，避免和 all 里的 docs 阶段重复生成
  process.env.ZHS_SKIP_DOCS = '1';
  const r = run(node, args);
  const code = r.status ?? 1;
  if (code === 2) { say(''); warn('未登录。先跑：node zhs.mjs login'); }
  return code;
}

function cmdDocs() {
  head('生成文档');
  if (!existsSync(FILES.papers)) { bad('缺少 export\\papers.json，先跑：node zhs.mjs fetch'); return 1; }
  const want = String(flag('formats', 'md,md-bare,docx,pdf,xlsx')).split(',').map((x) => x.trim()).filter(Boolean);
  const names = accountNames();
  const results = [];

  const step = (name, fn) => {
    process.stdout.write(`  ${name.padEnd(20)} `);
    try { const out = fn(); if (out === false) { say(`${C.red}失败${C.r}`); results.push([name, false]); } else { ok('完成'); results.push([name, true]); } }
    catch (e) { say(`${C.red}异常${C.r} ${String(e).slice(0, 80)}`); results.push([name, false]); }
  };

  if (want.includes('md')) step('Markdown（打印版）', () => {
    const args = [join(ROOT, 'recon', 'make-md.mjs'), '--out', FILES.md];
    if (names.school) args.push('--school', names.school);
    if (names.student) args.push('--student', names.student);
    const r = spawnSync(node, args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) process.stderr.write(r.stderr || '');
    return r.status === 0;
  });
  if (want.includes('md-bare')) step('Markdown（纯文本）', () => {
    const args = [join(ROOT, 'recon', 'make-md.mjs'), '--bare', '--out', FILES.mdBare];
    if (names.student) args.push('--student', names.student);
    if (names.school) args.push('--school', names.school);
    const r = spawnSync(node, args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) process.stderr.write(r.stderr || '');
    return r.status === 0;
  });
  if (want.includes('pdf')) step('PDF + 打印预览', () => {
    const r = spawnSync(node, [join(ROOT, 'recon', 'make-pdf.mjs'),
      '--src', FILES.md, '--html', FILES.html, '--out', FILES.pdf], { cwd: ROOT, encoding: 'utf8' });
    return r.status === 0 ? true : (process.stderr.write(r.stderr || ''), false);
  });
  if (want.includes('docx')) step('Word', () => {
    const r = spawnSync(PY, [join(EXPORT, 'make-docx.py'), '--out', FILES.docx, '--account', names.label], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) process.stderr.write((r.stderr || '') + (r.stdout || ''));
    return r.status === 0;
  });
  if (want.includes('xlsx')) step('Excel', () => {
    if (!existsSync(FILES.raw)) { process.stderr.write('缺少 export\\raw.json（课程数据），跳过\n'); return false; }
    const r = spawnSync(PY, [join(EXPORT, 'make-xlsx.py'), '--out', FILES.xlsx,
      '--account', names.label || names.studentId, '--school', names.school], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) process.stderr.write((r.stderr || '') + (r.stdout || ''));
    return r.status === 0;
  });

  const failed = results.filter(([, good]) => !good);
  say('');
  if (failed.length) { warn(`${failed.length} 项失败：${failed.map(([n]) => n).join('、')}`); return 1; }
  ok('文档已更新到 export\\');
  return 0;
}

function cmdVerify() {
  head('校验产物');
  if (!existsSync(FILES.papers)) { bad('缺少 export\\papers.json'); return 1; }
  if (!existsSync(FILES.md)) { bad('缺少 Markdown 产物，先跑：node zhs.mjs docs'); return 1; }

  // 1) 数据契约（结构 + 业务规则）
  const v = spawnSync(node, [join(ROOT, 'recon', 'validate-data.mjs'),
    '--papers', FILES.papers, '--courses', FILES.courses], { cwd: ROOT, encoding: 'utf8' });
  for (const l of ((v.stdout || '') + (v.stderr || '')).trim().split('\n')) say('  ' + l);
  const dataOk = v.status === 0;

  // 2) 文档完整性（逐题逐选项回查 Markdown）
  head('文档完整性');
  const r = spawnSync(node, [join(ROOT, 'recon', 'verify-md.mjs'),
    '--papers', FILES.papers, '--md', FILES.md], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const l of out.trim().split('\n')) say('  ' + l);
  const mdOk = /全部题目与选项均已收录/.test(out);

  // 3) 产物齐全性
  head('产物清单');
  const s = summarize();
  for (const [label, p] of [['Markdown', FILES.md], ['Word', FILES.docx], ['PDF', FILES.pdf], ['Excel', FILES.xlsx]]) {
    const ex = existsSync(p);
    say(`  ${ex ? `${C.g}✓${C.r}` : `${C.y}—${C.r}`} ${label.padEnd(12)} ${ex ? `${(statSync(p).size / 1024).toFixed(1)} KB` : '未生成'}`);
  }
  if (s) say(`\n  题库：${s.courses} 门课 · ${s.hw} 份作业 · ${s.q} 道题`);

  if (!dataOk) warn('数据契约未通过，详见上面「数据契约校验」');
  return dataOk && mdOk ? 0 : 3;
}

function cmdAll() {
  const fetchCode = cmdFetch();
  if (fetchCode !== 0 && fetchCode !== 1) return fetchCode;   // 2=未登录 等
  const docsCode = cmdDocs();
  const verifyCode = cmdVerify();
  head('完成');
  say('  node zhs.mjs status     查看状态');
  return verifyCode || docsCode || 0;
}

// ═════════════════ 分发 ═════════════════
const COMMANDS = {
  help: cmdHelp, '--help': cmdHelp, '-h': cmdHelp,
  status: cmdStatus,
  doctor: cmdDoctor,
  login: cmdLogin,
  fetch: cmdFetch,
  docs: cmdDocs,
  verify: cmdVerify,
  all: cmdAll,
  whoami: cmdWhoami,
  import: cmdImport,
};

const fn = COMMANDS[command];
if (!fn) {
  bad(`未知命令：${command}`);
  say('可用：' + Object.keys(COMMANDS).filter((k) => !k.startsWith('-')).join(' | '));
  process.exit(1);
}
// 命令可以是同步或异步（import --prompt 需要 await）
const result = await fn();
process.exit(typeof result === 'number' ? result : 0);

