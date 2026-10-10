// 验证 Playwright Firefox 的指纹与可用性（快速，用完即关）
import { firefox } from 'playwright';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const PROFILE = join(ROOT, 'browser-profile-firefox');

const ctx = await firefox.launchPersistentContext(PROFILE, {
  headless: true,           // 仅做指纹检测，无需界面
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('about:blank');

const fp = await page.evaluate(() => ({
  webdriver: navigator.webdriver,
  ua: navigator.userAgent,
  langs: navigator.languages,
  plugins: navigator.plugins.length,
  platform: navigator.platform,
  hardwareConcurrency: navigator.hardwareConcurrency,
}));
console.log('=== Firefox 指纹 ===');
console.log(JSON.stringify(fp, null, 1));

// 能否正常访问智慧树
const net = await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 60000 })
  .then((r) => ({ ok: true, status: r.status() }))
  .catch((e) => ({ ok: false, err: String(e).slice(0, 120) }));
console.log('\n访问学生端:', JSON.stringify(net));

await page.waitForTimeout(5000);
const chk = await page.evaluate(async () => {
  try {
    const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
    const j = await r.json();
    return { code: j.code, user: j.result };
  } catch (e) { return { error: String(e).slice(0, 120) }; }
});
console.log('会话状态:', JSON.stringify(chk));

await ctx.close();
console.log('\nFirefox 路径可用 ✅');
console.log(chk.code === 200 ? '且已登录' : '但尚未登录（需要手动登录一次）');
