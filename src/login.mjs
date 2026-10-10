// 智慧树自动登录（学号登录）+ 固化持久会话
// 成功后：保存 cookie / storageState，并落到学生端首页
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
const PROFILE = BASE + '\\browser-profile';
const OUT = BASE + '\\session';
mkdirSync(OUT, { recursive: true });
mkdirSync(PROFILE, { recursive: true });

const ACC = JSON.parse(readFileSync(BASE + '\\config\\account.json', 'utf8'));
const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin';
const HOME = 'https://onlineweb.zhihuishu.com/onlinestuh5';

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'msedge',
  headless: false,
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 940 },
  args: ['--start-maximized'],
});

const page = ctx.pages()[0] ?? (await ctx.newPage());
const net = [];
page.on('request', (r) => {
  const u = r.url();
  if (/zhsuser|login\/account|gologin|ssoLogin|checkLogin|onlineweb/.test(u)) {
    net.push({ dir: 'REQ', method: r.method(), url: u, postLen: r.postData()?.length ?? 0, ct: r.headers()['content-type'] });
  }
});
page.on('response', async (r) => {
  const u = r.url();
  if (/zhsuser|login\/account|gologin|ssoLogin|checkLogin|gateway|onlineweb/.test(u)) {
    let snippet = '';
    const ct = r.headers()['content-type'] || '';
    if (/json|text/.test(ct)) { try { snippet = (await r.text()).slice(0, 400); } catch {} }
    net.push({ dir: 'RES', status: r.status(), url: u, ct, body: snippet });
  }
});

console.log('[1] 打开登录页…');
await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2500);

console.log('[2] 切换到「学号登录」…');
await page.getByText('学号登录', { exact: true }).first().click();
await page.waitForTimeout(1500);

console.log('[3] 选择学校：', ACC.school);
const selectInput = page.locator('input.el-select__input:visible').first();
await selectInput.click();
await selectInput.fill(ACC.school);
await page.waitForTimeout(2500);
// 优先精确匹配
const exact = page.locator('.el-select-dropdown__item', { hasText: new RegExp(`^${ACC.school}$`) }).first();
if (await exact.count()) await exact.click();
else await page.locator('.el-select-dropdown__item').first().click();
await page.waitForTimeout(1200);

console.log('[4] 填入学号…');
await page.locator('input[name="unid"]').fill(ACC.studentId);
await page.waitForTimeout(600);

console.log('[5] 填入密码…');
// 密码框是 el-input 内无 name 的 password 输入
await page.locator('input[type="password"]:visible').first().fill(ACC.password);
await page.waitForTimeout(600);

console.log('[6] 勾选用户协议…');
const cb = page.locator('input.el-checkbox__original').first();
if (!(await cb.isChecked())) {
  await cb.check({ force: true }).catch(async () => { await page.getByText('我已阅读并同意').click(); });
}
await page.waitForTimeout(800);

// 登录按钮是 <div class="... btn-block__grandient_login">登录</div>
const btn = page.locator('div.btn-block__grandient_login, button:has-text("登录")').first();
const btnText = await btn.innerText().catch(() => null);
const isDisabled = await btn.evaluate((el) => el.classList.contains('is-disabled') || el.getAttribute('disabled') !== null).catch(() => null);
console.log('[7] 登录按钮 text =', JSON.stringify(btnText), 'disabled =', isDisabled);

await page.screenshot({ path: OUT + '\\before-submit.png' });

console.log('[8] 点击登录…');
await btn.click({ timeout: 10000 }).catch((e) => console.log('   click err:', String(e).slice(0, 160)));

// 等待跳转，若出现验证码则给用户时间操作
let landed = false;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(2500);
  const url = page.url();
  const yidun = await page.evaluate(() => {
    const el = document.querySelector('.yidun_popup, .yidun_modal, .yidun_panel, iframe[src*=dun]');
    return !!el && !!(el.offsetParent || el.tagName === 'IFRAME');
  }).catch(() => false);
  console.log(`   [${i}] url=${url.slice(0, 90)} captchaVisible=${yidun}`);
  if (yidun && i === 1) {
    await page.screenshot({ path: OUT + '\\captcha-required.png' });
    console.log('   >>> 检测到验证码，等待你手动完成（最多 60 秒）…');
  }
  if (/onlineweb\.zhihuishu\.com|coursehome|zhihuishu\.com\/(?!.*login)/.test(url) && !/login\.zhihuishu\.com|passport\.zhihuishu\.com/.test(url)) { landed = true; break; }
  if (url.includes('onlineweb.zhihuishu.com/onlinestuh5')) { landed = true; break; }
}

console.log('[9] 登录后停留页面:', page.url());
await page.screenshot({ path: OUT + '\\after-login.png', fullPage: false });

// 明确跳到学生端首页，验证会话
try {
  await page.goto(HOME, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: OUT + '\\student-home.png', fullPage: false });
} catch (e) { console.log('   goto home err:', String(e).slice(0, 200)); }

const cookies = await ctx.cookies();
const interesting = cookies.filter((c) => /zhihuishu|polymas/.test(c.domain));
writeFileSync(OUT + '\\cookies.json', JSON.stringify(cookies, null, 2));
await ctx.storageState({ path: OUT + '\\storage-state.json' });
writeFileSync(OUT + '\\network.json', JSON.stringify(net, null, 2));

console.log('\n=== 登录后 cookie（智慧树相关）===');
for (const c of interesting) console.log(`  ${c.domain.padEnd(38)} ${c.name.padEnd(30)} httpOnly=${c.httpOnly}`);

console.log('\n=== 登录相关网络 ===');
for (const n of net) {
  if (n.dir === 'REQ') console.log(`  REQ ${n.method} ${n.url.slice(0, 110)} postLen=${n.postLen}`);
  else console.log(`  RES ${n.status} ${n.url.slice(0, 100)} ${n.body ? n.body.replace(/\s+/g, ' ').slice(0, 200) : ''}`);
}

console.log('\nfinal url:', page.url());
console.log('landed flag:', landed);
console.log('screenshots saved in', OUT);

await ctx.close();
