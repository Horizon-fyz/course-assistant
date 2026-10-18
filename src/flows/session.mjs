// 会话保活 / 验证 / 显示修复
// 用法: node src/flows/session.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { connect, readyPage, tidy, waitContent, HOME } from '../core/browser.mjs';
import { join } from 'node:path';
import { harden } from '../core/accounts.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'session');
mkdirSync(OUT, { recursive: true });

export async function ensureSession() {
  let browser, ctx, close;
  // 浏览器选择可由上层透传（whoami 等命令复用同一套 --browser 参数）
  const prefer = process.env.ZHS_BROWSER === 'firefox' ? 'firefox' : 'chromium';
  const exe = process.env.ZHS_BROWSER_EXE || null;
  const firefoxProfile = process.env.ZHS_FIREFOX_PROFILE || null;
  try {
    ({ browser, ctx, close } = await connect({ prefer, exe, firefoxProfile }));
  } catch (e) {
    return { ok: false, reason: 'CDP 浏览器未运行，请先执行 start-browser.ps1', error: String(e).slice(0, 200) };
  }

  try {
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
    const cookiesFile = join(OUT, 'cookies.json');
    writeFileSync(cookiesFile, JSON.stringify(zhs, null, 2));
    harden(cookiesFile);

    // Firefox(BiDi) 没有 storageState，属预期能力差异，不静默失败
    let storageState = false;
    if (typeof ctx.storageState === 'function') {
      try {
        const stateFile = join(OUT, 'storage-state.json');
        await ctx.storageState({ path: stateFile });
        harden(stateFile);
        storageState = true;
      } catch { /* 保留 false，由调用方决定是否提示 */ }
    }

    // 收拾标签，保证界面上看到的是真实页面
    const focused = await tidy(ctx);
    const pages = ctx.pages().map((p) => p.url());

    const ok = chk.code === 200;
    return {
      ok,
      user: chk.user,
      cookieCount: zhs.length,
      storageState,
      pageTextLen: len,
      focusedUrl: focused ? focused.url() : null,
      openTabs: pages,
      detail: chk,
    };
  } finally {
    // Firefox 适配层没有 browser 对象，统一用 connect 返回的 close
    await (close ? close() : browser?.close()).catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await ensureSession();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
