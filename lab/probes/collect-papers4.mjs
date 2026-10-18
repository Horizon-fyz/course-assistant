// 批量抓题 v4：每份作业独立、带重试与硬超时，断点续跑
// 只进入试卷读取题目，绝不点击「提交作业」/「暂存作业」
import { writeFileSync, mkdirSync, existsSync, readFileSync, writeSync } from 'node:fs';
import { connect } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'export');
mkdirSync(OUT, { recursive: true });
const SAVE = OUT + '\\papers.json';
const log = (m) => { try { writeSync(1, m + '\n'); } catch { console.log(m); } };

const COURSES = [
  { name: '大学生心理健康教育', realRecruitId: 435122, courseId: 1000101708, schoolId: 5371, listRid: 'qdnlqk0hsU55bNK59Oo4Bg%3D%3D' },
  { name: '国家安全教育', realRecruitId: 428806, courseId: 1000120382, schoolId: 5371, listRid: 'IbhuH%2F%2Bb5MbiAG29T6RoXA%3D%3D' },
  { name: '思想道德与法治', realRecruitId: 453708, courseId: 1000070264, schoolId: 5371, listRid: 'EOqgk1o%2BZedyU2sIWgDgNQ%3D%3D' },
];
const LIST_URL = (rid) => `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=${rid}`;

const all = existsSync(SAVE) ? JSON.parse(readFileSync(SAVE, 'utf8')) : {};
const { browser, ctx } = await connect();
const page = await ctx.newPage();

/** 抓取单份作业试卷：进路由 → reload → 等 doHomework 响应，最多重试 2 次 */
async function grabPaper(url, timeout = 25000) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let resolveFn = null;
    const handler = async (r) => {
      if (!/student\/doHomework/.test(r.url())) return;
      let t = '';
      try { t = await r.text(); } catch { return; }
      if (resolveFn) { const f = resolveFn; resolveFn = null; f(t); }
    };
    page.on('response', handler);
    const p = new Promise((res) => { resolveFn = res; setTimeout(() => { if (resolveFn === res) { resolveFn = null; res(null); } }, timeout); });

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (attempt === 1) await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    } catch { /* 继续等响应 */ }

    const raw = await p;
    page.off('response', handler);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* 重试 */ }
    }
  }
  return null;
}

/** 取课程作业列表 */
async function fetchList(c) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let body = null;
    const onRes = async (r) => { if (/getStudentHomework/.test(r.url())) { try { body = await r.text(); } catch {} } };
    page.on('response', onRes);
    try {
      await page.goto(LIST_URL(c.listRid), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.reload({ waitUntil: 'networkidle', timeout: 45000 });
    } catch {}
    await page.waitForTimeout(9000);
    page.off('response', onRes);
    if (body) { try { const l = JSON.parse(body).rt.studentHomeworkList; if (l?.length) return l; } catch {} }
    log(`    列表获取重试 ${attempt}/3…`);
  }
  return [];
}

for (const c of COURSES) {
  const done = all[c.name] || [];
  const doneIds = new Set(done.filter((x) => x.paper).map((x) => x.id));
  if (done.length && doneIds.size === done.length && done.length >= 7) {
    log(`\n### ${c.name} —— 已完成 ${done.length} 份，跳过`);
    continue;
  }
  log(`\n########## ${c.name} ##########`);

  const items = await fetchList(c);
  log(`  作业数: ${items.length}`);
  if (!items.length) continue;

  const collected = [...done];
  for (const [i, hw] of items.entries()) {
    const exist = collected.find((x) => x.id === hw.id);
    if (exist?.paper) { log(`  [${String(i + 1).padStart(2)}/${items.length}] ${hw.examName} → 已有，跳过`); continue; }

    const url = `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/${c.realRecruitId}/${hw.id}/${hw.examId}/${c.courseId}/${c.schoolId}/${hw.meetCourseType ?? 0}`;
    const paper = await grabPaper(url);
    const base = paper?.rt?.examBase;
    const n = (base?.workExamParts || []).flatMap((x) => x.questionDtos || []).length;

    const idx = collected.findIndex((x) => x.id === hw.id);
    const rec = { ...hw, paper };
    if (idx >= 0) collected[idx] = rec; else collected.push(rec);

    all[c.name] = collected;
    writeFileSync(SAVE, JSON.stringify(all, null, 2), 'utf8');
    log(`  [${String(i + 1).padStart(2)}/${items.length}] ${hw.examName} → ${base ? `✓ ${n} 题` : '✗ 未捕获'}`);
    await page.waitForTimeout(800);
  }
  log(`  ✓ ${c.name}：${collected.filter((x) => x.paper).length}/${items.length} 份成功`);
}

log('\n\n================ 最终汇总 ================');
let tq = 0, th = 0, ok = 0;
for (const [n, list] of Object.entries(all)) {
  const q = list.reduce((a, x) => a + ((x.paper?.rt?.examBase?.workExamParts || []).flatMap((p) => p.questionDtos || []).length), 0);
  const o = list.filter((x) => x.paper).length;
  tq += q; th += list.length; ok += o;
  log(`  ${n.padEnd(14)} ${String(o).padStart(2)}/${String(list.length).padStart(2)} 份，${String(q).padStart(4)} 题`);
}
log(`  合计：${th} 份（成功 ${ok}），${tq} 题`);

await browser.close().catch(() => {});
process.exit(0);
