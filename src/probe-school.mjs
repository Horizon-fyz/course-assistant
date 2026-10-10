// 实地侦察「学号登录」：学校选择器行为 + 是否正确匹配示例大学（不提交）
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'login');
mkdirSync(OUT, { recursive: true });
const ACC = JSON.parse(readFileSync(join(ROOT, 'config', 'account.json'), 'utf8'));

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 940 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
});
const page = await ctx.newPage();

await page.goto('https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(3000);

// 切到学号登录
await page.getByText('学号登录', { exact: true }).first().click();
await page.waitForTimeout(2000);

const unid = page.locator('input[name="unid"]');
await unid.fill(ACC.studentId);
await page.waitForTimeout(500);

// 点学校下拉框
const selectInput = page.locator('input.el-select__input:visible').first();
const before = await page.evaluate(() => document.querySelectorAll('.el-select-dropdown__item').length);
console.log('dropdown items before open:', before);

await selectInput.click();
await page.waitForTimeout(2500);

const afterOpen = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.el-select-dropdown__item')];
  return { count: items.length, first: items.slice(0, 15).map((i) => i.innerText.trim()) };
});
console.log('dropdown items after open:', afterOpen.count);
console.log('first items:', JSON.stringify(afterOpen.first, null, 1));

// 尝试输入学校名过滤
await selectInput.fill(ACC.school);
await page.waitForTimeout(2500);

const filtered = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.el-select-dropdown__item')];
  return { count: items.length, texts: items.slice(0, 20).map((i) => i.innerText.trim()) };
});
console.log('after typing school:', filtered.count, JSON.stringify(filtered.texts, null, 1));

await page.screenshot({ path: OUT + '\\school-search.png', fullPage: false });

// 记录此刻状态
const state = await page.evaluate(() => ({
  url: location.href,
  inputs: [...document.querySelectorAll('input')].map((el) => ({ type: el.type, name: el.name, ph: el.placeholder, val: el.type === 'password' ? '***' : el.value, visible: !!el.offsetParent })),
}));
writeFileSync(OUT + '\\school-search-state.json', JSON.stringify({ state, afterOpen, filtered }, null, 2));
console.log('\ninputs:', JSON.stringify(state.inputs, null, 1));

await browser.close();
