// 重新登录智慧树（CDP 接管原版 Edge，navigator.webdriver=false 才能正常渲染易盾验证码）
//
// 用法：
//   node recon\login-live.mjs            # 自动填表并提交
//   node recon\login-live.mjs --status   # 只查登录态，不动页面
//
// 若能自动过验证码 → 直接登录成功；若出现滑块 → 脚本保留窗口并提示人工拖动，
// 然后自动轮询登录结果（最多 5 分钟），人工完成即视为成功。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureChromium, connect, readyPage, HOME } from '../src/browser.mjs';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'recon', 'login');
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const maxWaitMs = 5 * 60 * 1000;

let ACC = null;
for (const f of ['account-live.json', 'account.json']) {
  try { ACC = JSON.parse(readFileSync(join(ROOT, 'config', f), 'utf8')); console.log('凭据文件:', f); break; } catch {}
}
if (!ACC) { console.log('❌ 读不到凭据文件 config/account-live.json'); process.exit(1); }

const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin';

await ensureChromium();
const { ctx, describe } = await connect();
console.log('浏览器:', describe);

const page = ctx.pages().find((p) => /login\.zhihuishu\.com/.test(p.url()))
  ?? ctx.pages().find((p) => /zhihuishu\.com/.test(p.url()))
  ?? (await ctx.newPage());
await page.bringToFront().catch(() => {});

// 登录态检测（走接口，最可靠）
async function logged() {
  try {
    return await page.evaluate(async () => {
      const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
      const j = await r.json();
      return { code: j.code, user: j.result };
    });
  } catch (e) { return { code: -1, err: String(e).slice(0, 100) }; }
}

async function report(tag) {
  const st = await logged();
  if (st.code === 200) {
    console.log(`✅ ${tag} 已登录: ${st.user?.realName} @ ${st.user?.schoolName ?? ''}`);
    return true;
  }
  console.log(`⏳ ${tag} 未登录 (code=${st.code})`);
  return false;
}

console.log('\n[1] 打开学生端确认状态…');
await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(5000);
if (await report('[1]')) { console.log('无需重新登录。'); process.exit(0); }
if (statusOnly) process.exit(2);

console.log('\n[2] 打开登录页…');
await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3500);
await page.screenshot({ path: join(OUT, 'live-1-login.png') }).catch(() => {});

console.log('[3] 切换到「学号登录」…');
await page.getByText('学号登录', { exact: true }).first().click({ timeout: 15000 }).catch((e) => console.log('   跳过:', String(e).slice(0, 80)));
await page.waitForTimeout(1800);

console.log('[4] 选择学校 =', ACC.school);
try {
  const sel = page.locator('input.el-select__input:visible').first();
  await sel.click({ timeout: 10000 });
  await sel.fill(ACC.school);
  await page.waitForTimeout(2500);
  const opt = page.locator('.el-select-dropdown__item').filter({ hasText: new RegExp(`^${ACC.school}$`) }).first();
  if (await opt.count()) await opt.click({ timeout: 8000 });
  else await page.locator('.el-select-dropdown__item').first().click({ timeout: 8000 });
  await page.waitForTimeout(1200);
  console.log('   ✓ 已选择');
} catch (e) { console.log('   ⚠️ 选择学校异常:', String(e).split('\n')[0].slice(0, 110)); }

console.log('[5] 填学号与密码…');
await page.locator('input[name="unid"]').fill(ACC.studentId).catch((e) => console.log('   学号填充失败:', String(e).slice(0, 80)));
try { await page.locator('input[type="password"]:visible').first().fill(ACC.password); console.log('   ✓ 已填入'); }
catch (e) { console.log('   ⚠️ 密码填充失败:', String(e).slice(0, 90)); }
await page.waitForTimeout(600);

console.log('[6] 勾选用户协议…');
const agree = page.getByText('我已阅读并同意').first();
await agree.click({ timeout: 8000 }).catch(async () => {
  await page.locator('.el-checkbox:visible').first().click({ timeout: 5000 }).catch(() => {});
});
await page.waitForTimeout(1000);
let chkBox = await page.evaluate(() => document.querySelector('input.el-checkbox__original')?.checked ?? null).catch(() => null);
if (!chkBox) {
  await page.locator('.el-checkbox:visible').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  chkBox = await page.evaluate(() => document.querySelector('input.el-checkbox__original')?.checked ?? null).catch(() => null);
}
console.log('   勾选状态:', chkBox);

await page.screenshot({ path: join(OUT, 'live-2-filled.png') }).catch(() => {});

console.log('[7] 提交登录…');
await page.locator('div.btn-block__grandient_login').first().click({ timeout: 12000 })
  .catch((e) => console.log('   提交点击异常:', String(e).split('\n')[0].slice(0, 120)));

// 轮询：等验证码出现 或 登录成功
const t0 = Date.now();
let captchaSeen = false;
let told = false;
while (Date.now() - t0 < maxWaitMs) {
  await page.waitForTimeout(3000);

  if (await report(`[7] ${Math.round((Date.now() - t0) / 1000)}s`)) {
    console.log('\n══════ 登录成功 ══════');
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await report('确认');
    await page.screenshot({ path: join(OUT, 'live-3-ok.png') }).catch(() => {});
    process.exit(0);
  }

  const st = await page.evaluate(() => {
    const y = document.querySelector('.yidun_popup, .yidun_modal, .yidun_intellisense, .yidun_panel, .yidun');
    const frames = [...document.querySelectorAll('iframe')]
      .map((f) => ({ src: (f.src || '').slice(0, 70), w: Math.round(f.getBoundingClientRect().width), h: Math.round(f.getBoundingClientRect().height) }))
      .filter((x) => x.w > 60 && x.h > 60);
    const errs = [...document.querySelectorAll('.el-message, .el-message__content, .el-form-item__error, .el-notification')]
      .map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 3);
    return { url: location.href, yidun: !!y, frames, errs };
  }).catch(() => ({ url: page.url(), yidun: false, frames: [], errs: [] }));

  if (st.errs?.length) console.log('   页面提示:', JSON.stringify(st.errs));
  if ((st.yidun || st.frames.length) && !captchaSeen) {
    captchaSeen = true;
    await page.screenshot({ path: join(OUT, 'live-captcha.png') }).catch(() => {});
    console.log('\n⚠️ 出现人机验证（易盾）。');
    console.log('   Edge 窗口已打开并停在这个页面，请在弹出的窗口里完成滑块验证/点击验证。');
    console.log('   我在这里等你完成，最多等 5 分钟…');
    told = true;
  } else if (!told && /login\.zhihuishu\.com/.test(st.url) === false) {
    console.log('   页面已跳转:', st.url.slice(0, 100));
  }
}
console.log('\n❌ 超时未登录成功。最后 URL:', page.url());
await page.screenshot({ path: join(OUT, 'live-timeout.png') }).catch(() => {});
process.exit(3);
