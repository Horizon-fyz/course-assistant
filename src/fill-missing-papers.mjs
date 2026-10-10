// 补齐缺失作业（用已知 ID 直接进入试卷路由，跳过列表接口）
// 仍只进入试卷读取题目，绝不提交
import { writeFileSync, mkdirSync, existsSync, readFileSync, writeSync } from 'node:fs';
import { connect } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'export');
const SAVE = OUT + '\\papers.json';
const log = (m) => { try { writeSync(1, m + '\n'); } catch { console.log(m); } };

// 缺失项（来自此前 getStudentHomework 的真实返回）
const TASKS = [
  { course: '国家安全教育', realRecruitId: 428806, courseId: 1000120382, schoolId: 5371,
    items: [
      { id: '5pQxg4L2', examId: 'wM3VxqB5', examName: '第九章单元测试', meetCourseType: 0, endDate: '2026-11-14 23:59:59', problemNum: 5, totalScore: '10', cpOrderNumber: '第九章' },
      { id: 'wb4ZYBOR', examId: 'yOk41o0y', examName: '第十章单元测试', meetCourseType: 0, endDate: '2026-11-14 23:59:59', problemNum: 5, totalScore: '10', cpOrderNumber: '第十章' },
    ] },
  { course: '思想道德与法治', realRecruitId: 453708, courseId: 1000070264, schoolId: 5371,
    items: [
      { id: 'eglo6LgO', examId: 'wKEgOnL5', examName: '绪论单元测试', meetCourseType: 0, endDate: '2026-12-31 23:59:59', problemNum: 1, totalScore: '2', cpOrderNumber: '绪论' },
      { id: 'ePK02QbB', examId: 'yqk4n2oe', examName: '第一章单元测试', meetCourseType: 0, endDate: '2026-12-31 23:59:59', problemNum: 10, totalScore: '20', cpOrderNumber: '第一章' },
      { id: 'w1Oa6N71', examId: '5XGW8Kpe', examName: '第二章单元测试', meetCourseType: 0, endDate: '2026-12-31 23:59:59', problemNum: 10, totalScore: '20', cpOrderNumber: '第二章' },
      { id: 'edqB14RP', examId: 'wEnOqAqe', examName: '第三章单元测试', meetCourseType: 0, endDate: '2026-12-31 23:59:59', problemNum: 10, totalScore: '20', cpOrderNumber: '第三章' },
      { id: '56XaQVW0', examId: 'e9XjQoVw', examName: '第四章单元测试', meetCourseType: 0, endDate: '2026-12-31 23:59:59', problemNum: 10, totalScore: '23', cpOrderNumber: '第四章' },
      { id: 'eAlvPxJA', examId: '5j9Nkzre', examName: '第五章单元测试', meetCourseType: 0, endDate: '2026-12-31 23:59:59', problemNum: 10, totalScore: '20', cpOrderNumber: '第五章' },
      { id: 'eBnWgpN6', examId: 'w3ZJ7Vly', examName: '第六章单元测试', meetCourseType: 0, endDate: '2026-12-31 23:59:59', problemNum: 10, totalScore: '20', cpOrderNumber: '第六章' },
    ] },
];

const all = existsSync(SAVE) ? JSON.parse(readFileSync(SAVE, 'utf8')) : {};
const { browser, ctx } = await connect();
const page = await ctx.newPage();

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
    } catch {}
    const raw = await p;
    page.off('response', handler);
    if (raw) { try { return JSON.parse(raw); } catch {} }
    log(`      重试 ${attempt}/3…`);
  }
  return null;
}

for (const t of TASKS) {
  log(`\n########## ${t.course} ##########`);
  const collected = all[t.course] || [];
  for (const hw of t.items) {
    const exist = collected.find((x) => x.id === hw.id);
    if (exist?.paper) { log(`  ${hw.examName} → 已有，跳过`); continue; }

    const url = `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/${t.realRecruitId}/${hw.id}/${hw.examId}/${t.courseId}/${t.schoolId}/${hw.meetCourseType}`;
    const paper = await grabPaper(url);
    const base = paper?.rt?.examBase;
    const n = (base?.workExamParts || []).flatMap((x) => x.questionDtos || []).length;

    const i = collected.findIndex((x) => x.id === hw.id);
    const rec = { ...hw, paper };
    if (i >= 0) collected[i] = rec; else collected.push(rec);

    all[t.course] = collected;
    writeFileSync(SAVE, JSON.stringify(all, null, 2), 'utf8');
    log(`  ${hw.examName} → ${base ? `✓ ${n} 题` : '✗ 未捕获'}`);
    await page.waitForTimeout(700);
  }
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
