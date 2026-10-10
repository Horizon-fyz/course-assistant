// 方案验证：用系统原版 Edge（远程调试端口）跑登录，看验证码控件能否正常渲染
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
const OUT = BASE + '\\recon\\cdp';
mkdirSync(OUT, { recursive: true });
const ACC = JSON.parse(readFileSync(BASE + '\\config\\account.json', 'utf8'));

const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages()[0] ?? (await ctx.newPage());

// 关键：验证 navigator.webdriver 是否为 false
await page.goto('about:blank');
const wd = await page.evaluate(() => ({
  webdriver: navigator.webdriver,
  ua: navigator.userAgent,
  plugins: navigator.plugins.length,
  langs: navigator.languages,
  chrome: !!window.chrome,
}));
console.log('=== 浏览器指纹 ===');
console.log(JSON.stringify(wd, null, 1));

await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);
console.log('after goto webdriver:', await page.evaluate(() => navigator.webdriver));

await page.getByText('学号登录', { exact: true }).first().click();
await page.waitForTimeout(1500);

const selectInput = page.locator('input.el-select__input:visible').first();
await selectInput.click();
await selectInput.fill(ACC.school);
await page.waitForTimeout(2500);
const exact = page.locator('.el-select-dropdown__item').filter({ hasText: new RegExp(`^${ACC.school}$`) }).first();
if (await exact.count()) await exact.click(); else await page.locator('.el-select-dropdown__item').first().click();
await page.waitForTimeout(1000);

await page.locator('input[name="unid"]').fill(ACC.studentId);
await page.locator('input[type="password"]:visible').first().fill(ACC.password);
const cb = page.locator('input.el-checkbox__original').first();
if (!(await cb.isChecked())) await cb.check({ force: true }).catch(() => {});
await page.waitForTimeout(600);

console.log('点击登录…');
await page.locator('div.btn-block__grandient_login').first().click({ timeout: 10000 }).catch((e) => console.log('click err', String(e).slice(0, 120)));

// 观察验证码 DOM 出现情况
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(2000);
  const probe = await page.evaluate(() => {
    const sel = ['.yidun_popup', '.yidun_modal', '.yidun_panel', '.yidun_intellisense', 'iframe[src*="dun"]', '.yidun_popup__mask', '[class*=yidun]'];
    const found = {};
    for (const s of sel) {
      const els = document.querySelectorAll(s);
      found[s] = [...els].map((e) => ({
        tag: e.tagName,
        cls: (e.className || '').toString().slice(0, 70),
        visible: !!(e.offsetParent) || e.tagName === 'IFRAME',
        w: e.getBoundingClientRect().width,
        h: e.getBoundingClientRect().height,
        src: e.tagName === 'IFRAME' ? (e.src || '').slice(0, 90) : undefined,
      }));
    }
    return { url: location.href, found, bodyHasYidun: document.body.innerHTML.includes('yidun') };
  });
  const n = Object.values(probe.found).flat().length;
  console.log(`[${i}] url=${probe.url.slice(0, 80)} yidunNodes=${n} bodyHasYidun=${probe.bodyHasYidun}`);
  if (i === 3 || n > 0) {
    await page.screenshot({ path: `${OUT}\\captcha-${i}.png` });
    writeFileSync(`${OUT}\\captcha-${i}.json`, JSON.stringify(probe, null, 2));
    if (n > 0) { console.log(JSON.stringify(probe.found, null, 1).slice(0, 1500)); break; }
  }
}

await page.screenshot({ path: OUT + '\\latest.png' });
console.log('final url:', page.url());
// 不要关闭浏览器，供用户查看
await browser.close().catch(() => {});
console.log('done');
