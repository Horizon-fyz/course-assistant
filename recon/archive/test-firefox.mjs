// 测试 Firefox 接管方案（不修改任何数据）
import { firefox, chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'browser-profile-firefox');
mkdirSync(OUT, { recursive: true });

const results = [];

// 方案 1：Playwright 自带 Firefox（若已下载）
try {
  const b = await firefox.launch({ headless: true, timeout: 30000 });
  const p = await b.newPage();
  await p.goto('https://example.com', { timeout: 20000 });
  results.push({ plan: 'playwright-firefox', ok: true, ua: await p.evaluate(() => navigator.userAgent) });
  await b.close();
} catch (e) {
  results.push({ plan: 'playwright-firefox', ok: false, err: String(e).slice(0, 220) });
}

// 方案 2：系统 Firefox 可执行文件 + Playwright 启动（用独立 profile）
try {
  const b = await firefox.launch({
    executablePath: join(process.env.ProgramFiles || 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe'),
    headless: true,
    timeout: 30000,
  });
  const p = await b.newPage();
  await p.goto('https://example.com', { timeout: 20000 });
  results.push({ plan: 'system-firefox-exe', ok: true, ua: await p.evaluate(() => navigator.userAgent) });
  await b.close();
} catch (e) {
  results.push({ plan: 'system-firefox-exe', ok: false, err: String(e).slice(0, 220) });
}

// 方案 3：检查系统 Firefox 是否支持 CDP 端口（Chromium 式接管）
try {
  const b = await chromium.connectOverCDP('http://127.0.0.1:6000');
  results.push({ plan: 'firefox-cdp-6000', ok: true, contexts: b.contexts().length });
  await b.close();
} catch (e) {
  results.push({ plan: 'firefox-cdp-6000', ok: false, err: String(e).slice(0, 150) });
}

// 方案 4：Edge 基线对照
try {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  results.push({ plan: 'edge-cdp-9222', ok: true, contexts: b.contexts().length });
  await b.close();
} catch (e) {
  results.push({ plan: 'edge-cdp-9222', ok: false, err: String(e).slice(0, 150) });
}

console.log(JSON.stringify(results, null, 2));
