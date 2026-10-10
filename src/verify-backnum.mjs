// 重新精确判定：进入试卷后 backNum / state 是否变化
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const LIST = 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=EOqgk1o%2BZedyU2sIWgDgNQ%3D%3D';
const TARGET_STU_ID = 'eglo6LgO'; // 绪论单元测试

const { browser, ctx } = await connect();
const page = await ctx.newPage();

let listBody = null;
page.on('response', async (r) => {
  const u = r.url();
  if (!/getStudentHomework/.test(u)) return;
  try { listBody = await r.text(); } catch {}
});

await page.goto(LIST, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(15000);

if (!listBody) {
  console.log('未捕获到 getStudentHomework 响应，尝试再等…');
  await page.waitForTimeout(10000);
}

let items = [];
if (listBody) {
  try { items = JSON.parse(listBody).rt.studentHomeworkList; } catch (e) { console.log('解析失败:', String(e).slice(0, 100)); }
}

console.log('=== 思想道德与法治 全部作业当前状态 ===');
for (const x of items) {
  const mark = x.id === TARGET_STU_ID ? '  <== 测试对象' : '';
  console.log(`  state=${x.state} backNum=${x.backNum} achieve=${x.achieve} score=${x.score} 题数=${x.problemNum}  ${x.examName}${mark}`);
}

const t = items.find((x) => x.id === TARGET_STU_ID);
console.log('\n=== 测试对象详情 ===');
console.log(JSON.stringify(t, null, 1));

// 与测试前记录对比（测试前 backNum=3, state=1, score=null）
console.log('\n========== 判定 ==========');
if (t) {
  console.log(`  backNum : 3 (测试前) → ${t.backNum} (测试后)   ${t.backNum === 3 ? '✅ 未消耗' : '⚠️ 已消耗'}`);
  console.log(`  state   : 1 (测试前) → ${t.state} (测试后)    ${t.state === 1 ? '（仍为未提交）' : '（状态已变）'}`);
  console.log(`  score   : null (测试前) → ${t.score} (测试后)`);
  console.log(`  achieve : ${t.achieve}`);
} else console.log('  未找到测试对象');

writeFileSync(OUT + '\\backnum-verdict.json', JSON.stringify({ items, target: t }, null, 2));
console.log('\n已保存 recon/exam/backnum-verdict.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
