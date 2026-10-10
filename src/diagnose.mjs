// 诊断：拉起浏览器 → 校验登录态 → 输出结论
import { ensureChromium, connect, readyPage, HOME, findLiveCdp } from './browser.mjs';

console.log('=== 1) 拉起/检测浏览器 ===');
const info = await ensureChromium();
console.log('  ', JSON.stringify({ browser: info.browser, port: info.port, started: info.started }));

console.log('\n=== 2) 进程存活确认 ===');
await new Promise((r) => setTimeout(r, 3000));
const live = await findLiveCdp();
console.log('  CDP:', live ? `${live.browser} @ ${live.port} (${live.version.Browser})` : '不可用');

if (!live) { console.log('浏览器未能保持运行'); process.exit(1); }

console.log('\n=== 3) 校验登录态 ===');
const { ctx, describe, close } = await connect();
console.log('  ', describe);
const page = await readyPage(ctx, HOME);
await page.waitForTimeout(5000);

const chk = await page.evaluate(async () => {
  const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
  const j = await r.json();
  const r2 = await fetch('https://user.zhihuishu.com/zhsuser/login/isLogin', { credentials: 'include' });
  let j2 = null; try { j2 = await r2.json(); } catch {}
  return { getLoginUserInfo: { code: j.code, user: j.result }, isLogin: j2 };
});
console.log('  ', JSON.stringify(chk, null, 1));

const cookies = await ctx.cookies();
const zhs = cookies.filter((c) => /zhihuishu|polymas/.test(c.domain));
const key = zhs.filter((c) => /SESSION|JSESSIONID|CASTGC|jt-cas|token/i.test(c.name));
console.log(`\n  cookie: 智慧树 ${zhs.length} 条，关键票据 ${key.length} 条`);
for (const c of key.slice(0, 10)) console.log(`    ${c.domain}  ${c.name}  len=${(c.value || '').length}`);

console.log('\n=== 结论 ===');
if (chk.getLoginUserInfo?.code === 200) {
  console.log('  ✅ 已登录：' + chk.getLoginUserInfo.user.realName);
} else {
  console.log('  ❌ 未登录 —— 需要在浏览器窗口里登录一次');
  console.log('     窗口地址:', page.url());
  console.log('     浏览器窗口已打开，请手动完成登录后再跑 resolve-courses.mjs');
}
await close();
process.exit(0);
