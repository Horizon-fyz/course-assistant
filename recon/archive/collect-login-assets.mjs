// 用 Playwright 收集登录中心真实加载的全部资源，并抓到「学号登录」tab 的 DOM 结构
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'loginsite');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
});
const page = await ctx.newPage();
const seen = new Set();
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('login.zhihuishu.com') && /\.(js|css|json)(\?|$)/.test(u)) seen.add(u);
});

await page.goto('https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(4000);

// 全部已加载资源（含动态 import）
const perf = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
const all = [...new Set([...seen, ...perf.filter((u) => u.includes('login.zhihuishu.com') && /\.(js|css)(\?|$)/.test(u))])];
writeFileSync(OUT + '\\asset-urls.txt', all.join('\n'));

// 点「学号登录」看表单变化
const snapshots = {};
async function snap(tag) {
  snapshots[tag] = await page.evaluate(() => {
    const inputs = [];
    document.querySelectorAll('input,select').forEach((el) => {
      inputs.push({ tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '', name: el.name || '', ph: el.placeholder || '', cls: (el.className || '').toString().slice(0, 70), visible: !!el.offsetParent });
    });
    const tabs = [];
    document.querySelectorAll('*').forEach((el) => {
      const tx = (el.innerText || '').trim();
      if (tx && tx.length <= 8 && el.children.length === 0 && /登录|扫码|学号|工号|账号/.test(tx)) tabs.push({ tx, cls: (el.className || '').toString().slice(0, 60) });
    });
    return { url: location.href, inputs, tabs: tabs.slice(0, 20) };
  });
}

await snap('initial');
for (const label of ['学号登录', '账号登录', '工号登录']) {
  try {
    await page.getByText(label, { exact: true }).first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);
    await snap(label);
  } catch (e) {
    snapshots[label] = { error: String(e).slice(0, 200) };
  }
}

writeFileSync(OUT + '\\tabs.json', JSON.stringify(snapshots, null, 2));
console.log('asset urls:', all.length);
for (const u of all) console.log('  ', u);
console.log('\n=== tab snapshots ===');
for (const [k, v] of Object.entries(snapshots)) {
  console.log(`\n--- ${k} ---`);
  if (v.error) { console.log('  error:', v.error); continue; }
  for (const i of v.inputs) console.log(`  ${i.visible ? 'V' : 'h'} <${i.tag} type=${i.type} id=${i.id} name=${i.name} ph="${i.ph}" cls=${i.cls}>`);
}

await browser.close();
