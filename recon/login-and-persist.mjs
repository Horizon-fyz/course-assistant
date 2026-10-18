// 登录 + 会话固化：重新登录 → 把会话票据改写成「有过期时间的持久 Cookie」→ 重启浏览器验证
//
// 背景：智慧树的 CAS 票据（CASTGC / SESSION / polymas-token 等）是 session cookie，
// 浏览器一关就丢，导致「登录一次长期有效」失效。这里登录后显式把关键 Cookie
// 重新写回带远未来过期时间的持久 Cookie，重启浏览器也不会丢。
import { chromium } from 'playwright';
import { connect } from '../src/core/browser.mjs';
import { ensureLoggedIn, loadAccount, checkLogin } from '../src/core/login-flow.mjs';

const KEEP_DAYS = 30;
const KEY_RE = /SESSION|CASTGC|jt-cas|polymas-token|JSESSIONID|INGRESSCOOKIE|route-ingress|SERVERID|ai-poly|o_session_id|CASLOGC/i;

const persistOnly = process.argv.includes('--persist-only');

// 浏览器可插拔：默认 Chromium 系；--browser firefox 走 BiDi；--browser-exe 指定任意浏览器
const ARGV = process.argv.slice(2);
const argOf = (n, d = null) => { const i = ARGV.indexOf(n); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d; };
const prefer = argOf('--browser', 'chromium') === 'firefox' ? 'firefox' : 'chromium';
const browserExe = argOf('--browser-exe');
const firefoxProfile = argOf('--firefox-profile');

const { ctx, describe } = await connect({ prefer, exe: browserExe, firefoxProfile });
console.log('浏览器:', describe);

const page = ctx.pages().find((p) => /zhihuishu\.com/.test(p.url())) ?? (await ctx.newPage());

let st = await checkLogin(page);
console.log('[1] 当前会话:', st.code === 200 ? `已登录 ${st.user?.realName}` : `未登录 (code=${st.code})`);

if (st.code !== 200 && !persistOnly) {
  const cred = loadAccount();
  if (!cred) { console.log('❌ 无凭据（可用环境变量或 config/credentials.json 提供）'); process.exit(1); }
  console.log(`[2] 重新登录（来源: ${cred.file}）…`);
  st = await ensureLoggedIn(page, cred, { log: (m) => console.log('   ' + m), shotDir: 'K:\\网页自动学习\\session\\persist-login' });
  console.log('[2] 登录结果:', st.code === 200 ? `✅ ${st.user?.realName}` : `❌ code=${st.code}`);
}

if (st.code !== 200) { console.log('登录未成功，终止'); await ctx.close().catch(() => {}); process.exit(2); }

// ---------- 3) 固化会话票据 ----------
console.log('\n[3] 固化会话票据（session cookie → 持久 cookie）…');
const all = await ctx.cookies();
const zhs = all.filter((c) => /zhihuishu\.com|polymas\.com/.test(c.domain));
const keys = zhs.filter((c) => KEY_RE.test(c.name));
const expires = Math.floor(Date.now() / 1000) + KEEP_DAYS * 86400;

const repersist = (list) => list.map((c) => ({
  name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
  expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
}));

// Firefox 未实现 storage.setCookies，改写不了过期时间 → 跳过，改由 Firefox 的「恢复上次会话」保留
if (ctx.capabilities?.persistCookies === false) {
  console.log(`   当前浏览器不支持用协议改写 cookie 过期时间（Firefox 未实现 storage.setCookies）。`);
  console.log(`   会话改由 Firefox 自身的「恢复上次会话」保留（profile 已写入 browser.startup.page=3）。`);
} else {
  await ctx.addCookies(repersist(zhs));            // 全部智慧树 cookie 都延长
  await ctx.addCookies(repersist(keys));           // 关键票据再来一遍（双保险）
  console.log(`   已改写 ${zhs.length} 条智慧树 Cookie（其中关键票据 ${keys.length} 条），过期时间 +${KEEP_DAYS} 天`);
}

console.log('   关键票据清单:');
for (const c of keys) console.log(`     ${String(c.domain).padEnd(36)} ${c.name}`);

// ---------- 4) 复核 ----------
await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(5000);
st = await checkLogin(page);
console.log('\n[4] 固化后复核:', st.code === 200 ? `✅ 已登录 ${st.user?.realName}` : `❌ code=${st.code}`);

// 落一份 storageState 以备他用
try {
  if (typeof ctx.storageState !== 'function') throw new Error('当前浏览器不支持 storageState');
  await ctx.storageState({ path: 'K:\\网页自动学习\\session\\storage-state.json' });
  console.log('   已保存 session/storage-state.json');
} catch (e) { console.log('   storageState 保存失败:', String(e).slice(0, 90)); }

// ---------- 5) 重启验证 ----------
if (process.argv.includes('--restart-check')) {
  console.log('\n[5] 关闭浏览器 → 重启 → 验证登录是否还在…');
  await ctx.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  if (prefer !== 'firefox' && !browserExe) {
    for (const p of ['msedge', 'chrome']) {
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync('taskkill', ['/F', '/IM', `${p}.exe`], { stdio: 'ignore' });
      } catch {}
    }
  }
  await new Promise((r) => setTimeout(r, 4000));

  const c2 = await connect({ prefer, exe: browserExe, firefoxProfile });
  console.log('   重启结果:', c2.describe);
  const pg = c2.ctx.pages()[0] ?? (await c2.ctx.newPage());
  await pg.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await pg.waitForTimeout(6000);
  const st2 = await checkLogin(pg);
  const cks = (await c2.ctx.cookies()).filter((c) => /zhihuishu/.test(c.domain) && KEY_RE.test(c.name));
  console.log('   重启后会话:', st2.code === 200 ? `✅ 仍然登录 ${st2.user?.realName}` : `❌ 丢失 (code=${st2.code})`);
  console.log('   重启后关键票据:', cks.length, '条');
  for (const c of cks) console.log(`     ${String(c.domain).padEnd(36)} ${c.name}  expires=${c.expires > 0 ? new Date(c.expires * 1000).toISOString().slice(0, 10) : 'SESSION'}`);
  await c2.close().catch(() => {});
  process.exit(st2.code === 200 ? 0 : 3);
}

await ctx.close().catch(() => {});
process.exit(0);
