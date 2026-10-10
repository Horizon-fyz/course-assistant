// 逐课程直接调 getStudentHomework，取真实作业状态（用页面自身生成 secretStr）
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();

const RIDS = [
  ['大学生心理健康教育', 'qdnlqk0hsU55bNK59Oo4Bg%3D%3D'],
  ['国家安全教育', 'IbhuH%2F%2Bb5MbiAG29T6RoXA%3D%3D'],
  ['思想道德与法治', 'EOqgk1o%2BZedyU2sIWgDgNQ%3D%3D'],
];

const result = {};

for (const [name, rid] of RIDS) {
  console.log(`\n########## ${name} ##########`);
  const page = await ctx.newPage();

  const caps = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (!/studentexam-api|taurusexam-api/.test(u)) return;
    const ct = r.headers()['content-type'] || '';
    if (!/json/.test(ct)) return;
    let b = '';
    try { b = await r.text(); } catch {}
    if (/studentHomeworkList|getStudentFinalExam|getSingleRecruit/.test(b)) {
      caps.push({ url: u.slice(0, 130), body: b });
    }
  });

  await page.goto(`https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=${rid}`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(14000);

  // 校验页面确实是这门课
  const who = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 60));
  console.log('  页面:', who);

  const hw = caps.find((c) => { try { return Array.isArray(JSON.parse(c.body)?.rt?.studentHomeworkList); } catch { return false; } });
  const fx = caps.find((c) => { try { return Array.isArray(JSON.parse(c.body)?.rt); } catch { return false; } });

  let list = [];
  if (hw) { try { list = JSON.parse(hw.body).rt.studentHomeworkList; } catch {} }
  console.log(`  作业数: ${list.length}`);
  for (const x of list) {
    console.log(`    state=${x.state} backNum=${x.backNum} isCheckAnswer=${x.isCheckAnswer} score=${x.score} 题数=${x.problemNum}  ${x.examName}  [stuExamId=${x.id} examId=${x.examId}]`);
  }

  let final = [];
  if (fx) { try { const j = JSON.parse(fx.body); if (j.rt?.[0]?.examName) final = j.rt; } catch {} }
  if (final.length) {
    console.log('  期末考试:');
    for (const f of final) console.log(`    state=${f.state} 剩余次数=${f.faStudentExamRemainCount} 题数=${f.problemNum}  ${f.examName}  [${f.startTime} ~ ${f.endTime}]`);
  }

  result[name] = { rid, list, final };
  await page.close().catch(() => {});
}

writeFileSync(OUT + '\\homework-status2.json', JSON.stringify(result, null, 2));
console.log('\n已保存 recon/exam/homework-status2.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
