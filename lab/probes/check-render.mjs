// 检查所有页面并逐个截全页图，看内容是否真的渲染
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'render');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const pages = ctx.pages();
console.log('页面数:', pages.length);

const report = [];
for (const [i, p] of pages.entries()) {
  let info = {};
  try {
    info = await p.evaluate(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyLen: document.body ? document.body.innerText.length : -1,
      text: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) : '',
      appHtmlLen: document.querySelector('#app') ? document.querySelector('#app').innerHTML.length : -1,
      mainAppLen: document.querySelector('#main-app') ? document.querySelector('#main-app').innerHTML.length : -1,
      childCount: document.body ? document.body.children.length : -1,
    }));
  } catch (e) { info = { error: String(e).slice(0, 150) }; }

  const vp = p.viewportSize();
  console.log(`\n[${i}] ${info.url ?? '?'}`);
  console.log(`    title=${info.title} readyState=${info.readyState} bodyText=${info.bodyLen} #app=${info.appHtmlLen} #main-app=${info.mainAppLen} children=${info.childCount}`);
  console.log(`    viewport=${JSON.stringify(vp)}`);
  if (info.text) console.log(`    text: ${info.text.slice(0, 220)}`);
  if (info.error) console.log(`    ERROR: ${info.error}`);

  try {
    await p.bringToFront().catch(() => {});
    await p.screenshot({ path: `${OUT}\\page-${i}.png`, fullPage: false });
    report.push({ i, ...info, screenshot: `page-${i}.png` });
  } catch (e) {
    console.log('    screenshot failed:', String(e).slice(0, 120));
  }
}

writeFileSync(OUT + '\\state.json', JSON.stringify(report, null, 2));
await browser.close().catch(() => {});
console.log('\n截图已存到 recon\\render\\');
