// 打通视频学习 / 课程资料 / 成绩 等核心接口
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'api');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

// ---------- 1) 视频学习站：截获 queryCourse / videolist 的真实请求体 ----------
const page = await ctx.newPage();
const cap = [];
await page.route('**/studyservice-api.zhihuishu.com/**', async (route) => {
  const req = route.request();
  cap.push({ method: req.method(), url: req.url().slice(0, 300), post: req.postData()?.slice(0, 1000) || null, ct: req.headers()['content-type'] || '' });
  await route.continue();
});
page.on('response', async (r) => {
  if (!r.url().includes('studyservice-api')) return;
  const rec = cap.find((c) => c.url.startsWith(r.url().slice(0, 300)) && !c.status);
  if (rec) { rec.status = r.status(); try { rec.body = (await r.text()).slice(0, 1500); } catch {} }
});

console.log('打开视频学习页…');
await page.goto('https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=4e5b5c59475b4859454a585858445e4350', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(12000);

const pageText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500)).catch(() => '');
console.log('\n=== 视频学习页文本 ===\n' + pageText);

console.log('\n=== studyservice-api 请求 ===');
for (const c of cap) {
  console.log(`\n[${c.status ?? '...'}] ${c.method} ${c.url}`);
  if (c.ct) console.log('   ct:', c.ct);
  if (c.post) console.log('   post:', c.post.slice(0, 700));
  if (c.body) console.log('   body:', c.body.replace(/\s+/g, ' ').slice(0, 700));
}
writeFileSync(OUT + '\\studyservice-calls.json', JSON.stringify(cap, null, 2));

// ---------- 2) 课程资料 / 成绩分析（同域页面，直接 fetch 无跨域问题）----------
const p2 = await ctx.newPage();
const cap2 = [];
p2.on('response', async (r) => {
  const u = r.url();
  if (/stuonline\.zhihuishu\.com/.test(u) && /json|api|query|list|folder|report/i.test(u)) {
    let body = '';
    try { body = (await r.text()).slice(0, 800); } catch {}
    cap2.push({ status: r.status(), url: u.slice(0, 260), body });
  }
});

console.log('\n\n打开课程资料页…');
await p2.goto('https://stuonline.zhihuishu.com/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708', { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => console.log('goto:', String(e).slice(0, 100)));
await p2.waitForTimeout(10000);
const folderText = await p2.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200)).catch(() => '');
console.log('\n=== 课程资料页文本 ===\n' + folderText);

console.log('\n\n打开成绩分析页…');
await p2.goto('https://stuonline.zhihuishu.com/stuonline/stuLearnReportNew/index?recruitId=435122&courseId=1000101708', { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => console.log('goto:', String(e).slice(0, 100)));
await p2.waitForTimeout(10000);
const scoreText = await p2.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 1500)).catch(() => '');
console.log('\n=== 成绩分析页文本 ===\n' + scoreText);
await p2.screenshot({ path: OUT + '\\score-page.png', fullPage: false }).catch(() => {});

console.log('\n=== stuonline 接口 ===');
for (const c of cap2) console.log(`[${c.status}] ${c.url}\n   ${c.body.replace(/\s+/g, ' ').slice(0, 300)}`);
writeFileSync(OUT + '\\stuonline-calls.json', JSON.stringify(cap2, null, 2));

await page.close().catch(() => {});
await p2.close().catch(() => {});
await browser.close().catch(() => {});
