// 环境验证：能否拉起浏览器 + 浏览器资料里是否还有登录态
import { ensureChromium, connect, readyPage, HOME } from '../src/browser.mjs';

console.log('=== 1) 拉起 / 复用 Chromium（Edge）===');
try {
  const info = await ensureChromium();
  console.log('  ', JSON.stringify({ browser: info.browser, port: info.port, started: info.started }));
} catch (e) {
  console.log('  ❌ 启动失败:', String(e).slice(0, 200));
  process.exit(1);
}

console.log('\n=== 2) CDP 接管 ===');
const { ctx, describe, close } = await connect();
console.log('  ', describe);
console.log('   标签页:', JSON.stringify(ctx.pages().map((p) => p.url().slice(0, 80)), null, 1));

console.log('\n=== 3) 登录态校验 ===');
const page = await readyPage(ctx, HOME);
await page.waitForTimeout(6000);
console.log('   当前页:', page.url().slice(0, 110));

const chk = await page.evaluate(async () => {
  const out = {};
  try {
    const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
    const j = await r.json();
    out.getLoginUserInfo = { code: j.code, name: j.result?.realName, school: j.result?.schoolName };
  } catch (e) { out.getLoginUserInfo = { error: String(e).slice(0, 120) }; }
  return out;
}).catch((e) => ({ evalError: String(e).slice(0, 150) }));
console.log('  ', JSON.stringify(chk, null, 1));

const cookies = await ctx.cookies();
const zhs = cookies.filter((c) => /zhihuishu|polymas/.test(c.domain));
const key = zhs.filter((c) => /SESSION|JSESSIONID|CASTGC|jt-cas|polymas-token/i.test(c.name));
console.log(`\n   cookie: 智慧树 ${zhs.length} 条，关键票据 ${key.length} 条`);
for (const c of key.slice(0, 12)) console.log(`     ${c.domain}  ${c.name}  len=${(c.value || '').length}`);

console.log('\n=== 结论 ===');
if (chk.getLoginUserInfo?.code === 200) {
  console.log('  ✅ 环境可用且已登录：' + chk.getLoginUserInfo.name + ' @ ' + chk.getLoginUserInfo.school);
} else {
  console.log('  ⚠️ 环境可用，但未登录（需要在浏览器窗口里登录一次）');
  console.log('     窗口:', page.url());
}
await close();
process.exit(0);
