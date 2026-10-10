// 确认登录态并导出会话
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'session');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('onlineweb.zhihuishu.com')) ?? ctx.pages()[0];

console.log('=== 检查标签页 ===', page.url());
await page.waitForTimeout(2000);

const info = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1200),
  localStorageKeys: Object.keys(localStorage),
  sessionStorageKeys: Object.keys(sessionStorage),
}));
console.log('title:', info.title);
console.log('localStorage keys:', JSON.stringify(info.localStorageKeys));
console.log('\n--- 页面文本 ---\n', info.bodyText);

await page.screenshot({ path: OUT + '\\student-home-cdp.png', fullPage: false });

// 关键：调后端接口验证会话真的有效
const verify = await page.evaluate(async () => {
  const out = {};
  try {
    const r1 = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
    out.getLoginUserInfo = { status: r1.status, body: (await r1.text()).slice(0, 800) };
  } catch (e) { out.getLoginUserInfo = { error: String(e) }; }
  try {
    const r2 = await fetch('https://onlineservice-api.zhihuishu.com/gateway/t/v1/teacher/index2/queryIdentity', { credentials: 'include' });
    out.queryIdentity = { status: r2.status, body: (await r2.text()).slice(0, 800) };
  } catch (e) { out.queryIdentity = { error: String(e) }; }
  return out;
});
console.log('\n=== 接口验证 ===');
console.log(JSON.stringify(verify, null, 1));

const cookies = await ctx.cookies();
const zhs = cookies.filter((c) => /zhihuishu|polymas/.test(c.domain));
writeFileSync(OUT + '\\cookies.json', JSON.stringify(cookies, null, 2));
await ctx.storageState({ path: OUT + '\\storage-state.json' });

console.log('\n=== 智慧树 cookie（共 ' + zhs.length + ' 条）===');
for (const c of zhs) console.log(`  ${c.domain.padEnd(38)} ${c.name.padEnd(30)} len=${(c.value || '').length} httpOnly=${c.httpOnly}`);

await browser.close().catch(() => {});
