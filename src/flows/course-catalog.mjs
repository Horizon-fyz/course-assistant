// course-catalog.mjs —— 课程目录扫描（章节 / 课节 / 时长 / 完成状态）
//
// 用法：
//   node src\flows\course-catalog.mjs                     # 扫描全部课程
//   node src\flows\course-catalog.mjs --course 国家安全    # 只扫某一门课
//   node src\flows\course-catalog.mjs --json              # 只输出 JSON
//
// 数据来源：
//   打开 https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId={secret}
//   旁听页面自身发出的 learning/videolist 响应，取 data.videoChapterDtos：
//     chapter.isPass / learningLessonStatus
//     lesson.id / videoId / orderNumber / name / videoSec / isStudiedLesson
//   （固定签名常量直接请求在多门课间可能返回同一门课的数据，因此以页面实际响应为准）
//   实测 isStudiedLesson 恒为 0（看完的课节也是 0），完成状态改用 DOM 里
//   li.video 的 b.time_icofinish 标记判定（b.time_ico_half 只是未完成图标，
//   实测平台进度仍为 0，不能当作已看一半）。
//   videolist 未捕获到时回退读取 DOM li.video，此时完成状态未知。
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, tidy } from '../core/browser.mjs';
import { DATA_DIR, writeJson } from '../core/store.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const EXPORT = DATA_DIR;
const OUTFILE = join(EXPORT, 'course-catalog.json');
mkdirSync(EXPORT, { recursive: true });

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

const COURSE = getArg('--course');
const JSON_ONLY = has('--json');
const KEEP_TABS = has('--no-tidy');

const log = (m = '') => process.stdout.write(m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hms = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:` : '') + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
};

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

const READ_DOM = () => {
  const c = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('li.video')].map((li, i) => ({
    i,
    no: c(li.querySelector('.hour')?.innerText || ''),
    title: c(li.querySelector('.catalogue_title')?.getAttribute('title') || li.querySelector('.catalogue_title')?.innerText || ''),
    time: c(li.querySelector('.time')?.innerText || ''),
    current: li.classList.contains('current_play'),
    finish: !!li.querySelector('.time_icofinish'),
  }));
};

/** videolist 的 data → 统一的章节课节目录；完成状态以 DOM 的 time_icofinish 为准 */
function fromApi(data, fallback = {}, dom = []) {
  const domByKey = new Map();
  for (const d of dom) domByKey.set(`${d.no}|${d.title}`, d);
  const chapters = [];
  const list = data?.videoChapterDtos || [];
  list.forEach((ch, ci) => {
    const chNo = Number(ch.orderNumber) || ci + 1;
    const lessons = (ch.videoLessons || []).map((l, li) => {
      const no = `${chNo}.${Number(l.orderNumber) || li + 1}`;
      const seconds = Number(l.videoSec) || 0;
      const title = String(l.name || '').trim();
      const d = domByKey.get(`${no}|${title}`);
      return {
        no,
        title,
        seconds,
        time: hms(seconds),
        // 接口的 isStudiedLesson 实测恒为 0，只有拿到 DOM 标记时才可信
        studied: d ? d.finish : Number(l.isStudiedLesson) === 1,
        lessonId: l.id ?? null,
        videoId: l.videoId ?? null,
        chapterId: l.chapterId ?? null,
      };
    });
    chapters.push({
      no: chNo,
      name: String(ch.name || '').trim(),
      lessons,
    });
  });
  return {
    course: String(data?.courseName || fallback.name || '').trim(),
    courseId: data?.courseId ?? fallback.courseId ?? null,
    recruitId: data?.recruitId ?? fallback.recruitId ?? null,
    source: 'videolist',
    chapters,
  };
}

/** DOM 回退：只有序号/标题/时长，完成状态未知 */
function fromDom(lessons, fallback = {}) {
  const chapters = [];
  const index = new Map();
  for (const l of lessons) {
    const m = /^(\d+)(?:\.(\d+))?/.exec(l.no);
    const chNo = m ? Number(m[1]) : 1;
    if (!index.has(chNo)) {
      const ch = { no: chNo, name: '', lessons: [] };
      index.set(chNo, ch);
      chapters.push(ch);
    }
    index.get(chNo).lessons.push({
      no: l.no || `${chNo}.${index.get(chNo).lessons.length + 1}`,
      title: l.title,
      seconds: 0,
      time: l.time,
      studied: null,
      lessonId: null,
      videoId: null,
      chapterId: null,
    });
  }
  return {
    course: String(fallback.name || '').trim(),
    courseId: fallback.courseId ?? null,
    recruitId: fallback.recruitId ?? null,
    source: 'dom',
    chapters,
  };
}

function summarize(c) {
  const lessons = c.chapters.flatMap((ch) => ch.lessons);
  const known = lessons.filter((l) => l.studied !== null);
  const studied = lessons.filter((l) => l.studied === true).length;
  return {
    chapters: c.chapters.length,
    lessons: lessons.length,
    studied,
    known: known.length,
  };
}

function printCourse(c) {
  const s = summarize(c);
  const pct = s.known ? (s.studied / s.known * 100).toFixed(1) : '?';
  log('');
  log(`━━ ${c.course}（${s.chapters} 章 · ${s.lessons} 节 · 已完成 ${s.studied}/${s.known || '?'} · ${pct}%）`);
  if (c.source === 'dom') log('   ⚠️ 未捕获 videolist 响应，完成状态未知（仅列出 DOM 课节）');
  for (const ch of c.chapters) {
    log(`  ▸ ${ch.no} ${ch.name}`);
    for (const l of ch.lessons) {
      const mark = l.studied === true ? '✓' : l.studied === false ? '○' : '?';
      log(`     ${mark} ${String(l.no).padEnd(6)} ${String(l.time || hms(l.seconds)).padEnd(9)} ${l.title}`);
    }
  }
}

/* ═══════════════════════ 主流程 ═══════════════════════ */

const resolved = readJson(join(EXPORT, 'courses-resolved.json'), {});
const courseList = Object.entries(resolved)
  .map(([key, v]) => ({
    name: v?.courseName || key,
    entry: v || {},
  }))
  .filter((c) => !COURSE || c.name.includes(COURSE));

if (!courseList.length) {
  log('没有匹配的课程，检查 --course / export\\courses-resolved.json');
  process.exit(1);
}

log('══════════ 课程目录扫描 ══════════');
log(`课程: ${courseList.map((c) => c.name).join('、')}`);

const { ctx, describe, close } = await connect({
  prefer: getArg('--browser', 'chromium') === 'firefox' ? 'firefox' : 'chromium',
  exe: getArg('--browser-exe'),
});
log(`浏览器: ${describe}`);
log('提示: 若提示未登录，请先运行 node zhs.mjs login');

const page = ctx.pages().find((p) => p.url().includes('studyvideoh5')) ?? await ctx.newPage();

// 切课时平台可能弹「离开当前学习」确认；只放行非危险文案，避免导航被取消
const DIALOG_DENY_RE = /删除|清空|退出登录|注销|放弃|作废/;
page.on('dialog', (d) => {
  const msg = d.message() || '';
  const type = d.type();
  if ((type === 'alert' || type === 'confirm' || type === 'beforeunload') && !DIALOG_DENY_RE.test(msg)) d.accept().catch(() => {});
  else d.dismiss().catch(() => {});
});

// 旁听页面自身的 videolist 响应；每个课程页用 generation 隔离旧响应
let gen = 0;
let captured = null;
let sawVideolist = false;
let expect = { courseId: null, recruitId: null };
page.on('response', async (res) => {
  if (!res.url().includes('/learning/videolist')) return;
  sawVideolist = true;
  const at = gen;
  try {
    const j = await res.json();
    if (at !== gen) return;
    const d = j?.data;
    if (!d?.videoChapterDtos) return;
    // 切课前旧页面可能还有迟到的响应，按课程 ID 过滤，避免串课
    const rid = Number(d.recruitId) || 0;
    const cid = Number(d.courseId) || 0;
    if (rid && expect.recruitId && rid !== Number(expect.recruitId)) return;
    if (cid && expect.courseId && cid !== Number(expect.courseId)) return;
    captured = d;
  } catch { /* 非 JSON 忽略 */ }
});

const catalog = { at: new Date().toISOString(), courses: [] };
let failures = 0;

for (const { name, entry } of courseList) {
  const secret = entry?.secret;
  if (!secret) {
    log(`\n✗ ${name}：缺少 secret，请先运行 node zhs.mjs fetch`);
    failures++;
    catalog.courses.push({ course: name, courseId: entry?.courseId ?? null, recruitId: entry?.recruitId ?? null, source: 'none', chapters: [], error: '缺少 secret' });
    continue;
  }

  const url = `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${secret}`;
  gen++;
  captured = null;
  sawVideolist = false;
  expect = { courseId: entry?.courseId ?? null, recruitId: entry?.recruitId ?? null };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  // 等 videolist 或 DOM 课节，最多 40 秒
  let domLessons = [];
  for (let i = 0; i < 40; i++) {
    if (captured) break;
    domLessons = await page.evaluate(READ_DOM).catch(() => []);
    if (domLessons.length) {
      // 再给接口几秒，接口数据比 DOM 完整（含完成状态）
      if (i >= 8) break;
    }
    await sleep(1000);
  }

  let course;
  if (captured) {
    // 接口不返回完成状态，等目录渲染完后从 DOM 读一次标记
    domLessons = await page.evaluate(READ_DOM).catch(() => []);
    course = fromApi(captured, { name, courseId: entry.courseId, recruitId: entry.recruitId }, domLessons);
    if (!course.course) course.course = name;
  } else {
    domLessons = domLessons.length ? domLessons : await page.evaluate(READ_DOM).catch(() => []);
    if (!domLessons.length) {
      const diag = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        text: String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
      })).catch(() => null);
      log(`\n✗ ${name}：课节未加载（可能未登录）`);
      if (diag) log(`  页面: ${diag.url}\n  标题: ${diag.title}\n  内容: ${diag.text}`);
      log(`  videolist 响应: ${sawVideolist ? '已收到但无章节数据' : '未收到'}`);
      failures++;
      catalog.courses.push({ course: name, courseId: entry.courseId ?? null, recruitId: entry.recruitId ?? null, source: 'none', chapters: [], error: '课节未加载' });
      continue;
    }
    course = fromDom(domLessons, { name, courseId: entry.courseId, recruitId: entry.recruitId });
    course.course = name;
  }

  catalog.courses.push(course);
  if (!JSON_ONLY) printCourse(course);
}

writeJson(OUTFILE, catalog);

if (JSON_ONLY) {
  log(JSON.stringify(catalog, null, 2));
} else {
  log('');
  log(`目录已保存: export\\course-catalog.json`);
  for (const c of catalog.courses) {
    if (c.error) continue;
    const s = summarize(c);
    log(`  · ${c.course}：${s.lessons} 节，已完成 ${s.studied} 节`);
  }
}

if (!KEEP_TABS) await tidy(ctx).catch(() => {});
await close();

const okCourses = catalog.courses.filter((c) => !c.error).length;
if (!okCourses) {
  log('⚠️ 所有课程都未成功扫描');
  process.exit(1);
}
if (failures) log(`⚠️ 有 ${failures} 门课程未扫到，可用 --course 单独重试`);
process.exit(0);
