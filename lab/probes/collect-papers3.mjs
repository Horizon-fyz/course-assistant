// 批量抓题 v3：无缓冲日志 + 每份立即落盘 + 断点续跑
// 原则：只进入试卷读取题目，绝不点击「提交作业」/「暂存作业」
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

const all = existsSync(SAVE) ? JSON.parse(readFileSync(SAVE, 'utf8')) : {};

const { browser, ctx } = await connect();
const page = await ctx.newPage();

let waiter = null;
page.on('response', async (r) => {
  if (!/student\/doHomework/.test(r.url())) return;
  let text = '';
  try { text = await r.text(); } catch { return; }
  if (waiter) { const w = waiter; waiter = null; w(text); }
});

function waitDo(timeout = 30000) {
  return new Promise((resolve) => {
    waiter = resolve;
    setTimeout(() => { if (waiter === resolve) { waiter = null; resolve(null); } }, timeout);
  });
}

async function fetchList(c) {
  let body = null;
  const onRes = async (r) => { if (/getStudentHomework/.test(r.url())) { try { body = await r.text(); } catch {} } };
  page.on('response', onRes);
  await page.goto(`https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=${c.listRid}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(10000);
  page.off('response', onRes);
  if (!body) return [];
  try { return JSON.parse(body).rt.studentHomeworkList || []; } catch { return []; }
}

for (const c of COURSES) {
  if (all[c.name]?.length) { log(`\n### ${c.name} —— 已完成，跳过`); continue; }
  log(`\n########## ${c.name} ##########`);

  const items = await fetchList(c);
  log(`  作业数: ${items.length}`);
  if (!items.length) { all[c.name] = []; writeFileSync(SAVE, JSON.stringify(all, null, 2), 'utf8'); continue; }

  const collected = [];
  for (const [i, hw] of items.entries()) {
    const url = `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/${c.realRecruitId}/${hw.id}/${hw.examId}/${c.courseId}/${c.schoolId}/${hw.meetCourseType ?? 0}`;
    const p = waitDo(30000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const raw = await p;

    let paper = null;
    try { paper = JSON.parse(raw || ''); } catch {}
    const base = paper?.rt?.examBase;
    const qs = (base?.workExamParts || []).flatMap((x) => x.questionDtos || []);
    collected.push({ ...hw, paper });

    all[c.name] = collected;
    writeFileSync(SAVE, JSON.stringify(all, null, 2), 'utf8');   // 每份立即落盘

    log(`  [${String(i + 1).padStart(2)}/${items.length}] ${hw.examName}  →  ${base ? `✓ ${base.name} (${qs.length} 题)` : '✗ 未捕获'}`);
    await page.waitForTimeout(1000);
  }
  log(`  ✓ ${c.name} 完成（${collected.filter((x) => x.paper).length}/${items.length} 份成功）`);
}

log('\n\n================ 抓取汇总 ================');
let tq = 0, th = 0, ok = 0;
for (const [n, list] of Object.entries(all)) {
  const q = list.reduce((a, x) => a + ((x.paper?.rt?.examBase?.workExamParts || []).flatMap((p) => p.questionDtos || []).length), 0);
  const o = list.filter((x) => x.paper).length;
  tq += q; th += list.length; ok += o;
  log(`  ${n.padEnd(14)} 作业 ${String(list.length).padStart(2)} 份（成功 ${String(o).padStart(2)}），题目 ${String(q).padStart(4)} 道`);
}
log(`  合计：${th} 份（成功 ${ok}），${tq} 道题目`);
log('已保存 export/papers.json');

await browser.close().catch(() => {});
process.exit(0);
