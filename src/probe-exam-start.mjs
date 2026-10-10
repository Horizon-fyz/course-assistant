// 探查「开始答题」的数据链路 —— 只读取题目数据，绝不提交
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();

// 用「思想道德与法治」的作业考试页（作业最多，代表性好）
const page = ctx.pages().find((p) => p.url().includes('onlineexamh5new')) ?? (await ctx.newPage());
console.log('使用页面:', page.url());

const api = [];
const onReq = (r) => {
  const u = r.url();
  if (!/zhihuishu/.test(u) || /\.(js|css|png|jpg|gif|woff2?|ico)(\?|$)/.test(u)) return;
  api.push({ method: r.method(), url: u.slice(0, 170), post: (r.postData() || '').slice(0, 400) });
};
page.on('request', onReq);

const responses = [];
page.on('response', async (r) => {
  const u = r.url();
  if (!/studentexam-api|taurusexam-api/.test(u)) return;
  const ct = r.headers()['content-type'] || '';
  if (!/json/.test(ct)) return;
  let body = '';
  try { body = (await r.text()).slice(0, 2000); } catch {}
  if (/question|paper|answer|exam/i.test(u) || /question|answer|option/i.test(body)) {
    responses.push({ url: u.slice(0, 170), status: r.status(), body });
  }
});

await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);

const before = api.length;
console.log('\n点击第一个「开始答题」…（不提交任何答案）');
try {
  const btn = page.getByText('开始答题', { exact: true }).first();
  await btn.click({ timeout: 12000 });
  await page.waitForTimeout(12000);
} catch (e) { console.log('  click err:', String(e).slice(0, 120)); }

const state = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200),
  // 是否有题干预元素
  questionNodes: document.querySelectorAll('[class*=question], [class*=subject], [class*=topic], [class*=paper]').length,
  optionNodes: document.querySelectorAll('[class*=option], input[type=radio], input[type=checkbox]').length,
  buttons: [...new Set([...document.querySelectorAll('button, a, [class*=btn]')].map((e) => (e.innerText || '').trim()).filter((t) => t && t.length <= 14))].slice(0, 25),
}));

console.log('\n=== 点击后状态 ===');
console.log('  url:', state.url);
console.log('  title:', state.title);
console.log('  题干预元素数:', state.questionNodes, ' 选项/输入元素数:', state.optionNodes);
console.log('  按钮:', JSON.stringify(state.buttons));
console.log('  正文:', state.text.slice(0, 500));

console.log('\n=== 点击后新产生的接口 ===');
for (const c of api.slice(before)) {
  console.log(`  ${c.method} ${c.url}`);
  if (c.post) console.log('      post:', c.post.slice(0, 250));
}

console.log('\n=== 含题目/答案特征的响应 ===');
for (const r of responses) {
  console.log(`\n[${r.status}] ${r.url}`);
  console.log('   ', r.body.replace(/\s+/g, ' ').slice(0, 600));
}

writeFileSync(OUT + '\\exam-start-probe.json', JSON.stringify({ state, api: api.slice(before), responses }, null, 2));
console.log('\n已保存 recon/exam/exam-start-probe.json');

await page.screenshot({ path: OUT + '\\exam-start.png' }).catch(() => {});
page.off('request', onReq);
try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
