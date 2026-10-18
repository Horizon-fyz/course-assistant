// patrol.mjs —— 定时巡检：检查新作业、临近截止、状态变化，并推送通知
//
// 数据来源：
//   默认打开浏览器，按 courses-resolved.json 里的 listRid 逐课程拉取平台
//   最新作业列表（getStudentHomework），并把状态回写到 papers.json；
//   --offline 只读本地 papers.json，不启动浏览器。
//
// 用法：
//   node src\flows\patrol.mjs                     # 巡检全部课程，有变化时弹 Windows 通知
//   node src\flows\patrol.mjs --course 国家安全    # 只巡检名称包含该关键词的课程
//   node src\flows\patrol.mjs --within 24         # 24 小时内截止的作业重点提醒（默认 48）
//   node src\flows\patrol.mjs --offline           # 不开浏览器，只按本地数据判断
//   node src\flows\patrol.mjs --no-notify         # 只生成报告，不通知
//   node src\flows\patrol.mjs --webhook <url>     # 额外推送到飞书/企微/钉钉/通用 Webhook
//   node src\flows\patrol.mjs --dry               # 只打印，不写文件、不通知
//
// 产物：
//   export/patrol-report.json   本次巡检结果
//   export/patrol-state.json    历史快照（用于识别新作业/状态变化/避免重复通知）
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR, writeJson, readJsonStrict, findCourse } from '../core/store.mjs';
import { connect, readyPage, tidy, HOME } from '../core/browser.mjs';
import { writeBoard } from './deadline-board.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const PAPERS = join(DATA_DIR, 'papers.json');
const RESOLVED = join(DATA_DIR, 'courses-resolved.json');
const REPORT = join(DATA_DIR, 'patrol-report.json');
const SNAPSHOT = join(DATA_DIR, 'patrol-state.json');

const argv = process.argv.slice(2);
const getArg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

const DRY = has('--dry');
const OFFLINE = has('--offline');
const NO_NOTIFY = has('--no-notify');
const COURSE = getArg('--course');
const WITHIN = (() => { const n = Number(getArg('--within', '48')); return Number.isFinite(n) && n >= 0 ? n : 48; })();
const WEBHOOK = getArg('--webhook') || process.env.ZHS_PATROL_WEBHOOK || '';

const log = (m = '') => process.stdout.write(m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════════════ 工具 ═══════════════════════ */

const pad = (n) => String(n).padStart(2, '0');
function fmtDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDay(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 平台时间 "2026-11-14 23:59:59"（本地时区）→ 毫秒；非法返回 null */
function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}
const isPending = (hw) => Number(hw?.state) === 1 && hw?.score == null;
const hwKey = (course, hw) => `${course}|${hw.id}|${hw.examId}`;
const hwLabel = (hw) => `${hw.courseName || ''} / ${hw.examName || hw.id}`.replace(/^ \/ /, '');

function paperUrl(courseName, hw, resolved) {
  const rec = findCourse(resolved, { courseId: hw.courseId, courseName });
  if (!rec?.recruitId) return null;
  return 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/'
    + `${rec.recruitId}/${hw.id}/${hw.examId}/${hw.courseId}/5371/${hw.meetCourseType ?? 0}`;
}

/* ═══════════════════════ 拉取平台数据 ═══════════════════════ */

async function checkLogin(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (!page.url().includes('zhihuishu.com')) {
        await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(4000);
      }
      return await page.evaluate(async () => {
        const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
        const j = await r.json();
        return { code: j.code, user: j.result };
      });
    } catch {
      await sleep(2000);
    }
  }
  return { code: -1, error: '校验失败（页面持续跳转）' };
}

/** 打开考试列表页，截获 getStudentHomework 响应 */
async function fetchHomework(page, listRid) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let body = null;
    const onRes = async (r) => { if (/getStudentHomework/.test(r.url())) { try { body = await r.text(); } catch {} } };
    page.on('response', onRes);
    try {
      await page.goto(`https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=${listRid}`, {
        waitUntil: 'domcontentloaded', timeout: 45000,
      });
    } catch {}
    await page.waitForTimeout(6000);
    page.off('response', onRes);
    if (body) {
      try {
        const list = JSON.parse(body)?.rt?.studentHomeworkList;
        if (Array.isArray(list)) return list;
      } catch {}
    }
    log(`      作业列表重试 ${attempt}/2…`);
  }
  return [];
}

/* ═══════════════════════ 合并回 papers.json ═══════════════════════ */

const SYNC_FIELDS = [
  'state', 'score', 'backNum', 'startTime', 'endDate', 'achieveCount', 'achieve',
  'backStatus', 'isMarking', 'totalScore', 'problemNum', 'meetCourseType',
  'examName', 'courseId', 'courseName', 'cpOrderNumber',
];

/** 用平台最新状态更新本地题库；返回是否有写入价值 */
function mergePapers(papers, course, list) {
  const arr = Array.isArray(papers[course]) ? papers[course] : [];
  let changed = 0;
  let added = 0;
  for (const hw of list) {
    const hit = arr.find((x) => String(x.id) === String(hw.id) && String(x.examId) === String(hw.examId));
    if (!hit) { arr.push(hw); added++; continue; }
    let dirty = false;
    for (const k of SYNC_FIELDS) {
      if (hw[k] !== undefined && hit[k] !== hw[k]) { hit[k] = hw[k]; dirty = true; }
    }
    if (dirty) changed++;
  }
  papers[course] = arr;
  return { changed, added };
}

/* ═══════════════════════ 通知 ═══════════════════════ */

function notifyWindows(title, body) {
  const esc = (s) => String(s).replace(/'/g, "''");
  const ps = `$ErrorActionPreference='SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $t.GetElementsByTagName('text')
$texts.Item(0).AppendChild($t.CreateTextNode('${esc(title)}')) > $null
$texts.Item(1).AppendChild($t.CreateTextNode('${esc(body)}')) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($t)
$appid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appid).Show($toast)`;
  const enc = Buffer.from(ps, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], { timeout: 15000 }, (err) => {
      resolve(err ? `Windows 通知失败：${String(err.message || err).slice(0, 100)}` : 'Windows 通知已发送');
    });
  });
}

/** 按 Webhook 域名自动适配飞书 / 企微 / 钉钉 / 通用 JSON */
async function notifyWebhook(url, text) {
  let payload = { text };
  if (/open\.feishu\.cn|open\.larksuite\.com/.test(url)) payload = { msg_type: 'text', content: { text } };
  else if (/qyapi\.weixin\.qq\.com|oapi\.dingtalk\.com/.test(url)) payload = { msgtype: 'text', text: { content: text } };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.text().catch(() => '');
    return res.ok ? 'Webhook 已推送' : `Webhook 失败 HTTP ${res.status}：${body.slice(0, 120)}`;
  } catch (e) {
    return `Webhook 失败：${String(e.message || e).slice(0, 120)}`;
  }
}

/* ═══════════════════════ 主流程 ═══════════════════════ */

log('══════════ 作业巡检 ══════════');

const papers = readJsonStrict(PAPERS, {}, 'papers.json') || {};
const resolved = readJsonStrict(RESOLVED, {}, 'courses-resolved.json') || {};
const prevState = readJsonStrict(SNAPSHOT, { items: {} }, 'patrol-state.json') || { items: {} };
const prevItems = prevState.items && typeof prevState.items === 'object' ? prevState.items : {};
/** 首次巡检只建立基线，不把存量作业全报成「新作业」 */
const firstRun = Object.keys(prevItems).length === 0;

/** 归一化后的本次作业集合：key → { course, hw } */
const current = new Map();
let liveError = null;
let user = null;
let session = null;

if (!OFFLINE) {
  session = await connect({
    prefer: getArg('--browser', 'chromium') === 'firefox' ? 'firefox' : 'chromium',
    exe: getArg('--browser-exe'),
  });
  log('浏览器: ' + session.describe);

  const page = await readyPage(session.ctx, HOME);
  const chk = await checkLogin(page);
  if (chk.code !== 200) {
    log(`✗ 未登录（code=${chk.code}），请先运行 node zhs.mjs login`);
    await tidy(session.ctx).catch(() => {});
    await session.close();
    process.exit(2);
  }
  user = chk.user?.realName || chk.user?.name || '';
  log(`账号: ${user || '(已登录)'}`);

  const entries = Object.entries(resolved).filter(([name, rec]) => {
    if (!rec || typeof rec !== 'object' || !rec.listRid) return false;
    if (COURSE && !(name.includes(COURSE) || String(rec.courseName || '').includes(COURSE))) return false;
    return true;
  });

  log(`课程: ${entries.length} 门`);
  let papersDirty = false;

  for (const [name, rec] of entries) {
    const course = rec.courseName || name;
    log(`  · ${course} …`);
    const list = await fetchHomework(page, rec.listRid);
    if (!list.length) {
      log('      ⚠️ 未取到作业列表（可能登录失效或课程无作业）');
      liveError = liveError || `${course}: 未取到作业列表`;
      continue;
    }
    log(`      ${list.length} 份作业`);
    for (const hw of list) current.set(hwKey(course, hw), { course, hw });
    const m = mergePapers(papers, course, list);
    if (m.changed || m.added) papersDirty = true;
    if (m.changed || m.added) log(`      同步 papers.json：更新 ${m.changed}，新增 ${m.added}`);
  }

  if (papersDirty && !DRY) {
    writeJson(PAPERS, papers);
    log('      papers.json 已回写');
  }
} else {
  // 离线：直接用本地 papers.json 判断变化
  for (const [course, list] of Object.entries(papers)) {
    if (COURSE && !course.includes(COURSE)) continue;
    for (const hw of Array.isArray(list) ? list : []) current.set(hwKey(course, hw), { course, hw });
  }
  log(`离线模式：本地 ${current.size} 份作业`);
}

if (!current.size) {
  log('\n没有可巡检的作业数据。');
  if (!OFFLINE) { await tidy(session.ctx).catch(() => {}); await session.close(); }
  process.exit(liveError ? 1 : 0);
}

/* ── 对比快照，产出事件 ── */

const now = Date.now();
const today = fmtDay(new Date());
const events = { fresh: [], changed: [], deadline: [] };
const reportItems = [];
const nextItems = {};
let pendingCount = 0;

for (const [key, { course, hw }] of current) {
  const prev = prevItems[key];
  const pending = isPending(hw);
  if (pending) pendingCount++;

  const endTs = parseTime(hw.endDate);
  const hoursLeft = endTs == null ? null : (endTs - now) / 3600000;
  const isNew = !firstRun && !prev;
  const changed = !!prev && (Number(prev.state) !== Number(hw.state) || (prev.score ?? null) !== (hw.score ?? null));
  const deadlineSoon = pending && hoursLeft != null && hoursLeft >= 0 && hoursLeft <= WITHIN;

  const base = {
    key, course, examName: hw.examName || hw.id, id: hw.id, examId: hw.examId,
    state: hw.state ?? null, score: hw.score ?? null, backNum: hw.backNum ?? null,
    startTime: hw.startTime || null, endDate: hw.endDate || null,
    hoursLeft: hoursLeft == null ? null : Math.round(hoursLeft * 10) / 10,
    pending, isNew, deadlineSoon, changed,
    url: paperUrl(course, hw, resolved),
  };
  reportItems.push(base);

  if (isNew) events.fresh.push(base);
  if (changed) events.changed.push({ ...base, prevState: prev.state ?? null, prevScore: prev.score ?? null });
  // 截止提醒每天最多一次
  const deadlineNotifiedOn = prev?.deadlineNotifiedOn || '';
  if (deadlineSoon && deadlineNotifiedOn !== today) events.deadline.push(base);

  nextItems[key] = {
    firstSeen: prev?.firstSeen || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    course, examName: hw.examName || hw.id,
    state: hw.state ?? null, score: hw.score ?? null, backNum: hw.backNum ?? null,
    endDate: hw.endDate || null,
    deadlineNotifiedOn: deadlineSoon ? today : (prev?.deadlineNotifiedOn || ''),
  };
}

const counts = {
  total: current.size,
  pending: pendingCount,
  new: events.fresh.length,
  changed: events.changed.length,
  deadline: events.deadline.length,
};

/* ── 输出 ── */

const stamp = fmtDate();
log(`\n共 ${counts.total} 份，未提交 ${counts.pending} 份`);
if (firstRun) log('（首次巡检：已建立基线，存量作业不计为新作业）');
if (counts.new) log(`🆕 新作业 ${counts.new} 份`);
for (const e of events.fresh) log(`   + ${e.course} / ${e.examName}（截止 ${e.endDate || '?'}）`);
if (counts.deadline) log(`⏰ ${WITHIN} 小时内截止 ${counts.deadline} 份`);
for (const e of events.deadline) log(`   ! ${e.course} / ${e.examName}（剩 ${e.hoursLeft} 小时）`);
if (counts.changed) log(`🔄 状态变化 ${counts.changed} 份`);
for (const e of events.changed) {
  log(`   ~ ${e.course} / ${e.examName}：state ${e.prevState}→${e.state}，分数 ${e.prevScore ?? '-'}→${e.score ?? '-'}`);
}
if (!counts.new && !counts.deadline && !counts.changed) log('没有新变化。');

const report = {
  at: new Date().toISOString(),
  mode: OFFLINE ? 'offline' : 'live',
  user: user || null,
  windowHours: WITHIN,
  error: liveError,
  counts,
  events,
  items: reportItems,
};

if (!DRY) {
  writeJson(REPORT, report);
  writeJson(SNAPSHOT, { updatedAt: report.at, items: nextItems });
  log(`报告: ${REPORT.replace(ROOT + '\\', '')}`);
  try {
    const board = writeBoard({ papers, resolved, report });
    log(`看板: ${board.out.replace(ROOT + '\\', '')}`);
  } catch (e) {
    log(`看板生成失败: ${String(e.message || e).slice(0, 120)}`);
  }
}

/* ── 通知 ── */

const hasNews = counts.new + counts.deadline + counts.changed > 0;
if (DRY || NO_NOTIFY || !hasNews) {
  if (NO_NOTIFY && hasNews) log('（--no-notify：跳过通知）');
  if (!hasNews) log('（无变化，不通知）');
} else {
  const lines = [`共 ${counts.total} 份作业，未提交 ${counts.pending} 份`];
  if (counts.new) {
    lines.push(`新增 ${counts.new} 份：`, ...events.fresh.slice(0, 4).map((e) => `· ${e.course}/${e.examName}（${e.endDate || '?'} 截止）`));
  }
  if (counts.deadline) {
    lines.push(`${WITHIN} 小时内截止 ${counts.deadline} 份：`, ...events.deadline.slice(0, 4).map((e) => `· ${e.course}/${e.examName}（剩 ${e.hoursLeft} 小时）`));
  }
  if (counts.changed) {
    lines.push(`状态变化 ${counts.changed} 份：`, ...events.changed.slice(0, 4).map((e) => `· ${e.course}/${e.examName}（${e.score != null ? `分数 ${e.score}` : '状态已更新'}）`));
  }
  const text = `【智慧树巡检】${stamp}\n${lines.join('\n')}`;

  log(await notifyWindows('智慧树作业巡检', lines.join('\n').slice(0, 240)));
  if (WEBHOOK) log(await notifyWebhook(WEBHOOK, text));
}

if (!OFFLINE && session) {
  await tidy(session.ctx).catch(() => {});
  await session.close();
}
process.exit(liveError ? 1 : 0);
