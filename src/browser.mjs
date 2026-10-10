// 多浏览器抽象层
// 目标：Edge / Chrome / Firefox 都能用，调用方代码不用区分
//
// 实测结论（重要）：
//   - Edge/Chrome 等 Chromium 系：用 --remote-debugging-port 启动，Playwright connectOverCDP 接管。
//     这样 navigator.webdriver=false，网易易盾验证码才能正常通过。
//   - 系统版 Firefox：--remote-debugging-port 只起 httpd.js，没有标准 /json/* 端点，
//     无法用 connectOverCDP 接管。可用路径是 Playwright 自带 Firefox 构建。
import { chromium, firefox } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
export const HOME = 'https://onlineweb.zhihuishu.com/onlinestuh5';

// 浏览器安装位置从环境变量推导，不写死盘符（Chrome/Firefox 不一定装在哪个目录）
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || '';

const CHROMIUM_CANDIDATES = [
  {
    name: 'edge', port: 9222, channel: 'msedge',
    exe: [
      join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(LOCAL, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
  },
  {
    name: 'chrome', port: 9223, channel: 'chrome',
    exe: [
      join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  },
];

export function findChromium() {
  for (const c of CHROMIUM_CANDIDATES) {
    for (const e of c.exe) if (e && existsSync(e)) return { ...c, exePath: e };
  }
  return null;
}

export async function cdpAlive(port, timeoutMs = 2500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function findLiveCdp() {
  for (const c of CHROMIUM_CANDIDATES) {
    const v = await cdpAlive(c.port);
    if (v) return { browser: c.name, port: c.port, version: v };
  }
  return null;
}

/** 启动系统 Chromium 系浏览器的远程调试（幂等：已在运行则复用） */
export async function ensureChromium({ headless = false } = {}) {
  const live = await findLiveCdp();
  if (live) return { ...live, started: false };

  const c = findChromium();
  if (!c) throw new Error('未找到 Edge/Chrome 可执行文件');

  // 统一使用固定的 profile 名，避免「登录在 A、脚本用 B」导致会话丢失
  // profile 选择：固定名优先；若固定名未初始化但历史目录存在，则沿用历史目录（避免登录态丢失）
  const fixed = `${BASE}\\browser-profile-${c.name}`;
  const LEGACY = { edge: 'browser-profile-cdp' };
  const legacyDir = LEGACY[c.name] ? `${BASE}\\${LEGACY[c.name]}` : null;
  const profile = (existsSync(fixed) || !legacyDir) ? fixed : legacyDir;
  mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${c.port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1500,900', '--window-position=0,0',
  ];
  if (headless) args.push('--headless=new');
  args.push(HOME);

  const { spawn } = await import('node:child_process');
  spawn(c.exePath, args, { detached: true, stdio: 'ignore' }).unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const v = await cdpAlive(c.port);
    if (v) return { browser: c.name, port: c.port, version: v, started: true };
  }
  throw new Error(`${c.name} 调试端口 ${c.port} 启动超时`);
}

/**
 * 统一会话入口。
 * @param {{prefer?: 'chromium'|'firefox'}} opts
 * @returns {{kind, browserName, browser, ctx, describe, close}}
 */
export async function connect({ prefer = 'chromium' } = {}) {
  if (prefer === 'firefox') {
    const profile = `${BASE}\\browser-profile-firefox`;
    mkdirSync(profile, { recursive: true });
    const ctx = await firefox.launchPersistentContext(profile, {
      headless: false, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
      viewport: { width: 1440, height: 900 },
    });
    return {
      kind: 'persistent', browserName: 'firefox', browser: null, ctx,
      describe: 'firefox @ Playwright 自带构建',
      close: () => ctx.close().catch(() => {}),
    };
  }

  const live = await findLiveCdp();
  if (live) {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${live.port}`);
    return {
      kind: 'cdp', browserName: live.browser, browser: b, ctx: b.contexts()[0],
      describe: `${live.browser} @ CDP ${live.port} (${live.version.Browser})`,
      close: () => b.close().catch(() => {}),
    };
  }
  throw new Error('没有可用的 Chromium 系浏览器。先跑 start-browser.ps1，或改用 firefox 模式。');
}

export function findPage(ctx, match = HOME) {
  return ctx.pages().find((p) => p.url().includes(match))
    ?? ctx.pages().find((p) => /zhihuishu\.com/.test(p.url()) && !p.url().startsWith('about:'));
}

export async function readyPage(ctx, url = HOME, { reuse = true } = {}) {
  let page = reuse ? (findPage(ctx, url) ?? findPage(ctx)) : null;
  if (!page) page = ctx.pages().find((p) => p.url() === 'about:blank') ?? (await ctx.newPage());
  if (!page.url().includes(new URL(url).host)) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  await page.bringToFront().catch(() => {});
  return page;
}

/** 清空白/重复标签，聚焦真实页面，并把窗口置前 */
export async function tidy(ctx, focusUrl = 'onlineweb.zhihuishu.com/onlinestuh5') {
  for (const p of ctx.pages()) {
    const u = p.url();
    if (u === 'about:blank' || u === '') await p.close().catch(() => {});
  }
  const seen = new Set();
  for (const p of ctx.pages()) {
    const u = p.url();
    if (!/zhihuishu\.com/.test(u)) continue;
    if (seen.has(u)) await p.close().catch(() => {});
    else seen.add(u);
  }
  const target = ctx.pages().find((p) => p.url().includes(focusUrl))
    ?? ctx.pages().find((p) => p.url().includes('onlineweb.zhihuishu.com/onlinestuh5'))
    ?? ctx.pages().find((p) => /zhihuishu\.com/.test(p.url()));
  if (target) {
    await target.bringToFront().catch(() => {});
    await target.waitForTimeout(600);
    try {
      const s = await ctx.newCDPSession(target);
      const { windowId, bounds } = await s.send('Browser.getWindowForTarget');
      if (bounds?.windowState !== 'maximized') {
        await s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
      }
    } catch { /* Firefox 无此 CDP 命令，忽略 */ }
  }
  await focusWindow();
  return target;
}

/**
 * 把浏览器主窗口提到前台。
 * Windows 禁止后台进程抢焦点，需借 COM 的 WScript.Shell.AppActivate
 * （Add-Type 在本环境被禁用，无法用 Win32 P/Invoke）。
 */
export async function focusWindow(processName) {
  const names = processName ? [processName] : ['msedge', 'chrome', 'firefox'];
  const ps = `
$ErrorActionPreference='SilentlyContinue'
foreach ($n in @(${names.map((n) => `'${n}'`).join(',')})) {
  $p = Get-Process $n | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p) {
    $w = New-Object -ComObject WScript.Shell
    $ok = $w.AppActivate($p.Id)
    if (-not $ok) { $ok = $w.AppActivate($p.MainWindowTitle) }
    Write-Output ("$n AppActivate=" + $ok)
    break
  }
}
`;
  try {
    const { execFileSync } = await import('node:child_process');
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000 }).trim();
  } catch (e) { return 'focus-failed: ' + String(e).slice(0, 100); }
}

export async function waitContent(page, minLen = 50, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const len = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
    if (len >= minLen) return len;
    await page.waitForTimeout(1000);
  }
  return 0;
}
