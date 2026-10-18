// 登录（CDP 接管原版 Edge）：修正协议勾选，确保真正提交
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const BASE = ROOT;
const OUT = BASE + '\\recon\\cdp';
mkdirSync(OUT, { recursive: true });
const ACC = JSON.parse(readFileSync(BASE + '\\config\\account.json', 'utf8'));

const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => p.url().includes('login.zhihuishu.com')) ?? (await ctx.newPage());

const net = [];
page.on('request', (r) => {
  const u = r.url();
  if (/zhsuser|login\/account|gologin|ssoLogin|checkLogin|yidun|dun\.163/.test(u)) {
    net.push({ dir: 'REQ', method: r.method(), url: u, postLen: r.postData()?.length ?? 0 });
  }
});
page.on('response', async (r) => {
  const u = r.url();
  if (/zhsuser|login\/account|gologin|ssoLogin|checkLogin/.test(u)) {
    let body = '';
    try { body = (await r.text()).slice(0, 500); } catch {}
    net.push({ dir: 'RES', status: r.status(), url: u, body });
  }
});

console.log('[1] 重新打开登录页（干净状态）');
await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

console.log('[2] 学号登录 tab');
await page.getByText('学号登录', { exact: true }).first().click();
await page.waitForTimeout(1500);

console.log('[3] 学校 =', ACC.school);
const selectInput = page.locator('input.el-select__input:visible').first();
await selectInput.click();
await selectInput.fill(ACC.school);
await page.waitForTimeout(2500);
const exact = page.locator('.el-select-dropdown__item').filter({ hasText: new RegExp(`^${ACC.school}$`) }).first();
if (await exact.count()) await exact.click(); else await page.locator('.el-select-dropdown__item').first().click();
await page.waitForTimeout(1200);

console.log('[4] 学号 + 密码');
await page.locator('input[name="unid"]').fill(ACC.studentId);
await page.locator('input[type="password"]:visible').first().fill(ACC.password);
await page.waitForTimeout(600);

// --- 修正：点击协议文字，并确认勾选生效 ---
console.log('[5] 勾选用户协议');
const agree = page.getByText('我已阅读并同意').first();
await agree.click({ timeout: 8000 }).catch(async (e) => {
  console.log('   文字点击失败，改用复选框容器:', String(e).slice(0, 100));
  await page.locator('.el-checkbox:visible').first().click({ timeout: 5000 }).catch(() => {});
});
await page.waitForTimeout(1200);

const checkState = await page.evaluate(() => {
  const el = document.querySelector('input.el-checkbox__original');
  const box = document.querySelector('.el-checkbox');
  return { inputChecked: el ? el.checked : null, boxClass: box ? box.className : null };
});
console.log('   勾选状态:', JSON.stringify(checkState));

if (!checkState.inputChecked) {
  console.log('   !!! 仍未勾选，强制点容器');
  await page.locator('.el-checkbox:visible').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(1000);
  console.log('   重查:', JSON.stringify(await page.evaluate(() => ({ c: document.querySelector('input.el-checkbox__original')?.checked }))));
}

await page.screenshot({ path: OUT + '\\s2-before-submit.png' });

const btnState = await page.evaluate(() => {
  const b = document.querySelector('div.btn-block__grandient_login');
  return { text: b?.innerText?.trim(), cls: b?.className };
});
console.log('[6] 按钮:', JSON.stringify(btnState));

console.log('[7] 提交');
await page.locator('div.btn-block__grandient_login').first().click({ timeout: 10000 }).catch((e) => console.log('   click err:', String(e).slice(0, 140)));

for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => {
    const y = document.querySelector('.yidun_popup, .yidun_modal, .yidun_intellisense, .yidun_panel');
    const ifr = [...document.querySelectorAll('iframe')].map((f) => ({ src: (f.src || '').slice(0, 80), w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height })).filter((x) => x.w > 0 && x.h > 0);
    const err = [...document.querySelectorAll('.el-message, .el-message__content, .el-form-item__error, .el-notification')].map((e) => e.innerText.trim()).filter(Boolean);
    return { url: location.href, yidunPopup: !!y, frames: ifr, errors: err };
  });
  console.log(`   [${i}] url=${st.url.slice(0, 78)} popup=${st.yidunPopup} frames=${st.frames.length} err=${JSON.stringify(st.errors)}`);
  if (st.frames.length) console.log('      frames:', JSON.stringify(st.frames));
  await page.screenshot({ path: `${OUT}\\s2-step-${i}.png` });
  if (st.frames.length || st.yidunPopup) { console.log('   >>> 验证码已出现'); break; }
  if (!/login\.zhihuishu\.com/.test(st.url)) { console.log('   >>> 页面已跳转'); break; }
}

writeFileSync(OUT + '\\network2.json', JSON.stringify(net, null, 2));
console.log('\n=== 网络 ===');
for (const n of net) console.log(n.dir === 'REQ' ? `  REQ ${n.method} ${n.url.slice(0, 100)} postLen=${n.postLen}` : `  RES ${n.status} ${n.url.slice(0, 90)} ${(n.body || '').replace(/\s+/g, ' ').slice(0, 220)}`);
console.log('\nfinal url:', page.url());
await browser.close().catch(() => {});
