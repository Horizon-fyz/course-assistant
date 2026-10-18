// deadline-board.mjs —— 作业截止看板：把 papers.json 渲染成一份可离线打开的 HTML
//
// 只读本地数据，不启动浏览器、不修改任何平台状态。
//
// 用法：
//   node src\flows\deadline-board.mjs                 # 生成 export\deadline-board.html
//   node src\flows\deadline-board.mjs --open          # 生成后直接用默认浏览器打开
//   node src\flows\deadline-board.mjs --course 国家安全 # 只看名称包含该关键词的课程
//   node src\flows\deadline-board.mjs --out D:\看板    # 输出到指定目录
//
// 产物：
//   export/deadline-board.html   按紧急程度分组的静态看板（无外部依赖）
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DATA_DIR, readJsonStrict, findCourse } from '../core/store.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const PAPERS = join(DATA_DIR, 'papers.json');
const RESOLVED = join(DATA_DIR, 'courses-resolved.json');
const REPORT = join(DATA_DIR, 'patrol-report.json');
const DEFAULT_OUT = join(DATA_DIR, 'deadline-board.html');

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}
function shortTime(s) {
  return s ? String(s).replace(/:\d{2}$/, '') : '';
}
function fmtDur(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`;
  if (hours < 24) return `${Math.round(hours * 10) / 10} 小时`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return h ? `${d} 天 ${h} 小时` : `${d} 天`;
}
function relativeText(hoursLeft, pending) {
  if (!pending) return '已完成';
  if (hoursLeft == null) return '无截止时间';
  if (hoursLeft < 0) return `已过期 ${fmtDur(-hoursLeft)}`;
  return `剩 ${fmtDur(hoursLeft)}`;
}

/** 由课程数据拼出作业作答页地址（与 patrol 的规则一致） */
export function paperUrl(courseName, hw, resolved) {
  const rec = findCourse(resolved, { courseId: hw.courseId, courseName });
  if (!rec?.recruitId) return null;
  return 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/'
    + `${rec.recruitId}/${hw.id}/${hw.examId}/${hw.courseId}/5371/${hw.meetCourseType ?? 0}`;
}

/**
 * 把 papers.json 归一化成看板条目。
 * @returns {Array<object>} 已排序：未提交按截止时间升序，已提交按截止时间降序
 */
export function collectHomework(papers, resolved = {}, { course = '', now = Date.now() } = {}) {
  const seen = new Set();
  const items = [];
  for (const [name, list] of Object.entries(papers || {})) {
    if (!Array.isArray(list)) continue;
    for (const hw of list) {
      if (!hw || hw.id == null) continue;
      const courseName = hw.courseName || name;
      if (course && !(courseName.includes(course) || String(name).includes(course))) continue;
      const key = `${courseName}|${hw.id}|${hw.examId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // state 1 = 未提交；state 5 = 退回重做，都还需要作答
      const pending = (Number(hw.state) === 1 || Number(hw.state) === 5) && hw.score == null;
      const endTs = parseTime(hw.endDate);
      const hoursLeft = endTs == null ? null : Math.round(((endTs - now) / 3600000) * 10) / 10;
      let bucket = 'done';
      if (pending) {
        if (endTs == null) bucket = 'none';
        else if (hoursLeft < 0) bucket = 'overdue';
        else if (hoursLeft < 24) bucket = 'today';
        else if (hoursLeft < 72) bucket = 'd3';
        else if (hoursLeft < 168) bucket = 'd7';
        else bucket = 'later';
      }

      items.push({
        key,
        course: courseName,
        title: hw.examName || `作业 ${hw.id}`,
        pending,
        bucket,
        state: hw.state ?? null,
        score: hw.score ?? null,
        backNum: hw.backNum ?? null,
        endDate: hw.endDate || '',
        deadlineText: shortTime(hw.endDate) || '无截止时间',
        startText: shortTime(hw.startTime),
        hoursLeft,
        relative: relativeText(hoursLeft, pending),
        endTs,
        url: paperUrl(courseName, hw, resolved),
      });
    }
  }

  const byDeadline = (a, b) => (a.endTs ?? Infinity) - (b.endTs ?? Infinity);
  items.sort((a, b) => {
    if (a.pending !== b.pending) return a.pending ? -1 : 1;
    return a.pending ? byDeadline(a, b) : -byDeadline(a, b);
  });
  return items;
}

function statLine(items) {
  const pending = items.filter((x) => x.pending);
  return {
    total: items.length,
    pending: pending.length,
    done: items.length - pending.length,
    today: pending.filter((x) => x.bucket === 'today').length,
    d3: pending.filter((x) => x.bucket === 'd3').length,
    overdue: pending.filter((x) => x.bucket === 'overdue').length,
  };
}

function readMeta() {
  const papersAt = existsSync(PAPERS) ? statSync(PAPERS).mtime : null;
  const report = readJsonStrict(REPORT, null, 'patrol-report.json');
  const lastPatrol = report?.at ? Date.parse(report.at) : null;
  return {
    papersUpdated: papersAt ? fmtDate(papersAt) : '',
    lastPatrol: Number.isFinite(lastPatrol) ? fmtDate(new Date(lastPatrol)) : '',
    lastPatrolHours: Number.isFinite(lastPatrol) ? Math.round(((Date.now() - lastPatrol) / 3600000) * 10) / 10 : null,
    user: report?.user || '',
  };
}

export function buildBoardHtml(items, meta = {}) {
  const data = {
    generatedAt: meta.generatedAt || fmtDate(),
    papersUpdated: meta.papersUpdated || '',
    lastPatrol: meta.lastPatrol || '',
    lastPatrolHours: meta.lastPatrolHours ?? null,
    user: meta.user || '',
    stats: statLine(items),
    items: items.map(({ key, course, title, pending, bucket, score, backNum, deadlineText, startText, relative, url }) => ({
      key, course, title, pending, bucket, score, backNum, deadlineText, startText, relative, url,
    })),
  };
  const json = JSON.stringify(data).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>作业截止看板</title>
<style>
  :root {
    --bg: #f4f5f7;
    --panel: #ffffff;
    --line: #e5e7eb;
    --text: #1f2937;
    --muted: #6b7280;
    --accent: #2563eb;
    --danger: #dc2626;
    --danger-bg: #fef2f2;
    --warn: #d97706;
    --warn-bg: #fffbeb;
    --calm: #0f766e;
    --calm-bg: #f0fdfa;
    --done: #6b7280;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.6 "Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 24px 48px; }
  header { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: flex-end; justify-content: space-between; }
  h1 { margin: 0; font-size: 26px; letter-spacing: .5px; }
  .meta { margin: 6px 0 0; color: var(--muted); font-size: 12.5px; }
  .banner {
    margin-top: 16px; padding: 10px 14px; border-radius: 10px;
    background: var(--warn-bg); border: 1px solid #fde68a; color: #92400e; font-size: 13px;
  }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-top: 20px; }
  .stat {
    appearance: none; text-align: left; cursor: pointer; font: inherit;
    background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 12px 14px; transition: border-color .15s, box-shadow .15s, transform .15s;
  }
  .stat:hover { border-color: #cbd5e1; transform: translateY(-1px); box-shadow: 0 6px 16px rgba(15, 23, 42, .06); }
  .stat span { display: block; color: var(--muted); font-size: 12.5px; }
  .stat strong { display: block; margin-top: 2px; font-size: 24px; line-height: 1.2; }
  .stat.danger strong { color: var(--danger); }
  .stat.warn strong { color: var(--warn); }
  .stat.done strong { color: var(--done); }
  .toolbar {
    position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 10px;
    align-items: center; margin-top: 20px; padding: 12px 0;
    background: linear-gradient(var(--bg) 82%, rgba(244, 245, 247, 0));
  }
  input[type="search"], select {
    font: inherit; color: inherit; background: var(--panel);
    border: 1px solid var(--line); border-radius: 9px; padding: 8px 12px; outline: none;
  }
  input[type="search"] { flex: 1 1 240px; }
  input[type="search"]:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37, 99, 235, .12); }
  .tabs { display: inline-flex; background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 3px; }
  .tabs button {
    appearance: none; font: inherit; cursor: pointer; border: 0; background: transparent;
    color: var(--muted); padding: 5px 13px; border-radius: 7px;
  }
  .tabs button.active { background: var(--accent); color: #fff; }
  section.group { margin-top: 22px; }
  .group-head { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; }
  .group-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .group-head .count { color: var(--muted); font-size: 12.5px; }
  .group-head .bar { flex: 1; height: 1px; background: var(--line); }
  .group-head .dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; }
  .group-head.overdue .dot, .group-head.today .dot { background: var(--danger); }
  .group-head.d3 .dot, .group-head.d7 .dot { background: var(--warn); }
  .group-head.later .dot, .group-head.none .dot { background: var(--calm); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 12px; }
  .card {
    display: flex; flex-direction: column; gap: 8px; background: var(--panel);
    border: 1px solid var(--line); border-left: 4px solid #cbd5e1;
    border-radius: var(--radius); padding: 14px 15px 13px;
  }
  .card.overdue, .card.today { border-left-color: var(--danger); }
  .card.d3, .card.d7 { border-left-color: var(--warn); }
  .card.later, .card.none { border-left-color: #14b8a6; }
  .card.done { border-left-color: #d1d5db; opacity: .82; }
  .card-top { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
  .course {
    max-width: 68%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--accent); background: #eff6ff; border-radius: 999px; padding: 1px 9px; font-size: 12px;
  }
  .pill { border-radius: 999px; padding: 1px 9px; font-size: 12px; background: #f3f4f6; color: var(--muted); white-space: nowrap; }
  .pill.danger { background: var(--danger-bg); color: var(--danger); }
  .pill.warn { background: var(--warn-bg); color: var(--warn); }
  .pill.done { background: #f3f4f6; color: var(--done); }
  .card h3 { margin: 0; font-size: 14.5px; line-height: 1.45; font-weight: 600; word-break: break-word; }
  .deadline { font-size: 13px; color: var(--text); }
  .deadline b { font-weight: 600; }
  .card.overdue .deadline b, .card.today .deadline b { color: var(--danger); }
  .card.d3 .deadline b, .card.d7 .deadline b { color: var(--warn); }
  .card.done .deadline b { color: var(--done); }
  .sub { color: var(--muted); font-size: 12px; }
  .card a.go {
    align-self: flex-start; margin-top: 2px; color: var(--accent); text-decoration: none; font-size: 12.5px;
  }
  .card a.go:hover { text-decoration: underline; }
  .empty, .none-found {
    margin-top: 26px; padding: 40px 20px; text-align: center; color: var(--muted);
    background: var(--panel); border: 1px dashed var(--line); border-radius: var(--radius);
  }
  footer { margin-top: 32px; color: var(--muted); font-size: 12px; line-height: 1.9; }
  code { background: #eceff3; border-radius: 5px; padding: 1px 5px; font-size: 12px; }
  @media print {
    body { background: #fff; }
    .toolbar, .stats { display: none; }
    .wrap { max-width: none; padding: 0; }
    .card { break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>作业截止看板</h1>
      <p class="meta" id="meta"></p>
    </div>
    <p class="meta">按截止时间排序 · 未提交优先</p>
  </header>
  <div id="banner"></div>
  <div class="stats" id="stats"></div>
  <div class="toolbar">
    <input id="q" type="search" placeholder="搜索课程或作业名…" aria-label="搜索">
    <select id="course" aria-label="课程筛选"><option value="all">全部课程</option></select>
    <div class="tabs" role="group" aria-label="状态筛选">
      <button data-status="pending" class="active">未提交</button>
      <button data-status="all">全部</button>
      <button data-status="done">已提交</button>
    </div>
  </div>
  <main id="board"></main>
  <footer>
    <div>数据来源：<code>papers.json</code>（本地只读渲染，不会提交任何作业）</div>
    <div>刷新数据：<code>run.cmd patrol</code> 同步平台状态后重跑 <code>run.cmd deadline</code></div>
  </footer>
</div>
<script>
const DATA = ${json};
const BUCKETS = [
  ['overdue', '已过期未提交'],
  ['today', '24 小时内'],
  ['d3', '1–3 天'],
  ['d7', '3–7 天'],
  ['later', '7 天以上'],
  ['none', '无截止时间'],
];
const view = { status: 'pending', course: 'all', q: '', bucket: 'all' };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function renderMeta() {
  const bits = ['生成于 ' + DATA.generatedAt];
  if (DATA.papersUpdated) bits.push('数据更新 ' + DATA.papersUpdated);
  if (DATA.lastPatrol) bits.push('最近巡检 ' + DATA.lastPatrol);
  if (DATA.user) bits.push(DATA.user);
  document.getElementById('meta').textContent = bits.join(' · ');

  const box = document.getElementById('banner');
  if (!DATA.lastPatrol) {
    box.className = 'banner';
    box.textContent = '还没有巡检记录：作业状态可能不是最新，建议先运行 run.cmd patrol 同步平台数据。';
  } else if (DATA.lastPatrolHours != null && DATA.lastPatrolHours >= 24) {
    box.className = 'banner';
    box.textContent = '最近一次巡检在 ' + DATA.lastPatrolHours + ' 小时前，建议重新运行 run.cmd patrol 获取最新状态。';
  }
}

function renderStats() {
  const box = document.getElementById('stats');
  const defs = [
    ['未提交', DATA.stats.pending, '', 'pending', 'all'],
    ['24 小时内', DATA.stats.today, 'danger', 'pending', 'today'],
    ['3 天内', DATA.stats.d3, 'warn', 'pending', 'd3'],
    ['已过期未交', DATA.stats.overdue, 'danger', 'pending', 'overdue'],
    ['已提交', DATA.stats.done, 'done', 'done', 'all'],
  ];
  for (const [label, value, tone, status, bucket] of defs) {
    const b = el('button', 'stat' + (tone ? ' ' + tone : ''));
    b.type = 'button';
    b.appendChild(el('span', '', label));
    b.appendChild(el('strong', '', String(value)));
    b.addEventListener('click', () => {
      view.status = status;
      view.bucket = bucket;
      syncTabs();
      render();
    });
    box.appendChild(b);
  }
}

function syncTabs() {
  document.querySelectorAll('.tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.status === view.status);
  });
}

function matches(it) {
  if (view.course !== 'all' && it.course !== view.course) return false;
  if (view.q && !(it.course + ' ' + it.title).toLowerCase().includes(view.q)) return false;
  if (view.status === 'pending' && !it.pending) return false;
  if (view.status === 'done' && it.pending) return false;
  if (view.bucket !== 'all' && it.bucket !== view.bucket) return false;
  return true;
}

function card(it) {
  const c = el('article', 'card ' + it.bucket);
  const top = el('div', 'card-top');
  top.appendChild(el('span', 'course', it.course));
  const pillTone = it.pending ? (it.bucket === 'today' || it.bucket === 'overdue' ? ' danger' : (it.bucket === 'd3' || it.bucket === 'd7' ? ' warn' : '')) : ' done';
  top.appendChild(el('span', 'pill' + pillTone, it.pending ? '未提交' : '已提交'));
  c.appendChild(top);
  c.appendChild(el('h3', '', it.title));

  const dl = el('div', 'deadline');
  dl.appendChild(document.createTextNode('截止 ' + it.deadlineText + '　'));
  dl.appendChild(el('b', '', it.relative));
  c.appendChild(dl);

  const subs = [];
  if (it.startText) subs.push('开始 ' + it.startText);
  if (it.pending && it.backNum != null) subs.push('剩余作答 ' + it.backNum + ' 次');
  if (!it.pending && it.score != null) subs.push('得分 ' + it.score);
  if (subs.length) c.appendChild(el('div', 'sub', subs.join(' · ')));

  if (it.url) {
    const a = el('a', 'go', '去作答 →');
    a.href = it.url;
    a.target = '_blank';
    a.rel = 'noopener';
    c.appendChild(a);
  }
  return c;
}

function section(bucket, label, list) {
  const s = el('section', 'group');
  const h = el('div', 'group-head ' + bucket);
  h.appendChild(el('span', 'dot'));
  h.appendChild(el('h2', '', label));
  h.appendChild(el('span', 'count', list.length + ' 份'));
  h.appendChild(el('span', 'bar'));
  s.appendChild(h);
  const grid = el('div', 'cards');
  for (const it of list) grid.appendChild(card(it));
  s.appendChild(grid);
  return s;
}

function render() {
  const board = document.getElementById('board');
  board.replaceChildren();
  const list = DATA.items.filter(matches);

  if (!DATA.items.length) {
    const empty = el('div', 'empty', '还没有作业数据。先运行 run.cmd fetch 抓取题库，再用 run.cmd deadline 生成看板。');
    board.appendChild(empty);
    return;
  }
  if (!list.length) {
    board.appendChild(el('div', 'none-found', '当前筛选没有匹配的作业。'));
    return;
  }

  const pendingList = list.filter((x) => x.pending);
  const doneList = list.filter((x) => !x.pending);
  for (const [bucket, label] of BUCKETS) {
    const part = pendingList.filter((x) => x.bucket === bucket);
    if (part.length) board.appendChild(section(bucket, label, part));
  }
  if (doneList.length) board.appendChild(section('done', '已提交 / 已评分', doneList));
}

function initFilters() {
  const q = document.getElementById('q');
  q.addEventListener('input', () => { view.q = q.value.trim().toLowerCase(); render(); });

  const sel = document.getElementById('course');
  const courses = [...new Set(DATA.items.map((x) => x.course))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  for (const name of courses) {
    const opt = el('option', '', name);
    opt.value = name;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => { view.course = sel.value; render(); });

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      view.status = b.dataset.status;
      view.bucket = 'all';
      syncTabs();
      render();
    });
  });
}

renderMeta();
renderStats();
initFilters();
render();
</script>
<noscript>这个看板需要浏览器启用 JavaScript 才能筛选；直接查看请打开上方数据文件。</noscript>
</body>
</html>`;
}

/** 生成看板文件；返回 { out, items } */
export function writeBoard({
  papers = null,
  resolved = null,
  report = null,
  out = DEFAULT_OUT,
  course = '',
  now = Date.now(),
} = {}) {
  const p = papers ?? (readJsonStrict(PAPERS, {}, 'papers.json') || {});
  const r = resolved ?? (readJsonStrict(RESOLVED, {}, 'courses-resolved.json') || {});
  const meta = readMeta();
  if (report?.at) {
    const t = Date.parse(report.at);
    if (Number.isFinite(t)) {
      meta.lastPatrol = fmtDate(new Date(t));
      meta.lastPatrolHours = Math.round(((Date.now() - t) / 3600000) * 10) / 10;
    }
    if (report.user) meta.user = report.user;
  }
  const items = collectHomework(p, r, { course, now });
  const html = buildBoardHtml(items, { ...meta, generatedAt: fmtDate() });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf8');
  return { out, items, stats: statLine(items) };
}

/* ═══════════════════════ CLI ═══════════════════════ */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const getArg = (n, d = null) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
  };
  const course = getArg('--course', '');
  const out = getArg('--out') ? join(resolve(getArg('--out')), 'deadline-board.html') : DEFAULT_OUT;
  const open = argv.includes('--open');

  console.log('══════════ 作业截止看板 ══════════');
  try {
    const { items, stats } = writeBoard({ out, course });
    console.log(`共 ${stats.total} 份作业，未提交 ${stats.pending} 份，已提交 ${stats.done} 份`);
    console.log(`24 小时内 ${stats.today} 份 / 3 天内 ${stats.d3} 份 / 已过期未交 ${stats.overdue} 份`);
    console.log(`看板: ${out}`);
    if (!items.length) console.log('（没有可展示的作业，先运行 node zhs.mjs fetch）');
    if (open) spawn('cmd.exe', ['/c', 'start', '', out], { detached: true, stdio: 'ignore' }).unref();
    process.exit(0);
  } catch (e) {
    console.error('生成看板失败：' + String(e.message || e));
    process.exit(1);
  }
}
