// 启动 / 复用 Firefox（Playwright 自带构建）持久化会话
//
// 目的：让 Firefox 与 Edge 一样能跑完整流程，且登录一次长期有效。
// 登录态恢复策略（按顺序尝试）：
//   1) browser-profile-firefox 里已有的会话
//   2) 从已登录的 Edge profile 复制 Cookie 过来（免二次登录）
//   3) 自动填表登录（示例大学 / 学号），出现易盾验证码则等人工完成
//
// 用法：
//   $env:PLAYWRIGHT_BROWSERS_PATH='K:\网页自动学习\ms-playwright'
//   node lab\legacy\firefox-launch-session.mjs            # 打开窗口并保持
//   node lab\legacy\firefox-launch-session.mjs --check    # 只校验，完成后退出
import { firefox } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkLogin, ensureLoggedIn, loadAccount } from '../../src/core/login-flow.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const PROFILE = join(ROOT, 'browser-profile-firefox');
const OUT = join(ROOT, 'session');
const HOME = 'https://onlineweb.zhihuishu.com/onlinestuh5';
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

const checkOnly = process.argv.includes('--check');

// 关键：DSH 的作业沙箱里，Firefox 自身的子进程沙箱无法创建进程，
// 表现为 GPU/content 子进程 SpawnTarget 失败 (0x80070005) 后浏览器整体 0xC0000005 退出。
// 关掉 Firefox 自己的沙箱就能正常启动（只影响我们拉起的这个测试实例）。
process.env.MOZ_DISABLE_CONTENT_SANDBOX = '1';
process.env.MOZ_DISABLE_GPU_SANDBOX = '1';
process.env.MOZ_DISABLE_SOCKET_PROCESS_SANDBOX = '1';
process.env.MOZ_FORCE_DISABLE_E10S = process.env.MOZ_FORCE_DISABLE_E10S || '';

console.log('Firefox profile:', PROFILE);
const ctx = await firefox.launchPersistentContext(PROFILE, {
  headless: false,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.bringToFront().catch(() => {});

await page.goto('about:blank');
const fp = await page.evaluate(() => ({ webdriver: navigator.webdriver, ua: navigator.userAgent, langs: navigator.languages }));
console.log('\n=== Firefox 指纹 ===');
console.log(JSON.stringify(fp, null, 1));

await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => console.log('goto:', String(e).slice(0, 100)));
await page.waitForTimeout(7000);

// ---------- 1) 现有会话 ----------
let st = await checkLogin(page);
console.log('\n[1] 现有 Firefox 会话:', st.code === 200 ? `已登录 ${st.user?.realName}` : `未登录 (code=${st.code})`);

// ---------- 2) 从 Edge 借 Cookie ----------
if (st.code !== 200) {
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
    const all = await b.contexts()[0].cookies();
    const want = all.filter((c) => /zhihuishu\.com|polymas\.com/.test(c.domain));
    if (want.length) {
      await ctx.addCookies(want.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        expires: c.expires && c.expires > 0 ? c.expires : -1,
        httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
      })));
      console.log(`[2] 已从 Edge 复制 ${want.length} 条智慧树 Cookie`);
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await page.waitForTimeout(6000);
      st = await checkLogin(page);
      console.log('    复制后会话:', st.code === 200 ? `✅ 已登录 ${st.user?.realName}` : `仍未登录 (code=${st.code})`);
    } else {
      console.log('[2] Edge 会话里没有智慧树 Cookie，跳过');
    }
    await b.close().catch(() => {});
  } catch (e) { console.log('[2] 从 Edge 取 Cookie 失败:', String(e).slice(0, 140)); }
}

// ---------- 3) 自动登录 ----------
if (st.code !== 200) {
  const cred = loadAccount();
  if (cred) {
    console.log(`[3] 自动登录（来源: ${cred.file}）…`);
    st = await ensureLoggedIn(page, cred, { log: (m) => console.log('   ' + m), shotDir: join(OUT, 'firefox-login') });
  } else {
    console.log('[3] 无凭据，无法自动登录（可用 --student-id/--password 或 ZHS_* 环境变量）');
  }
}

writeFileSync(join(OUT, 'firefox-state.json'), JSON.stringify({ fp, chk: st, url: page.url(), at: new Date().toISOString() }, null, 2), 'utf8');
console.log('\n=== 最终会话状态 ===');
console.log(JSON.stringify({ code: st.code, user: st.user ? { realName: st.user.realName, school: st.user.schoolName } : null }, null, 1));
await page.screenshot({ path: join(OUT, 'firefox-session.png') }).catch(() => {});

if (st.code === 200) {
  console.log('\n✅ Firefox 可用且已登录');
  console.log('   下一步: node src\\pipeline.mjs --browser firefox');
  console.log(`   （需 $env:PLAYWRIGHT_BROWSERS_PATH='${join(ROOT, 'ms-playwright')}'）`);
}

if (checkOnly) { await ctx.close(); process.exit(st.code === 200 ? 0 : 2); }
console.log('\n窗口保持开启（关闭窗口即结束）。');
await new Promise(() => {});
