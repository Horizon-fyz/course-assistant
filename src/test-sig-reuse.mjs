// 实测 secretStr 复用：用截获的签名调用 queryShareCourseInfo
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('onlineweb')) ?? (await ctx.newPage());
await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

const res = await page.evaluate(async () => {
  const out = {};
  const SIG = 'NEuH3llD9woD4DQgu0k6Uvp5yyo8WT84Dq5lU2iPwvgKNatePzJ+vu/4PRaNYy+K';
  const SIG_COMMON = 'yaVfYIJIdqrHDXsDL3vsYw==';
  const BASE = 'https://onlineservice-api.zhihuishu.com/gateway/t/v1';

  async function post(name, url, form) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
      });
      const t = await r.text();
      out[name] = { status: r.status, len: t.length, body: t.slice(0, 2000) };
    } catch (e) { out[name] = { error: String(e) }; }
  }
  async function get(name, url) {
    try {
      const r = await fetch(url, { credentials: 'include' });
      const t = await r.text();
      out[name] = { status: r.status, len: t.length, body: t.slice(0, 1200) };
    } catch (e) { out[name] = { error: String(e) }; }
  }

  // A. 复用 capture 到的签名 + 自定义参数
  await post('A_复用签名_课程列表', `${BASE}/student/course/share/queryShareCourseInfo`,
    { secretStr: SIG, date: Date.now(), pageNo: 1, pageSize: 20 });

  // B. 用「通用签名」调用同一接口（预期失败，作为对照）
  await post('B_错用通用签名_课程列表', `${BASE}/student/course/share/queryShareCourseInfo`,
    { secretStr: SIG_COMMON, date: Date.now(), pageNo: 1, pageSize: 20 });

  // C. 复用通用签名调不需要参数的接口
  await get('C_通用签名_未读数', `${BASE}/mirror/home/cheat/findCheatListCount?secretStr=${encodeURIComponent(SIG_COMMON)}&date=${Date.now()}`);

  // D. 完全不带签名
  await get('D_不带签名_未读数', `${BASE}/mirror/home/cheat/findCheatListCount?date=${Date.now()}`);

  // E. 带签名的 GET：背景信息
  await get('E_通用签名_背景', `${BASE}/student/home/index/background?secretStr=${encodeURIComponent(SIG_COMMON)}&date=${Date.now()}`);

  return out;
});

for (const [k, v] of Object.entries(res)) {
  console.log(`\n=== ${k} === status=${v.status} len=${v.len}`);
  if (v.error) { console.log('  ERR', v.error); continue; }
  console.log('  ' + (v.body || '').replace(/\s+/g, ' ').slice(0, 600));
}

await browser.close().catch(() => {});
