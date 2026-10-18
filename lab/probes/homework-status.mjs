// 取作业列表完整状态，找出「已提交」的作业（回顾零风险）
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, tidy } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = ctx.pages().find((p) => p.url().includes('onlineexamh5new')) ?? (await ctx.newPage());

const captured = [];
page.on('response', async (r) => {
  const u = r.url();
  if (!/studentexam-api|taurusexam-api/.test(u)) return;
  const ct = r.headers()['content-type'] || '';
  if (!/json/.test(ct)) return;
  let body = '';
  try { body = await r.text(); } catch {}
  if (/studentHomeworkList|getStudentFinalExam/.test(body)) captured.push({ url: u.slice(0, 140), body });
});

// 三门课各拉一遍列表
const RIDS = [
  ['大学生心理健康教育', 'qdnlqk0hsU55bNK59Oo4Bg%3D%3D'],
  ['国家安全教育', 'IbhuH%2F%2Bb5MbiAG29T6RoXA%3D%3D'],
  ['思想道德与法治', 'EOqgk1o%2BZedyU2sIWgDgNQ%3D%3D'],
];

const summary = {};
for (const [name, rid] of RIDS) {
  console.log(`\n########## ${name} ##########`);
  await page.goto(`https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=${rid}`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);

  // 页面上的「未提交 / 已提交」切换与条目
  const view = await page.evaluate(() => {
    const items = [...document.querySelectorAll('[class*=examItemWrap], [class*=item]')]
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => /单元测试|考试|作业|提交/.test(t)).slice(0, 20);
    const tabs = [...document.querySelectorAll('[class*=tab], li, span, a')]
      .map((e) => (e.innerText || '').trim())
      .filter((t) => /未提交|已提交|全部/.test(t) && t.length <= 8);
    return { items, tabs: [...new Set(tabs)], text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 400) };
  });
  console.log('  标签:', JSON.stringify(view.tabs));
  console.log('  条目数:', view.items.length);
  for (const it of view.items.slice(0, 8)) console.log('    ·', it.slice(0, 140));

  summary[name] = { rid, view };
}

// 解析捕获到的作业列表 JSON
console.log('\n\n========== 作业状态明细 ==========');
const detail = {};
for (const c of captured) {
  let j = null;
  try { j = JSON.parse(c.body); } catch { continue; }
  const list = j?.rt?.studentHomeworkList;
  if (!Array.isArray(list)) continue;
  if (!list.length) continue;
  const course = list[0].courseName;
  if (detail[course]) continue;
  detail[course] = list.map((x) => ({
    examName: x.examName, stuExamId: x.id, examId: x.examId, state: x.state,
    score: x.score, backNum: x.backNum, problemNum: x.problemNum,
    totalScore: x.totalScore, endDate: x.endDate, isCheckAnswer: x.isCheckAnswer,
    achieve: x.achieve, courseId: x.courseId, chapterId: x.chapterId,
  }));
  console.log(`\n--- ${course} --- 共 ${list.length} 项`);
  for (const it of detail[course]) {
    console.log(`  state=${it.state} backNum=${it.backNum} score=${it.score} 题目=${it.problemNum} ${it.examName} (stuExamId=${it.stuExamId}, examId=${it.examId})`);
  }
}

writeFileSync(OUT + '\\homework-status.json', JSON.stringify({ summary, detail }, null, 2));
console.log('\n已保存 recon/exam/homework-status.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
