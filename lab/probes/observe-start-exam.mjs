// 观察「开始答题」的完整网络行为（重点：是否消耗作答次数）
// 安全设计：只记录请求，不点击任何「提交」，并在发现破坏性请求后立即停止
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, tidy } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();

// 用国家安全教育（在线考试那门）的作业页，取一个有明确 backNum 的作业
const page = ctx.pages().find((p) => p.url().includes('onlineexamh5new')) ?? (await ctx.newPage());
console.log('页面:', page.url());

const api = [];
page.on('request', (r) => {
  const u = r.url();
  if (!/studentexam-api|taurusexam-api|onlineexamh5new/.test(u)) return;
  if (/\.(js|css|png|jpg|gif|woff2?|ico)(\?|$)/.test(u)) return;
  api.push({ method: r.method(), url: u.slice(0, 170), post: (r.postData() || '').slice(0, 500) });
});
page.on('response', async (r) => {
  const u = r.url();
  if (!/studentexam-api|taurusexam-api/.test(u)) return;
  const rec = api.find((c) => u.startsWith(c.url) && !c.status);
  if (!rec) return;
  rec.status = r.status();
  const ct = r.headers()['content-type'] || '';
  if (/json/.test(ct)) { try { rec.body = (await r.text()).slice(0, 800); } catch {} }
});

await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);

// 记录点击前的状态：作业列表里第一项的 id / examId / state
const beforeState = await page.evaluate(() => {
  const first = document.querySelector('[class*=item], li, tr');
  return {
    url: location.href,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200),
    hasStartBtn: !!document.querySelector('*'),
  };
});
const beforeCount = api.length;

console.log('\n点击第一个「开始答题」（只观察，不会提交）…');
let clicked = false;
try {
  await page.getByText('开始答题', { exact: true }).first().click({ timeout: 12000 });
  clicked = true;
} catch (e) { console.log('  click err:', String(e).slice(0, 120)); }
await page.waitForTimeout(12000);

const after = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500),
  // 题目元素
  qCount: document.querySelectorAll('[class*=question], [class*=topic], [class*=subject], .subject-item').length,
  radios: document.querySelectorAll('input[type=radio], input[type=checkbox]').length,
  // 是否出现"提交"按钮
  hasSubmit: [...document.querySelectorAll('button, a, [class*=btn]')].some((b) => /提交|交卷/.test(b.innerText || '')),
  buttons: [...new Set([...document.querySelectorAll('button, a, [class*=btn]')].map((b) => (b.innerText || '').trim()).filter((t) => t && t.length <= 14))].slice(0, 30),
  dialogs: [...document.querySelectorAll('[class*=dialog], [class*=modal], [class*=confirm]')].map((d) => (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 5),
}));

console.log('\n=== 点击后页面 ===');
console.log('  url:', after.url);
console.log('  title:', after.title);
console.log('  题干预元素:', after.qCount, '  选项输入:', after.radios, '  有提交按钮:', after.hasSubmit);
console.log('  按钮:', JSON.stringify(after.buttons));
if (after.dialogs.length) console.log('  弹层:', JSON.stringify(after.dialogs));
console.log('  正文:', after.text.slice(0, 600));

console.log('\n=== 点击后新请求（关键：看有无 startExam / 消耗次数）===');
for (const c of api.slice(beforeCount)) {
  console.log(`  [${c.status ?? '...'}] ${c.method} ${c.url}`);
  if (c.post) console.log('      post:', c.post.slice(0, 300));
  if (c.body) console.log('      body:', c.body.replace(/\s+/g, ' ').slice(0, 350));
}

// 二次确认：重新拉作业列表，看 backNum / state 是否变化
console.log('\n=== 复查作业列表状态（判断是否消耗次数）===');
await page.goto('https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=IbhuH%2F%2Bb5MbiAG29T6RoXA%3D%3D', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);
const recheck = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 700));
console.log('  ' + recheck);

writeFileSync(OUT + '\\start-click-observe.json', JSON.stringify({ clicked, beforeState, after, newApi: api.slice(beforeCount), recheck }, null, 2));
console.log('\n已保存 recon/exam/start-click-observe.json');

await page.screenshot({ path: OUT + '\\after-start-click.png' }).catch(() => {});
try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
