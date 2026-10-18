// 以持久化 profile 启动 Firefox（Playwright 自带构建）
// 登录态保存在 browser-profile-firefox，之后所有脚本用 connect({prefer:'firefox'}) 复用
import { firefox } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const BASE = ROOT;
const PROFILE = BASE + '\\browser-profile-firefox';
const HOME = 'https://onlineweb.zhihuishu.com/onlinestuh5';
mkdirSync(PROFILE, { recursive: true });

console.log('Firefox profile:', PROFILE);
console.log('启动中（窗口会打开；若未登录请手动登录一次）…');

const ctx = await firefox.launchPersistentContext(PROFILE, {
  headless: false,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
});

const page = ctx.pages()[0] ?? (await ctx.newPage());

// 指纹确认
await page.goto('about:blank');
const fp = await page.evaluate(() => ({
  webdriver: navigator.webdriver,
  ua: navigator.userAgent,
  langs: navigator.languages,
}));
console.log('\n=== 浏览器指纹 ===');
console.log(JSON.stringify(fp, null, 1));

console.log('\n打开学生端…');
await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => console.log('goto:', String(e).slice(0, 100)));
await page.waitForTimeout(9000);

// 校验登录态
const chk = await page.evaluate(async () => {
  try {
    const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
    const j = await r.json();
    return { code: j.code, user: j.result };
  } catch (e) { return { error: String(e).slice(0, 150) }; }
});

console.log('\n=== 会话状态 ===');
console.log(JSON.stringify(chk, null, 1));

if (chk.code === 200) {
  console.log('\n✅ Firefox 已登录：' + chk.user.realName);
  console.log(`下一步: PLAYWRIGHT_BROWSERS_PATH=${ROOT}\\ms-playwright node src\\resolve-courses.mjs firefox`);
} else {
  console.log('\n⚠️ 尚未登录。请在这个 Firefox 窗口里完成登录（学号登录 → 选学校 → 填学号密码），');
  console.log('   然后再跑一次本脚本，或直接跑 session/resolve-courses。');
  console.log('   注意：本脚本保持浏览器开启 5 分钟供你登录。');
  await page.waitForTimeout(300000);
}

writeFileSync(BASE + '\\session\\firefox-state.json', JSON.stringify({ fp, chk, url: page.url(), at: new Date().toISOString() }, null, 2));

// 交给后续脚本前不要关闭浏览器：保持开启
console.log('\n浏览器保持开启。关闭这个窗口即可结束。');
await new Promise(() => {});   // 永久等待，靠手动关闭窗口退出
