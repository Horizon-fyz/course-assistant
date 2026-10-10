// 检查当前 CDP 浏览器状态：是否已登录
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

mkdirSync(join(ROOT, 'recon', 'cdp'), { recursive: true });
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

console.log('=== 全部标签页 ===');
for (const [i, p] of ctx.pages().entries()) {
  console.log(`  [${i}] ${p.url()}`);
}

const page = ctx.pages()[ctx.pages().length - 1];
console.log('\n=== 最后标签页详情 ===');
console.log('url:', page.url());
console.log('title:', await page.title().catch(() => '(n/a)'));

const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  hasAccountTab: !!document.body.innerText.match(/账号登录/),
  hasStuTab: !!document.body.innerText.match(/学号登录/),
  hasQr: !!document.body.innerText.match(/扫码/),
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 900),
  cookies: document.cookie.slice(0, 400),
  localStorageKeys: Object.keys(localStorage).slice(0, 30),
}));
console.log(JSON.stringify(info, null, 1));

await page.screenshot({ path: join(ROOT, 'recon', 'cdp', 'current-state.png') });

// 所有智慧树 cookie
const cookies = await ctx.cookies();
const zhs = cookies.filter((c) => /zhihuishu|polymas/.test(c.domain));
console.log('\n=== 智慧树 cookie ===');
for (const c of zhs) console.log(`  ${c.domain.padEnd(36)} ${c.name.padEnd(28)} len=${(c.value || '').length}`);

await browser.close().catch(() => {});
