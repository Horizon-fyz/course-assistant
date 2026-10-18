// 批量抓题 v2：每份作业强制整页重载，确保组件重新取题（仍然只进入、绝不提交）
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { connect, tidy } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'export');
mkdirSync(OUT, { recursive: true });
const SAVE = OUT + '\\papers.json';

const COURSES = [
  { name: '大学生心理健康教育', realRecruitId: 435122, courseId: 1000101708, schoolId: 5371, listRid: 'qdnlqk0hsU55bNK59Oo4Bg%3D%3D' },
  { name: '国家安全教育', realRecruitId: 428806, courseId: 1000120382, schoolId: 5371, listRid: 'IbhuH%2F%2Bb5MbiAG29T6RoXA%3D%3D' },
  { name: '思想道德与法治', realRecruitId: 453708, courseId: 1000070264, schoolId: 5371, listRid: 'EOqgk1o%2BZedyU2sIWgDgNQ%3D%3D' },
];

// 支持断点续跑
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

function waitDoHomework(timeout = 30000) {
  return new Promise((resolve) => {
    waiter = resolve;
    setTimeout(() => { if (waiter === resolve) { waiter = null; resolve(null); } }, timeout);
  });
}

/** 取某门课的作业列表 */
async function fetchList(c) {
  let body = null;
  const onRes = async (r) => {
    if (!/getStudentHomework/.test(r.url())) return;
    try { body = await r.text(); } catch {}
  };
  page.on('response', onRes);
  await page.goto(`https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=${c.listRid}`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  // 强制整页重载，确保路由初始化
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(11000);
  page.off('response', onRes);
  if (!body) return [];
  try { return JSON.parse(body).rt.studentHomeworkList || []; } catch { return []; }
}

for (const c of COURSES) {
  if (all[c.name] && all[c.name].length) {
    console.log(`\n########## ${c.name} —— 已有数据，跳过 ##########`);
    continue;
  }
  console.log(`\n########## ${c.name} ##########`);

  const items = await fetchList(c);
  console.log(`  作业数: ${items.length}`);
  if (!items.length) { all[c.name] = []; continue; }

  const collected = [];
  for (const [i, hw] of items.entries()) {
    const url = `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/${c.realRecruitId}/${hw.id}/${hw.examId}/${c.courseId}/${c.schoolId}/${hw.meetCourseType ?? 0}`;
    process.stdout.write(`  [${String(i + 1).padStart(2)}/${items.length}] ${hw.examName} … `);

    const p = waitDoHomework(30000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    // 关键：整页 reload，让 Vue 重新实例化组件并重新取题
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const raw = await p;

    if (!raw) { console.log('✗ 未捕获'); collected.push({ ...hw, paper: null }); continue; }

    let paper = null;
    try { paper = JSON.parse(raw); } catch {}
    const base = paper?.rt?.examBase;
    const qs = (base?.workExamParts || []).flatMap((x) => x.questionDtos || []);
    console.log(`✓ ${base?.name || '?'} (${qs.length} 题)`);
    collected.push({ ...hw, paper });

    // 每抓 3 份就落盘，防中断丢数据
    if (collected.length % 3 === 0) {
      all[c.name] = collected;
      writeFileSync(SAVE, JSON.stringify(all, null, 2), 'utf8');
    }
    await page.waitForTimeout(1200);
  }

  all[c.name] = collected;
  writeFileSync(SAVE, JSON.stringify(all, null, 2), 'utf8');
  console.log(`  ✓ ${c.name} 完成`);
}

// ---------- 汇总 ----------
console.log('\n\n================ 抓取汇总 ================');
let totalQ = 0, totalHw = 0, okHw = 0;
for (const [name, list] of Object.entries(all)) {
  const q = list.reduce((a, x) => a + ((x.paper?.rt?.examBase?.workExamParts || []).flatMap((p) => p.questionDtos || []).length), 0);
  const ok = list.filter((x) => x.paper).length;
  totalQ += q; totalHw += list.length; okHw += ok;
  console.log(`  ${name.padEnd(14)} 作业 ${String(list.length).padStart(2)} 份（成功 ${String(ok).padStart(2)}），题目 ${String(q).padStart(4)} 道`);
}
console.log(`  ────────────────────────────────`);
console.log(`  合计：${totalHw} 份作业（成功 ${okHw}），${totalQ} 道题目`);
console.log('\n已保存 export/papers.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
