// 通过 CDP 把浏览器窗口调到前台可见状态（不依赖 Win32 P/Invoke）
import { chromium } from 'playwright';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

// 找到真实内容页并激活
const pages = ctx.pages();
let target = pages.find((p) => p.url().includes('onlineweb.zhihuishu.com/onlinestuh5'))
  ?? pages.find((p) => /zhihuishu\.com/.test(p.url()));

if (!target) {
  target = await ctx.newPage();
  await target.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await target.waitForTimeout(5000);
}

console.log('目标页面:', target.url());
await target.bringToFront();
await target.waitForTimeout(1500);

// 用 CDP 操作窗口：获取 windowId 并最大化/全屏
const session = await ctx.newCDPSession(target);
try {
  const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
  console.log('windowId =', windowId, ' 当前 bounds =', JSON.stringify(bounds));

  // 先最大化，确保不被完全遮挡
  await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'maximized' },
  });
  console.log('已请求窗口最大化');

  await target.waitForTimeout(1000);
  const after = await session.send('Browser.getWindowForTarget');
  console.log('操作后 bounds =', JSON.stringify(after.bounds));
} catch (e) {
  console.log('窗口操作失败:', String(e).slice(0, 200));
}

// 再次激活，确保标签在前
await target.bringToFront();
await target.screenshot({ path: join(ROOT, 'recon', 'render', 'final-state.png') }).catch(() => {});

const info = await target.evaluate(() => ({
  url: location.href, title: document.title, textLen: document.body.innerText.length,
}));
console.log('前台页面:', JSON.stringify(info));

await browser.close().catch(() => {});
