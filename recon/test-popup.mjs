// 用 CDP 连到运行中的「智慧树助手」，验证 window.open 是否被拦截在主窗口内打开
import { chromium } from 'playwright';

const PORT = 9225;
const log = (m) => process.stdout.write(m + '\n');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];

const pagesBefore = ctx.pages();
log('=== 连接前页面 ===');
for (const p of pagesBefore) log('  ' + p.url().slice(0, 90));

const main = pagesBefore.find((p) => /zhihuishu/.test(p.url())) ?? pagesBefore[0];
if (!main) { log('没有页面'); process.exit(1); }
log('\n主页面: ' + main.url());

// 1) 在主页面里调用 window.open
log('\n=== 触发 window.open("https://example.com") ===');
const r = await main.evaluate(() => {
  const w = window.open('https://example.com', '_blank');
  return { opened: !!w };
}).catch((e) => ({ err: String(e).slice(0, 120) }));
log('  返回值: ' + JSON.stringify(r));

await new Promise((r) => setTimeout(r, 4000));

// 2) 检查是否多出了页面
const pagesAfter = ctx.pages();
log('\n=== 触发后页面 ===');
for (const p of pagesAfter) log('  ' + p.url().slice(0, 90));
log(`  页面数: ${pagesBefore.length} → ${pagesAfter.length}  ${pagesAfter.length === pagesBefore.length ? '✓ 没有新开窗口' : '✗ 多出了窗口'}`);

// 3) 主窗口是否被导航到目标地址
const mainUrl = main.url();
log(`\n主窗口地址: ${mainUrl}`);
log(`  是否已导航到 example.com: ${/example\.com/.test(mainUrl) ? '✓ 是' : '✗ 否'}`);

await browser.close().catch(() => {});
