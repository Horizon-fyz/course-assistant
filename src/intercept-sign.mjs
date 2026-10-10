// 拦截应用自身的请求，抓取真实 secretStr 与请求体（供离线复用分析）
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'sign');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

const captured = [];

// 只拦截目标域，放行其余
await page.route('**/onlineservice-api.zhihuishu.com/**', async (route) => {
  const req = route.request();
  const u = new URL(req.url());
  const rec = {
    method: req.method(),
    path: u.pathname,
    query: u.search.slice(0, 500),
    secretStr: u.searchParams.get('secretStr'),
    date: u.searchParams.get('date'),
    postData: req.postData()?.slice(0, 800) || null,
    headers: { 'Content-Type': req.headers()['content-type'] || '', Authorization: req.headers()['authorization'] ? '(present)' : '(none)' },
  };
  captured.push(rec);
  await route.continue();
});

page.on('response', async (r) => {
  if (!r.url().includes('onlineservice-api.zhihuishu.com')) return;
  const u = new URL(r.url());
  const rec = captured.find((c) => c.path === u.pathname && !c.status);
  if (rec) {
    rec.status = r.status();
    try { rec.body = (await r.text()).slice(0, 600); } catch {}
  }
});

console.log('打开学生端并停留，让应用发起真实请求…');
await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(12000);

// 点一个课程菜单，触发更多接口（成绩分析等）
try {
  await page.getByText('成绩分析', { exact: true }).first().click({ timeout: 8000 });
  await page.waitForTimeout(8000);
} catch (e) { console.log('click:', String(e).slice(0, 100)); }

console.log('\n=== 截获请求 ===', captured.length);
for (const c of captured) {
  console.log(`\n[${c.status ?? '...'}] ${c.method} ${c.path}`);
  if (c.query) console.log('   query:', c.query.slice(0, 260));
  if (c.postData) console.log('   post :', c.postData.slice(0, 260));
  if (c.body) console.log('   body :', c.body.replace(/\s+/g, ' ').slice(0, 220));
  if (c.secretStr) console.log('   secretStr:', c.secretStr, ' date:', c.date);
}

writeFileSync(OUT + '\\intercepted.json', JSON.stringify(captured, null, 2));
console.log('\n已保存 intercepted.json');

await page.close().catch(() => {});
await browser.close().catch(() => {});
