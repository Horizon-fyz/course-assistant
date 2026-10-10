// 会话保活 / 验证 / 显示修复
// 用法: node src/session.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connect, readyPage, tidy, waitContent, HOME } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'session');
mkdirSync(OUT, { recursive: true });

export async function ensureSession() {
  let browser, ctx;
  try {
    ({ browser, ctx } = await connect());
  } catch (e) {
    return { ok: false, reason: 'CDP 浏览器未运行，请先执行 start-browser.ps1', error: String(e).slice(0, 200) };
  }

  const page = await readyPage(ctx, HOME);
  const len = await waitContent(page, 50, 20000);

  const chk = await page.evaluate(async () => {
    try {
      const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
      const j = await r.json();
      return { code: j.code, user: j.result };
    } catch (e) { return { error: String(e) }; }
  }).catch((e) => ({ error: String(e) }));

  const cookies = await ctx.cookies();
  const zhs = cookies.filter((c) => /zhihuishu|polymas/.test(c.domain));
  writeFileSync(OUT + '\\cookies.json', JSON.stringify(cookies, null, 2));
  try { await ctx.storageState({ path: OUT + '\\storage-state.json' }); } catch {}

  // 收拾标签，保证界面上看到的是真实页面
  const focused = await tidy(ctx);
  const pages = ctx.pages().map((p) => p.url());

  await browser.close().catch(() => {});

  const ok = chk.code === 200;
  return {
    ok,
    user: chk.user,
    cookieCount: zhs.length,
    pageTextLen: len,
    focusedUrl: focused ? focused.url() : null,
    openTabs: pages,
    detail: chk,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await ensureSession();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
