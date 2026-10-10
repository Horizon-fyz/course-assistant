// 批量抓题（只进入试卷、不提交）—— 3 门课全部作业
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'export');
mkdirSync(OUT, { recursive: true });

const COURSES = [
  { name: '大学生心理健康教育', recruitId: 1000101708, courseId: 1000101708, schoolId: 5371, listRid: 'qdnlqk0hsU55bNK59Oo4Bg%3D%3D', realRecruitId: 435122 },
  { name: '国家安全教育', recruitId: 1000120382, courseId: 1000120382, schoolId: 5371, listRid: 'IbhuH%2F%2Bb5MbiAG29T6RoXA%3D%3D', realRecruitId: 428806 },
  { name: '思想道德与法治', recruitId: 1000070264, courseId: 1000070264, schoolId: 5371, listRid: 'EOqgk1o%2BZedyU2sIWgDgNQ%3D%3D', realRecruitId: 453708 },
];

const { browser, ctx } = await connect();
const page = await ctx.newPage();

// 当前捕获目标
let waiting = null;
page.on('response', async (r) => {
  const u = r.url();
  if (!/student\/doHomework/.test(u)) return;
  let text = '';
  try { text = await r.text(); } catch { return; }
  if (waiting) { const w = waiting; waiting = null; w(text); }
});

function waitDoHomework(timeout = 40000) {
  return new Promise((resolve) => {
    waiting = resolve;
    setTimeout(() => { if (waiting === resolve) { waiting = null; resolve(null); } }, timeout);
  });
}

const all = {};

for (const c of COURSES) {
  console.log(`\n\n########## ${c.name} ##########`);

  // 1) 取作业列表
  const listUrl = `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=${c.listRid}`;
  let listBody = null;
  const onList = async (r) => {
    if (!/getStudentHomework/.test(r.url())) return;
    try { listBody = await r.text(); } catch {}
  };
  page.on('response', onList);
  await page.goto(listUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(13000);
  page.off('response', onList);

  let items = [];
  if (listBody) { try { items = JSON.parse(listBody).rt.studentHomeworkList; } catch {} }
  console.log(`  作业数: ${items.length}`);
  if (!items.length) { all[c.name] = []; continue; }

  const collected = [];

  for (const [i, hw] of items.entries()) {
    const url = `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/${c.realRecruitId}/${hw.id}/${hw.examId}/${c.courseId}/${c.schoolId}/${hw.meetCourseType ?? 0}`;
    process.stdout.write(`  [${i + 1}/${items.length}] ${hw.examName} … `);

    const p = waitDoHomework(40000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const raw = await p;

    if (!raw) { console.log('未捕获到试卷'); collected.push({ ...hw, paper: null }); continue; }

    let paper = null;
    try { paper = JSON.parse(raw); } catch {}
    const base = paper?.rt?.examBase;
    const qs = (base?.workExamParts || []).flatMap((p) => p.questionDtos || []);
    console.log(`${base?.name || '?'}  (${qs.length} 题)`);
    collected.push({ ...hw, paper });
    await page.waitForTimeout(1500);
  }

  all[c.name] = collected;
  writeFileSync(OUT + '\\papers.json', JSON.stringify(all, null, 2), 'utf8');
  console.log(`  ✓ ${c.name} 完成，累计已保存`);
}

// 统计
console.log('\n\n================ 抓取汇总 ================');
let totalQ = 0;
for (const [name, list] of Object.entries(all)) {
  const q = list.reduce((a, x) => a + ((x.paper?.rt?.examBase?.workExamParts || []).flatMap((p) => p.questionDtos || []).length), 0);
  totalQ += q;
  console.log(`  ${name.padEnd(14)} 作业 ${String(list.length).padStart(2)} 份，题目 ${String(q).padStart(3)} 道`);
}
console.log(`  合计题目: ${totalQ} 道`);
console.log('\n已保存 export/papers.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
