// 侦察「学前必读」弹窗：内容、关闭方式、以及它背后调用了什么接口
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy, HOME } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'dialog');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = await readyPage(ctx, HOME);

const calls = [];
page.on('request', (r) => {
  const u = r.url();
  if (/zhihuishu|polymas/.test(u) && !/\.(js|css|png|jpg|gif|woff2?|ico|mp4)(\?|$)/.test(u)) {
    calls.push({ method: r.method(), url: u.slice(0, 160), post: (r.postData() || '').slice(0, 600) });
  }
});
page.on('response', async (r) => {
  const u = r.url();
  const rec = calls.find((c) => u.startsWith(c.url) && !c.status);
  if (!rec) return;
  rec.status = r.status();
  const ct = r.headers()['content-type'] || '';
  if (/json|text/.test(ct)) { try { rec.body = (await r.text()).slice(0, 900); } catch {} }
});

await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

// 点进「大学生心理健康教育」
console.log('点击课程…');
try {
  await page.locator('text=大学生心理健康教育').first().click({ timeout: 10000 });
} catch (e) { console.log('  click err:', String(e).slice(0, 110)); }
await page.waitForTimeout(9000);

// 抓所有可见的弹层/对话框
const dialogs = await page.evaluate(() => {
  const out = [];
  const sel = ['.el-dialog', '.el-dialog__wrapper', '.el-message-box', '.guide-dialog', '[class*=dialog]', '[class*=popup]', '[class*=mask]', '[role=dialog]'];
  const seen = new Set();
  for (const s of sel) {
    for (const el of document.querySelectorAll(s)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect();
      const visible = (r.width > 0 && r.height > 0) && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
      if (!visible) continue;
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!text) continue;
      out.push({
        cls: (el.className || '').toString().slice(0, 90),
        w: Math.round(r.width), h: Math.round(r.height),
        text,
        buttons: [...el.querySelectorAll('button, .el-button, [class*=btn], a')].map((b) => (b.innerText || '').trim()).filter(Boolean).slice(0, 10),
      });
    }
  }
  return out;
});

console.log('\n=== 可见弹层 ===', dialogs.length);
for (const d of dialogs) {
  console.log(`\n[${d.w}x${d.h}] class=${d.cls}`);
  console.log('  文字:', d.text.slice(0, 260));
  console.log('  按钮:', JSON.stringify(d.buttons));
}

console.log('\n=== 相关接口 ===');
for (const c of calls) {
  if (!/login|course|learn|note|guide|dialog|popup|read|study|hash|before|notice|remind/i.test(c.url)) continue;
  console.log(`[${c.status ?? '...'}] ${c.method} ${c.url}`);
  if (c.post) console.log('   post:', c.post.slice(0, 260));
  if (c.body) console.log('   body:', c.body.replace(/\s+/g, ' ').slice(0, 300));
}

await page.screenshot({ path: OUT + '\\dialog.png' });
writeFileSync(OUT + '\\dialog.json', JSON.stringify({ dialogs, calls, url: page.url(), text: await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 800)) }, null, 2));
console.log('\n已保存 recon/dialog/');

await tidy(ctx);
await browser.close().catch(() => {});
