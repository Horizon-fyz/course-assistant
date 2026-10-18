#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  智慧树题库工具 · 统一入口
//
//  一个命令，可持续产出：抓取 → 校验 → 生成 Markdown / Word / PDF / Excel
//
//  常用：
//    node zhs.mjs doctor              环境与登录态自检（先跑这个）
//    node zhs.mjs all                 全流程：抓题 + 生成全部格式 + 自检 + AI 作答
//    node zhs.mjs answer              全自动作业答题（自动提交）
//    node zhs.mjs patrol              巡检作业：新作业 / 临近截止 / 状态变化 + 通知
//    node zhs.mjs deadline            作业截止看板（生成本地 HTML）
//    node zhs.mjs schedule            查看定时巡检计划任务
//    node zhs.mjs catalog             扫描课程目录（章节 / 课节 / 完成状态）并选择某节自动看
//    node zhs.mjs watch               全自动看课（1.5x + 自动弹题）
//    node zhs.mjs auto                全自动：先答题再看课
//    node zhs.mjs login               登录并固化会话（重启不丢）
//    node zhs.mjs fetch               只抓题
//    node zhs.mjs docs                只按现有数据重新生成文档
//    node zhs.mjs solve               识别题库 + 调用 AI 作答 + 输出答案
//    node zhs.mjs verify              校验产物是否完整
//    node zhs.mjs status              看一眼当前状态
//
//  细参：
//    node zhs.mjs fetch --course 国家安全教育     只抓某一门课
//    node zhs.mjs fetch --dry-run                 只发现课程，不抓题
//    node zhs.mjs all  --formats md,pdf           只产出指定格式
//    node zhs.mjs docs --out D:\题库              产物输出到别处
//    node zhs.mjs patrol --within 24              24 小时内截止的作业重点提醒
//    node zhs.mjs patrol --offline                不开浏览器，只按本地数据巡检
//    node zhs.mjs deadline --open                 生成截止看板并直接用浏览器打开
//    node zhs.mjs schedule install --time 08:00   每天 08:00 自动巡检
//    node zhs.mjs catalog --watch 1.3             扫描目录并自动完成 1.3 节
//
//  退出码：0 成功 / 1 出错 / 2 未登录 / 3 校验不通过
// ═══════════════════════════════════════════════════════════════════
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ACC from './src/core/accounts.mjs';
import { askLine, askSecret } from './src/core/prompt.mjs';
import { DATA_DIR } from './src/core/store.mjs';

const ROOT = join(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), '.');
const EXPORT = DATA_DIR;

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
const outFlag = flag('out');
const OUTDIR = typeof outFlag === 'string' ? resolve(outFlag) : EXPORT;
mkdirSync(OUTDIR, { recursive: true });
const o = (name) => join(OUTDIR, name);

const FILES = {
  papers: join(EXPORT, 'papers.json'),
  courses: join(EXPORT, 'courses-resolved.json'),
  md: o('智慧树作业题库_打印版.md'),
  mdBare: o('智慧树作业题库.md'),
  docx: o('智慧树作业题库_打印版.docx'),
  pdf: o('智慧树作业题库_打印版.pdf'),
  html: o('智慧树作业题库_打印预览.html'),
  board: join(EXPORT, 'deadline-board.html'),
  xlsx: o('智慧树课程数据.xlsx'),
  answers: o('智慧树作业题库_打印版.answers.md'),
  answered: o('智慧树作业题库_打印版.answered.md'),
  raw: join(EXPORT, 'raw.json'),
};

const PY = process.env.ZHS_PYTHON || (() => {
  const cand = [];
  if (process.env.DSH_HOME) {
    cand.push(join(process.env.DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'));
  }
  cand.push('python');
  return cand.find((p) => p === 'python' || existsSync(p)) ?? 'python';
})();

// 解题组件（md-ai-answer）：作为独立进程被 solve 调用，二者通过题库 MD 交接
const MDAI_DIR = join(ROOT, 'md-ai-answer');
const MDAI_CLI = join(MDAI_DIR, 'src', 'cli.mjs');

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
  const { school, studentId, realName } = r.acc;
  const label = realName && school ? `${realName}（${school}）` : (school && studentId ? `${school} ${studentId}` : (school || studentId || ''));
  return {
    student: realName || '',
    school: school || '',
    studentId: studentId || '',
    label,
    complete: r.complete,
  };
}

// ═════════════════ 命令实现 ═════════════════

function cmdHelp() {
  head('智慧树题库工具 · 统一入口');
  say('一个命令，可持续产出：抓取 → 校验 → 生成 Markdown / Word / PDF / Excel → AI 作答');
  say(`${C.d}接口文档见 docs/README.md（CLI / Node API / 数据契约 / 机器可读清单）${C.r}`);
  head('常用命令');
  const rows = [
    ['doctor', '环境与登录态自检（先跑这个）'],
    ['all', '全流程：抓题 + 生成全部格式 + 自检 + AI 作答'],
    ['login', '登录并固化会话（浏览器重启不丢）'],
    ['fetch', '只抓题（不生成文档）'],
    ['docs', '只按现有数据重新生成文档'],
    ['solve', '只作答：识别题库 → 调用 AI → 输出答案'],
    ['answer', '全自动作业：进入每份未提交作业 → 作答 → 提交'],
    ['patrol', '巡检作业：新作业 / 临近截止 / 状态变化 + 通知'],
    ['deadline', '截止看板：按紧急程度生成可离线打开的 HTML'],
    ['schedule', '定时巡检：安装 / 移除 / 查看 Windows 计划任务'],
    ['catalog', '课程目录：章节 / 课节 / 时长 / 完成状态，可选某节自动看'],
    ['watch', '全自动看课：真实播放 + 1.5x + 自动弹题'],
    ['auto', '全自动：先答题，再看课'],
    ['verify', '校验产物：数据契约 + 文档完整性 + 产物清单'],
    ['status', '看一眼当前状态'],
  ];
  for (const [c, d] of rows) say(`  ${C.b}${c.padEnd(9)}${C.r} ${d}`);
  head('细参');
  say('  fetch --course 国家安全教育    只抓某一门课');
  say('  fetch --dry-run                只发现课程，不抓题');
  say('  fetch --browser firefox        指定浏览器（默认自动检测本机已装的那个）');
  say('  docs  --formats md,pdf         只产出指定格式（md / md-bare / docx / pdf / xlsx）');
  say('  docs  --out D:\\题库            产物输出到别的目录');
  say('  solve --mock                   离线试跑作答（不调用 AI）');
  say('  solve --limit 20 --model X     只作答前 20 题 / 临时换模型');
  say('  login --restart-check          登录后顺带验证「关掉浏览器再开仍在线」');
  say('  answer --course 国家安全教育    只做某一门课的作业');
  say('  answer --limit 3 --no-submit   只做 3 份 / 只作答不提交');
  say('  answer --cross-check            AI 答案问两次交叉验证，存疑题不提交');
  say('  answer --min-confidence 0.8    交叉验证的置信度门槛（默认 0.7）');
  say('  patrol --within 24             24 小时内截止的作业重点提醒（默认 48）');
  say('  patrol --offline --no-notify   不开浏览器、只出报告');
  say('  patrol --webhook <url>         额外推送到飞书 / 企微 / 钉钉');
  say('  deadline                       生成 export\\deadline-board.html');
  say('  deadline --open                生成后直接用默认浏览器打开');
  say('  deadline --course 国家安全      只看某一门课');
  say('  schedule install --time 08:00  每天 08:00 自动巡检');
  say('  schedule remove                删除定时巡检任务');
  say('  catalog                        扫描课程目录，并按提示选择要自动完成的课节');
  say('  catalog --watch 1.3            扫描后直接自动完成编号 1.3 的课节');
  say('  catalog --course 国家安全      只扫描某一门课');
  say('  catalog --json                 只输出目录 JSON（保存到 export\\course-catalog.json）');
  say('  watch  --rate 1.25             看课倍速（默认 1.5，平台上限 1.5）');
  say('  watch  --minutes 120           最多跑 120 分钟');
  say('  auto   --dry                   只演练，不动页面');
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
    ['截止看板', FILES.board],
    ['Excel', FILES.xlsx],
    ['答案汇总（AI）', FILES.answers], ['答案回填版（AI）', FILES.answered],
  ];
  for (const [label, p] of rows) say(`  ${label.padEnd(18)} ${kb(p).padEnd(10)} ${when(p)}`);

  const stale = [FILES.md, FILES.docx, FILES.pdf, FILES.xlsx]
    .filter((p) => existsSync(p) && statSync(p).mtime < statSync(FILES.papers).mtime);
  if (stale.length) warn(`有 ${stale.length} 个产物比题库数据旧，建议重跑：node zhs.mjs docs`);
  return 0;
}

async function cmdDoctor() {
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

  // 现场探测这台电脑实际装了什么浏览器（不依赖预设清单，换台电脑结果自然不同）
  try {
    const { listAvailableBrowsers } = await import('./src/core/browser.mjs');
    const found = listAvailableBrowsers();
    const SRC = {
      'path-hint': '常见路径', registry: '注册表', PATH: 'PATH',
      playwright: 'Playwright', firefox: '系统安装', explicit: '手动指定',
    };
    line('可用浏览器', found.length > 0,
      found.length
        ? found.map((b) => `${b.name}（${SRC[b.source] || b.source}）`).join(' / ')
        : '未检测到：装 Edge / Chrome / Firefox 任一即可，或运行 npx playwright install chromium');
  } catch (e) {
    line('可用浏览器', false, '探测失败：' + String(e.message || e).slice(0, 80));
  }

  const acc = readAccount();
  line('凭据文件', !!acc, acc ? `config\\${acc.file}` : '未找到 config\\account-live.json');

  // 浏览器 profile 不写死品牌：本机用哪个浏览器，就检查哪个目录
  let profiles = [];
  try {
    profiles = readdirSync(ROOT)
      .filter((n) => n.startsWith('browser-profile'))
      .filter((n) => { try { return readdirSync(join(ROOT, n)).length > 0; } catch { return false; } });
  } catch { /* ignore */ }
  line('浏览器登录资料', profiles.length > 0,
    profiles.length ? `${profiles.join(' / ')}（会话已固化）` : '还没登录过：node zhs.mjs login');

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
  // 浏览器可插拔：与 fetch 保持一致
  if (flag('browser') === 'firefox') args.push('--browser', 'firefox');
  for (const k of ['browser-exe', 'firefox-profile']) {
    const v = flag(k);
    if (typeof v === 'string' && v) args.push('--' + k, v);
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(ROOT, 'ms-playwright');
  // 把解析后的凭据注入子进程，命令行里传的密码不会丢失
  const childEnv = { ...process.env };
  for (const [envKey, key] of [['ZHS_SCHOOL', 'school'], ['ZHS_STUDENT_ID', 'studentId'], ['ZHS_PASSWORD', 'password'], ['ZHS_REAL_NAME', 'realName']]) {
    if (r.acc[key]) childEnv[envKey] = r.acc[key];
    else delete childEnv[envKey];
  }
  const res = run(node, args, { env: childEnv });
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
  const probeEnv = { ...process.env };
  probeEnv.ZHS_BROWSER = flag('browser') === 'firefox' ? 'firefox' : 'chromium';
  for (const [envKey, key] of [['ZHS_BROWSER_EXE', 'browser-exe'], ['ZHS_FIREFOX_PROFILE', 'firefox-profile']]) {
    const v = flag(key);
    if (typeof v === 'string' && v) probeEnv[envKey] = v;
    else delete probeEnv[envKey];
  }
  const probe = spawnSync(node, [join(ROOT, 'src', 'flows', 'session.mjs')], { cwd: ROOT, encoding: 'utf8', env: probeEnv });
  let got = null;
  try { got = JSON.parse(probe.stdout || '{}'); } catch {}
  if (!got || !got.ok) {
    say(`${C.y}未登录或浏览器不可用${C.r}`);
    if (got?.reason) info('    ' + got.reason);
    say('    先跑：node zhs.mjs login');
    return 2;
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
  const script = join(ROOT, 'src', 'flows', 'pipeline.mjs');
  if (!existsSync(script)) { bad('缺少 src\\flows\\pipeline.mjs'); return 1; }
  const args = [script];
  if (has('dry-run')) args.push('--dry-run');
  const course = flag('course');
  if (course) args.push('--course', course);
  if (flag('browser') === 'firefox') args.push('--browser', 'firefox');
  // 任意浏览器：直接指定可执行文件（Chromium 系走 CDP，Firefox 走 BiDi）
  for (const k of ['browser-exe', 'firefox-profile', 'firefox-port']) {
    const v = flag(k);
    if (typeof v === 'string' && v) args.push('--' + k, v);
  }
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
  const KNOWN = new Set(['md', 'md-bare', 'docx', 'pdf', 'xlsx']);
  const want = [...new Set(String(flag('formats', 'md,md-bare,docx,pdf,xlsx'))
    .split(',').map((x) => x.trim()).filter(Boolean))];
  const unknown = want.filter((x) => !KNOWN.has(x));
  if (unknown.length) warn('忽略未知格式：' + unknown.join('、'));
  const formats = want.filter((x) => KNOWN.has(x));
  if (!formats.length) { bad('没有可生成的格式（可选：md / md-bare / docx / pdf / xlsx）'); return 1; }
  const names = accountNames();
  const results = [];

  const step = (name, fn) => {
    process.stdout.write(`  ${name.padEnd(20)} `);
    try { const out = fn(); if (out === false) { say(`${C.red}失败${C.r}`); results.push([name, false]); } else { ok('完成'); results.push([name, true]); } }
    catch (e) { say(`${C.red}异常${C.r} ${String(e).slice(0, 80)}`); results.push([name, false]); }
  };

  if (formats.includes('md')) step('Markdown（打印版）', () => {
    const args = [join(ROOT, 'recon', 'make-md.mjs'), '--src', FILES.papers, '--out', FILES.md];
    if (names.school) args.push('--school', names.school);
    if (names.student) args.push('--student', names.student);
    const r = spawnSync(node, args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) process.stderr.write(r.stderr || '');
    return r.status === 0;
  });
  if (formats.includes('md-bare')) step('Markdown（纯文本）', () => {
    const args = [join(ROOT, 'recon', 'make-md.mjs'), '--bare', '--src', FILES.papers, '--out', FILES.mdBare];
    if (names.student) args.push('--student', names.student);
    if (names.school) args.push('--school', names.school);
    const r = spawnSync(node, args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) process.stderr.write(r.stderr || '');
    return r.status === 0;
  });
  if (formats.includes('pdf')) step('PDF + 打印预览', () => {
    // PDF 由打印版 Markdown 渲染而来；只选 pdf 时先确保 md 存在
    if (!existsSync(FILES.md)) {
      const r = spawnSync(node, [join(ROOT, 'recon', 'make-md.mjs'), '--src', FILES.papers, '--out', FILES.md,
        ...(names.school ? ['--school', names.school] : []), ...(names.student ? ['--student', names.student] : [])],
      { cwd: ROOT, encoding: 'utf8' });
      if (r.status !== 0) { process.stderr.write(r.stderr || ''); return false; }
    }
    const r = spawnSync(node, [join(ROOT, 'recon', 'make-pdf.mjs'),
      '--src', FILES.md, '--html', FILES.html, '--out', FILES.pdf], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) process.stderr.write(r.stderr || '');
    return r.status === 0;
  });
  if (formats.includes('docx')) step('Word', () => {
    const r = spawnSync(PY, [join(ROOT, 'export', 'make-docx.py'),
      '--src', FILES.papers, '--out', FILES.docx, '--account', names.label], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) process.stderr.write((r.stderr || '') + (r.stdout || ''));
    return r.status === 0;
  });
  if (formats.includes('xlsx')) step('Excel', () => {
    if (!existsSync(FILES.raw)) { process.stderr.write('缺少 export\\raw.json（课程数据），跳过\n'); return false; }
    const args = [join(ROOT, 'export', 'make-xlsx.py'), '--src', FILES.raw, '--out', FILES.xlsx,
      '--account', names.label || names.studentId];
    if (names.school) args.push('--school', names.school);
    const r = spawnSync(PY, args, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) process.stderr.write((r.stderr || '') + (r.stdout || ''));
    return r.status === 0;
  });

  const failed = results.filter(([, good]) => !good);
  say('');
  if (failed.length) { warn(`${failed.length} 项失败：${failed.map(([n]) => n).join('、')}`); return 1; }
  ok(`文档已更新到 ${OUTDIR}`);
  return 0;
}

/**
 * AI 是否已配置：环境变量 AI_API_KEY，或 md-ai-answer/config.json 里有非占位的 apiKey。
 * 只用来决定 all 末端要不要自动接上 solve（未配置就跳过，不阻断主流程）。
 */
function aiConfigState() {
  if (String(process.env.AI_API_KEY || '').trim()) return { ok: true, from: '环境变量 AI_API_KEY' };
  const file = join(MDAI_DIR, 'config.json');
  if (existsSync(file)) {
    try {
      const cfg = JSON.parse(readFileSync(file, 'utf8'));
      const key = String(cfg.visionApiKey || cfg.reasonApiKey || cfg.apiKey || '').trim();
      if (key && !/你的key|your[-_ ]?key|^sk-xxx/i.test(key)) {
        return { ok: true, from: file.slice(ROOT.length + 1) };
      }
    } catch { /* 配置损坏按未配置处理 */ }
  }
  return { ok: false, file };
}

function cmdSolve() {
  head('AI 作答');
  if (!existsSync(MDAI_CLI)) { bad('缺少 md-ai-answer\\src\\cli.mjs（解题组件）'); return 1; }

  const input = resolve(ROOT, typeof flag('input') === 'string' ? flag('input') : FILES.md);
  if (!existsSync(input)) { bad(`找不到题库文件：${input}`); say('先跑：node zhs.mjs docs'); return 1; }

  const mock = has('mock');
  if (!mock) {
    const st = aiConfigState();
    if (!st.ok) {
      bad('未配置 AI 接口，无法作答。');
      say('  1) 复制 md-ai-answer\\config.example.json 为 md-ai-answer\\config.json，填好 baseUrl / apiKey / model');
      say('  2) 或设置环境变量：AI_BASE_URL / AI_API_KEY / AI_MODEL（密钥只在解题进程内使用）');
      say('  3) 只想离线试跑：node zhs.mjs solve --mock');
      return 1;
    }
    say(`AI 配置   ${st.from}`);
  }

  // 透传给 md-ai-answer CLI。注意 --out 在本工具里已表示「产物输出目录」，
  // 所以答案文件用 --answer-out 指定，避免两个含义打架。
  const args = [MDAI_CLI, '--input', input];
  const answerOut = flag('answer-out');
  if (typeof answerOut === 'string' && answerOut) args.push('--out', resolve(ROOT, answerOut));
  if (typeof flag('config') === 'string' && flag('config')) args.push('--config', resolve(ROOT, flag('config')));
  for (const k of ['model', 'base-url', 'api-key', 'concurrency', 'batch-size', 'limit']) {
    const v = flag(k);
    if (typeof v === 'string' && v) args.push('--' + k, v);
  }
  if (mock) args.push('--mock');
  if (!has('no-fill')) args.push('--fill'); // 默认同时产出「已回填答案的题库」副本

  say(`题库      ${input}`);
  say(`模式      ${mock ? '离线 mock（不调用 AI）' : '调用 AI 接口'}`);
  const code = run(node, args, { cwd: MDAI_DIR }).status ?? 1;
  if (code === 0) ok('答案已生成');
  else bad(`作答失败（退出码 ${code}）`);
  return code;
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
  const mdOk = r.status === 0;

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

/** 透传参数给 src 下的自动化脚本（script 为 src 内相对路径） */
function runAutomation(script, extraArgs = ARGV.slice(1)) {
  return run(node, [join(ROOT, 'src', script), ...extraArgs], { cwd: ROOT }).status ?? 1;
}

function cmdAnswer() {
  head('全自动作业答题');
  info('逐个打开未提交作业 → 题库作答 → 下一题 → 暂存 → 提交');
  return runAutomation('flows/auto-homework.mjs');
}

function cmdPatrol() {
  head('作业巡检');
  info('检查新作业 / 临近截止 / 状态变化，有变化时弹 Windows 通知');
  return runAutomation('flows/patrol.mjs');
}

/** 截止看板：把本地数据渲染成 HTML，不启动浏览器 */
function cmdDeadline() {
  head('截止看板');
  info('按紧急程度分组展示作业，可搜索 / 筛选课程；只读本地数据');
  return runAutomation('flows/deadline-board.mjs');
}

/** 定时巡检：基于 Windows 计划任务（schtasks） */
function cmdSchedule() {
  head('定时巡检');
  const action = (ARGV[1] && !ARGV[1].startsWith('--')) ? ARGV[1] : 'show';
  const name = typeof flag('name') === 'string' && flag('name') ? flag('name') : 'ZHS-Patrol';
  const RUN_CMD = join(ROOT, 'run.cmd');

  if (action === 'show') {
    const r = spawnSync('schtasks', ['/Query', '/TN', name, '/V', '/FO', 'LIST'], { encoding: 'utf8' });
    if (r.status !== 0) {
      warn(`未安装计划任务「${name}」`);
      say('  安装：node zhs.mjs schedule install --time 08:00');
      return 1;
    }
    const lines = (r.stdout || '').split(/\r?\n/).filter((l) => /任务名|下次运行时间|上次运行时间|上次结果|状态|要运行的任务|Task Name|Next Run Time|Last Run Time|Last Result|Status|Task To Run/i.test(l));
    for (const l of lines) say('  ' + l.trim());
    return 0;
  }

  if (action === 'install') {
    const raw = typeof flag('time') === 'string' ? flag('time') : '08:00';
    const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
    const hh = m ? Number(m[1]) : NaN;
    const mm = m ? Number(m[2]) : NaN;
    if (!m || hh > 23 || mm > 59) { bad(`时间格式不对：${raw}（应为 HH:MM，例如 08:00）`); return 1; }
    const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    const extra = ['patrol'];
    if (typeof flag('webhook') === 'string' && flag('webhook')) extra.push('--webhook', flag('webhook'));
    const tr = `cmd.exe /c ""${RUN_CMD}" ${extra.join(' ')}"`;
    const r = spawnSync('schtasks', ['/Create', '/TN', name, '/SC', 'DAILY', '/ST', time, '/TR', tr, '/F'], { encoding: 'utf8' });
    if (r.status !== 0) {
      bad(`创建计划任务失败：${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
      return 1;
    }
    ok(`已安装计划任务「${name}」：每天 ${time} 自动巡检`);
    say(`  执行：${tr}`);
    say(`  立即试跑：schtasks /Run /TN "${name}"`);
    say('  查看：node zhs.mjs schedule show');
    return 0;
  }

  if (action === 'remove' || action === 'delete') {
    const r = spawnSync('schtasks', ['/Delete', '/TN', name, '/F'], { encoding: 'utf8' });
    if (r.status !== 0) { warn(`没有可删除的计划任务「${name}」`); return 1; }
    ok(`已删除计划任务「${name}」`);
    return 0;
  }

  bad(`未知操作：${action}（可用：install / remove / show）`);
  return 1;
}

function cmdWatch() {
  head('全自动看课');
  info('真实鼠标播放 + 1.5x + 自动处理弹题（脚本调用 play/倍速会被风控）');
  return runAutomation('flows/watch-course.mjs');
}

/** 课程目录：扫描章节 / 课节 / 完成状态，可指定某节自动观看 */
async function cmdCatalog() {
  head('课程目录');
  info('扫描每门课的视频页：章节 / 课节 / 时长 / 是否已完成');
  const scanCode = runAutomation('flows/course-catalog.mjs');
  if (scanCode !== 0) return scanCode;

  const file = join(EXPORT, 'course-catalog.json');
  let cat = null;
  try { cat = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 下面统一提示 */ }
  if (!cat) { bad('目录文件读取失败：export\\course-catalog.json'); return 1; }

  const all = [];
  for (const c of cat.courses || []) {
    if (c.error) continue;
    for (const ch of c.chapters || []) {
      for (const l of ch.lessons || []) all.push({ ...l, course: c.course });
    }
  }
  if (!all.length) { warn('目录为空，没有可选课节'); return 1; }

  const direct = typeof flag('watch') === 'string' ? flag('watch') : null;
  const skipPick = has('json') || has('no-pick');

  let input = direct;
  if (!input && !skipPick) {
    if (!process.stdin.isTTY) {
      info('非交互环境：用 catalog --watch <编号> 指定要自动完成的课节');
      return 0;
    }
    const pending = all.filter((l) => l.studied !== true).length;
    head('选择要自动完成的课节');
    say(`  共 ${all.length} 节，未完成 ${pending} 节`);
    say('  输入课节编号（如 1.3）；同名编号多门课时带上课程关键字（如 心理健康 1.3）');
    say('  直接回车退出');
    input = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const line = String(await askLine(attempt === 0 ? '> ' : '请重新输入> ')).trim();
      if (!line) return 0;
      const hit = resolveCatalogTarget(line, all);
      if (hit) { input = hit; break; }
    }
    if (!input) return 1;
  }
  if (!input || !String(input).trim()) return 0;

  const target = typeof input === 'string' ? resolveCatalogTarget(input.trim(), all) : input;
  if (!target) return 1;

  if (target.studied === true) {
    warn(`${target.course} ${target.no} 已标记为完成；watch 会自动确认并跳过`);
  }
  head('自动完成');
  say(`  ${target.course} · ${target.no} ${target.title}`);

  // 只把看课相关参数透传给 watch，课程与课节用目录解析结果
  const pass = new Set(['rate', 'minutes', 'face-wait', 'no-ai', 'no-tidy', 'browser', 'browser-exe']);
  const args = ['--course', target.course, '--lesson', target.no];
  for (let i = 1; i < ARGV.length; i++) {
    const a = ARGV[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (!pass.has(k)) continue;
    args.push(a);
    const v = ARGV[i + 1];
    if (v !== undefined && !v.startsWith('--')) { args.push(v); i++; }
  }
  return runAutomation('flows/watch-course.mjs', args);
}

/** 在目录里定位课节：精确编号优先，其次「编号 + 标题」包含；多门课同名时要求带课程关键字 */
function resolveCatalogTarget(input, all) {
  const parts = input.split(/\s+/).filter(Boolean);
  let lessonKey = parts[0] || '';
  let courseKey = '';
  if (parts.length > 1) {
    lessonKey = parts[parts.length - 1];
    courseKey = parts.slice(0, -1).join(' ');
  }

  const pool = courseKey ? all.filter((x) => x.course.includes(courseKey)) : all;
  let hits = pool.filter((x) => x.no === lessonKey);
  if (!hits.length) hits = pool.filter((x) => `${x.no} ${x.title}`.includes(lessonKey));

  if (!hits.length) {
    bad(`没有匹配的课节：${input}`);
    return null;
  }
  if (hits.length === 1) return hits[0];

  const courses = [...new Set(hits.map((x) => x.course))];
  if (courses.length > 1) {
    bad(`编号 ${lessonKey} 在多门课中都存在：${courses.join('、')}`);
    say(`  请带上课程关键字，例如：${courses[0].slice(0, 4)} ${lessonKey}`);
    return null;
  }
  // 同一门课里包含匹配出多节：优先未完成的第一节
  return hits.find((x) => x.studied !== true) ?? hits[0];
}

function cmdAuto() {
  head('全自动答题 + 看课');
  const a = runAutomation('flows/auto-homework.mjs');
  if (a !== 0) {
    warn(`答题阶段退出码 ${a}，继续看课`);
  }
  const w = runAutomation('flows/watch-course.mjs');
  return w || a;
}

function cmdAll() {
  const fetchCode = cmdFetch();
  if (fetchCode !== 0 && fetchCode !== 1) return fetchCode;   // 2=未登录 等
  const docsCode = cmdDocs();
  const verifyCode = cmdVerify();

  // 末端接上「AI 作答」，让 all 一条命令跑到答案；未配置 AI 时跳过，不阻断主流程
  let solveCode = 0;
  if (aiConfigState().ok || has('mock')) {
    solveCode = cmdSolve();
  } else {
    head('AI 作答');
    warn('跳过：尚未配置 AI 接口。配好后跑 node zhs.mjs solve（加 --mock 可离线试跑）');
  }

  head('完成');
  say('  node zhs.mjs status     查看状态');
  // 多阶段退出码合并：未登录(2) > 校验不通过(3) > 出错(1) > 成功(0)
  const rank = (c) => (c === 2 ? 4 : c === 3 ? 3 : c === 1 ? 2 : 0);
  return [fetchCode, docsCode, verifyCode, solveCode]
    .reduce((worst, c) => (rank(c) > rank(worst) ? c : worst), 0);
}

// ═════════════════ 分发 ═════════════════
const COMMANDS = {
  help: cmdHelp, '--help': cmdHelp, '-h': cmdHelp,
  status: cmdStatus,
  doctor: cmdDoctor,
  login: cmdLogin,
  fetch: cmdFetch,
  docs: cmdDocs,
  solve: cmdSolve,
  verify: cmdVerify,
  answer: cmdAnswer,
  patrol: cmdPatrol,
  deadline: cmdDeadline,
  schedule: cmdSchedule,
  catalog: cmdCatalog,
  watch: cmdWatch,
  auto: cmdAuto,
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

