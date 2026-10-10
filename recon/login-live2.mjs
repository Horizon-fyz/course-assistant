// 重新登录智慧树（CDP 接管原版 Edge）
//
// 关键点：
//   1) 学校必须精确选中「示例大学」，不能落到「示例大学医学院」等同名前缀项，
//      也不能落到下拉里位置靠前的其它学校。做法：输入后按名称精确过滤，
//      选不中就退回「键盘 ↓ + Enter 选第一项」，并在提交前回读校验。
//   2) 验证码检测只看真正的易盾容器，不能把页面装饰性 iframe 当验证码。
//
// 用法：
//   node recon\login-live.mjs            # 自动填表提交；出现验证码则等人完成
//   node recon\login-live.mjs --status   # 只查登录态
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureChromium, connect, HOME } from '../src/browser.mjs';

const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'recon', 'login');
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const statusOnly = args.includes('--status');
const maxWaitMs = 8 * 60 * 1000;

let ACC = null;
for (const f of ['account-live.json', 'account.json']) {
  try { ACC = JSON.parse(readFileSync(join(ROOT, 'config', f), 'utf8')); console.log('凭据文件:', f); break; } catch {}
}
if (!ACC) { console.log('❌ 读不到凭据文件 config/account-live.json'); process.exit(1); }

const SCHOOL = ACC.school;
const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin';

await ensureChromium();
const { ctx, describe } = await connect();
console.log('浏览器:', describe);

const page = ctx.pages().find((p) => /zhihuishu\.com/.test(p.url())) ?? (await ctx.newPage());
await page.bringToFront().catch(() => {});

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
  if (st.code === 200) { console.log(`✅ ${tag} 已登录: ${st.user?.realName}`); return true; }
  console.log(`⏳ ${tag} 未登录 (code=${st.code})`);
  return false;
}
// 真正的易盾容器才判定为验证码
async function captchaState() {
  return page.evaluate(() => {
    const sel = '#yidun_popup, .yidun_popup, .yidun_modal, .yidun_panel, .yidun_intellisense, .yidun_intellisense--light, [class*="yidun"]';
    const hit = [...document.querySelectorAll(sel)].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 100 && r.height > 60;
    });
    const ifr = [...document.querySelectorAll('iframe')].filter((f) => /dun\.163|captcha|yidun/i.test(f.src || ''));
    return { count: hit.length + ifr.length, cls: hit.slice(0, 2).map((e) => e.className) };
  }).catch(() => ({ count: 0 }));
}

console.log('\n[1] 打开学生端确认状态…');
await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(5000);
if (await report('[1]')) { console.log('无需重新登录。'); process.exit(0); }
if (statusOnly) process.exit(2);

console.log('\n[2] 打开登录页…');
await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(3500);

console.log('[3] 切换到「学号登录」…');
await page.getByText('学号登录', { exact: true }).first().click({ timeout: 15000 }).catch(() => {});
await page.waitForTimeout(2000);

// ---------- 选学校（关键步骤） ----------
console.log(`[4] 选择学校 = ${SCHOOL}`);
let picked = null;
try {
  const sel = page.locator('input.el-select__input:visible').first();
  await sel.click({ timeout: 10000 });
  await page.waitForTimeout(800);
  await sel.fill('');
  await sel.type(SCHOOL, { delay: 90 });
  await page.waitForTimeout(3000);

  const opts = page.locator('.el-select-dropdown__item:visible');
  const texts = await opts.allInnerTexts().catch(() => []);
  console.log('   下拉候选:', JSON.stringify(texts.slice(0, 8)));

  // 精确匹配优先
  const exact = opts.filter({ hasText: new RegExp(`^\\s*${SCHOOL}\\s*$`) }).first();
  if (await exact.count()) {
    await exact.click({ timeout: 8000 });
    picked = SCHOOL;
  } else {
    // 退回：键盘选第一项（下拉已按输入过滤）
    await sel.press('ArrowDown').catch(() => {});
    await page.waitForTimeout(600);
    await sel.press('Enter').catch(() => {});
    picked = texts[0] ?? null;
  }
  await page.waitForTimeout(1500);
} catch (e) { console.log('   ⚠️ 选择异常:', String(e).split('\n')[0].slice(0, 120)); }

// 回读校验：学校输入框的真实值
const schoolVal = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')].filter((i) => i.offsetParent && i.type === 'text');
  return inputs.map((i) => i.value).filter(Boolean);
}).catch(() => []);
console.log('   表中文本字段:', JSON.stringify(schoolVal));
const schoolOk = schoolVal.some((v) => v.includes(SCHOOL));
console.log(schoolOk ? '   ✓ 学校字段包含「' + SCHOOL + '」' : '   ❌ 学校字段不含「' + SCHOOL + '」，需要人工确认');

console.log('[5] 填学号与密码…');
await page.locator('input[name="unid"]').fill(ACC.studentId).catch(() => {});
await page.locator('input[type="password"]:visible').first().fill(ACC.password).catch(() => {});
await page.waitForTimeout(600);

console.log('[6] 勾选用户协议…');
await page.getByText('我已阅读并同意').first().click({ timeout: 8000 }).catch(async () => {
  await page.locator('.el-checkbox:visible').first().click({ timeout: 5000 }).catch(() => {});
});
await page.waitForTimeout(800);
let chk = await page.evaluate(() => document.querySelector('input.el-checkbox__original')?.checked ?? null).catch(() => null);
if (!chk) {
  await page.locator('.el-checkbox:visible').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  chk = await page.evaluate(() => document.querySelector('input.el-checkbox__original')?.checked ?? null).catch(() => null);
}
console.log('   协议勾选:', chk);

await page.screenshot({ path: join(OUT, 'live2-filled.png') }).catch(() => {});

console.log('[7] 提交…');
await page.locator('div.btn-block__grandient_login').first().click({ timeout: 12000 }).catch(() => {});

const t0 = Date.now();
let announced = false;
while (Date.now() - t0 < maxWaitMs) {
  await page.waitForTimeout(3000);
  if (await report(`[7] ${Math.round((Date.now() - t0) / 1000)}s`)) {
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await report('确认');
    await page.screenshot({ path: join(OUT, 'live2-ok.png') }).catch(() => {});
    console.log('\n══════ 登录成功 ══════');
    process.exit(0);
  }
  const cap = await captchaState();
  if (cap.count > 0 && !announced) {
    announced = true;
    await page.screenshot({ path: join(OUT, 'live2-captcha.png') }).catch(() => {});
    console.log('\n⚠️ 出现人机验证（易盾），容器:', JSON.stringify(cap.cls));
    console.log('   Edge 窗口已打开并停在该页面，请在窗口里完成验证。');
    console.log('   我在这里等，最多 8 分钟，完成后会自动继续…');
  }
  const err = await page.evaluate(() => [...document.querySelectorAll('.el-message, .el-form-item__error, .el-notification')]
    .map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 2)).catch(() => []);
  if (err.length) console.log('   页面提示:', JSON.stringify(err));
}
console.log('\n❌ 超时。最后 URL:', page.url());
await page.screenshot({ path: join(OUT, 'live2-timeout.png') }).catch(() => {});
process.exit(3);
