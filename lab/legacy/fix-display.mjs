// 修复浏览器显示：关掉空白/重复标签，把真实页面切到前台
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

mkdirSync(join(ROOT, 'recon', 'render'), { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

const pages = ctx.pages();
console.log('修复前标签页:', pages.map((p) => p.url().slice(0, 70)));

const GOOD = (u) => /zhihuishu\.com/.test(u) && !/^about:/.test(u);

// 1) 关掉所有空白页
for (const p of ctx.pages()) {
  const u = p.url();
  if (u === 'about:blank' || u === '') {
    console.log('  关闭空白页:', u || '(空)');
    await p.close().catch(() => {});
  }
}

// 2) 同一 URL 只保留一个，其余关闭
const seen = new Map();
for (const p of ctx.pages()) {
  const u = p.url();
  if (!GOOD(u)) continue;
  if (seen.has(u)) {
    console.log('  关闭重复页:', u.slice(0, 70));
    await p.close().catch(() => {});
  } else {
    seen.set(u, p);
  }
}

// 3) 确保有一个学生首页，并把它切到前台
let home = ctx.pages().find((p) => p.url().includes('onlineweb.zhihuishu.com/onlinestuh5'));
if (!home) {
  home = await ctx.newPage();
  await home.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await home.waitForTimeout(5000);
}
await home.bringToFront();
await home.waitForTimeout(2500);

// 4) 校验：页面确实有内容
const chk = await home.evaluate(() => ({
  url: location.href,
  title: document.title,
  textLen: document.body.innerText.length,
  sample: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120),
}));
console.log('\n前台页面:', JSON.stringify(chk, null, 1));

console.log('\n修复后标签页:');
for (const p of ctx.pages()) console.log('  -', p.url().slice(0, 80));

await home.screenshot({ path: join(ROOT, 'recon', 'render', 'after-fix.png') }).catch(() => {});
await browser.close().catch(() => {});
