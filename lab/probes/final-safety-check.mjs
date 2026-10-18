// 最终安全验证：全部作业的 state / backNum / score 是否仍与抓取前一致
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { connect, tidy } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const LIST = {
  '大学生心理健康教育': 'qdnlqk0hsU55bNK59Oo4Bg%3D%3D',
  '国家安全教育': 'IbhuH%2F%2Bb5MbiAG29T6RoXA%3D%3D',
  '思想道德与法治': 'EOqgk1o%2BZedyU2sIWgDgNQ%3D%3D',
};

const { browser, ctx } = await connect();
const results = {};

for (const [course, rid] of Object.entries(LIST)) {
  const page = await ctx.newPage();
  let body = null;
  const onRes = async (r) => { if (/getStudentHomework/.test(r.url())) { try { body = await r.text(); } catch {} } };
  page.on('response', onRes);

  for (let attempt = 1; attempt <= 4 && !body; attempt++) {
    await page.goto(`https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=${rid}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.reload({ waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(9000);
  }
  page.off('response', onRes);

  let items = [];
  if (body) { try { items = JSON.parse(body).rt.studentHomeworkList; } catch {} }

  console.log(`\n########## ${course}（${items.length} 份）##########`);
  let bad = 0;
  for (const x of items) {
    // 抓取前基准：state=1, backNum=3, score=null, achieve=0
    const unchanged = x.state === 1 && x.backNum === 3 && x.score === null;
    if (!unchanged) bad++;
    console.log(`  ${unchanged ? '✅' : '⚠️ '} state=${x.state} backNum=${x.backNum} score=${x.score} achieve=${x.achieve}  ${x.examName}`);
  }
  results[course] = { items, violations: bad };
  await page.close().catch(() => {});
}

console.log('\n\n================ 安全验证结论 ================');
let totalBad = 0, total = 0;
for (const [c, r] of Object.entries(results)) {
  totalBad += r.violations; total += r.items.length;
  console.log(`  ${c.padEnd(14)} ${r.items.length} 份，异常 ${r.violations} 份`);
}
console.log(`\n  总计 ${total} 份作业，异常 ${totalBad} 份`);
console.log(totalBad === 0
  ? '  ✅ 全部作业仍为「未提交」，作答次数 backNum 均为 3，未产生任何提交'
  : '  ⚠️ 存在状态变化，需人工核查');

writeFileSync(OUT + '\\final-safety-check.json', JSON.stringify(results, null, 2));
console.log('\n已保存 recon/exam/final-safety-check.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
