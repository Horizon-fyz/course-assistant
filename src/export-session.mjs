// 导出并校验会话：cookie jar + 各域 Cookie 头 + 会话新鲜度
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'session');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const cookies = await ctx.cookies();
writeFileSync(OUT + '\\cookies.json', JSON.stringify(cookies, null, 2));

// 生成每个关键域的 Cookie 请求头
const domains = [...new Set(cookies.map((c) => c.domain.replace(/^\./, '')))]
  .filter((d) => /zhihuishu|polymas/.test(d));
const headers = {};
for (const d of domains) {
  const parts = cookies
    .filter((c) => {
      const cd = c.domain.replace(/^\./, '');
      return cd === d || (c.domain.startsWith('.') && d.endsWith(cd));
    })
    .map((c) => `${c.name}=${c.value}`);
  if (parts.length) headers[d] = parts.join('; ');
}
writeFileSync(OUT + '\\cookie-headers.json', JSON.stringify(headers, null, 2));

console.log('cookie 总数:', cookies.length);
console.log('域数:', domains.length);
console.log('\n各域关键票据:');
const KEY = /SESSION|JSESSIONID|CASTGC|jt-cas|token|polymas-token/i;
for (const d of domains) {
  const keys = cookies.filter((c) => c.domain.replace(/^\./, '') === d && KEY.test(c.name)).map((c) => c.name);
  if (keys.length) console.log(`  ${d.padEnd(38)} ${keys.join(', ')}  (header len=${headers[d]?.length ?? 0})`);
}

// 会话有效性复核
const page = ctx.pages().find((p) => p.url().includes('onlineweb')) ?? (await ctx.newPage());
await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3000);
const chk = await page.evaluate(async () => {
  const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
  return { status: r.status, body: await r.text() };
});
console.log('\n会话复核:', JSON.stringify(chk));
const st = OUT + '\\storage-state.json';
try {
  await ctx.storageState({ path: st });
  console.log('storageState 已保存:', st);
} catch (e) {
  console.log('storageState 保存失败:', String(e).slice(0, 120));
}
await browser.close().catch(() => {});
