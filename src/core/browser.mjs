// 多浏览器抽象层
// 目标：任意浏览器都能用，调用方代码不用区分
//
// 两条接管路线（都是实测结论）：
//   1. Chromium 系（Edge/Chrome/Brave/Vivaldi/Opera/360/QQ/Chromium…）：
//      用 --remote-debugging-port 启动，Playwright connectOverCDP 接管。
//      这样 navigator.webdriver=false，网易易盾验证码才能正常通过。
//   2. Firefox：官方构建已移除 CDP（--remote-debugging-port 只起 httpd.js，没有 /json/* 端点），
//      改走 WebDriver BiDi（见 bidi.mjs + browser-firefox.mjs）；
//      navigator.webdriver 用 script.addPreloadScript 抹掉。
//   3. 任意浏览器：用 --browser-exe <路径> 直接指定可执行文件；Chromium 系走 CDP，Firefox 走 BiDi。
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchFirefoxBidi, findFirefox } from './bidi.mjs';
import { createFirefoxBrowser } from './browser-firefox.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

const BASE = ROOT;
export const HOME = 'https://onlineweb.zhihuishu.com/onlinestuh5';

// 浏览器安装位置从环境变量推导，不写死盘符（Chrome/Firefox 不一定装在哪个目录）
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || '';

/** 每个浏览器固定一个调试端口（profile 与端口一起决定「登录态」归属） */
const PORTS = {
  edge: 9222, chrome: 9223, firefox: 9224, chromium: 9225, brave: 9226,
  vivaldi: 9227, opera: 9228, '360': 9229, qq: 9230, sogou: 9232,
  maxthon: 9233, yandex: 9234, 'playwright-chromium': 9235,
};
/** --browser-exe 指定的、认不出品牌的浏览器 */
const CUSTOM_PORT = 9231;

/** Firefox 走 BiDi，端口单独一个 */
export const FIREFOX_PORT = PORTS.firefox;

/**
 * 可执行文件名 → 浏览器种类。
 * 只用来给「已经确认存在的 exe」打标签，不参与「先用哪个」的排序。
 */
const EXE_RULES = [
  [/^msedge\.exe$/i, 'edge'],
  [/^chrome\.exe$/i, 'chrome'],
  [/^chromium\.exe$/i, 'chromium'],
  [/^brave\.exe$/i, 'brave'],
  [/^vivaldi\.exe$/i, 'vivaldi'],
  [/^opera\.exe$/i, 'opera'],
  [/^360(?:se|chrome)\d*\.exe$/i, '360'],
  [/^qqbrowser\.exe$/i, 'qq'],
  [/^sogouexplorer\.exe$/i, 'sogou'],
  [/^maxthon\.exe$/i, 'maxthon'],
  [/^firefox\.exe$/i, 'firefox'],
];

/** PATH 里值得顺手探一遍的可执行文件名 */
const PROBE_NAMES = [
  'msedge.exe', 'chrome.exe', 'chromium.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe',
  '360se.exe', '360chrome.exe', 'QQBrowser.exe', 'SogouExplorer.exe', 'Maxthon.exe',
];

/** 常见安装位置：只是线索，文件真存在才会被收下（不做优先级判断） */
const HINT_PATHS = [
  join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(LOCAL, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(PF86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(LOCAL, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(PF, 'Chromium', 'Application', 'chrome.exe'),
  join(LOCAL, 'Chromium', 'Application', 'chrome.exe'),
  join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  join(PF86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  join(PF, 'Vivaldi', 'Application', 'vivaldi.exe'),
  join(LOCAL, 'Vivaldi', 'Application', 'vivaldi.exe'),
  join(LOCAL, 'Programs', 'Opera', 'opera.exe'),
  join(PF, 'Opera', 'opera.exe'),
  join(PF86, '360Chrome', 'Chrome', 'Application', '360chrome.exe'),
  join(LOCAL, '360Chrome', 'Chrome', 'Application', '360chrome.exe'),
  join(PF, 'Tencent', 'QQBrowser', 'QQBrowser.exe'),
  join(PF86, 'Tencent', 'QQBrowser', 'QQBrowser.exe'),
  join(PF, 'SogouExplorer', 'SogouExplorer.exe'),
  join(PF86, 'SogouExplorer', 'SogouExplorer.exe'),
  join(PF, 'Maxthon', 'Maxthon.exe'),
  join(LOCAL, 'Maxthon', 'Maxthon.exe'),
];

/** 注册表来源：App Paths 覆盖绝大多数安装；Uninstall 的 DisplayIcon 兜底自定义目录 */
const APP_PATHS_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
];
const UNINSTALL_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

/** 按可执行文件名猜浏览器种类（用于 --browser-exe / connect） */
function guessKind(exePath) {
  const n = basename(String(exePath)).toLowerCase();
  if (n.startsWith('firefox')) return 'firefox';
  return 'chromium';
}

function reg(args) {
  try {
    return execFileSync('reg', args, {
      encoding: 'utf8', timeout: 8000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    // reg 在部分子键没有目标值时返回非 0，但 stdout 仍然有效
    return typeof e?.stdout === 'string' ? e.stdout : '';
  }
}

function expandEnv(p) {
  return String(p).replace(/%([^%]+)%/g, (s, k) => process.env[k] || s);
}

/** 把 reg query 输出里「值是 .exe 路径」的行全部抽出来（会展开 %VAR%） */
function exePathsFromReg(out) {
  const found = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = line.match(/^\s+\S.*?\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/);
    if (!m) continue;
    const p = expandEnv(m[1].replace(/^"|"$/g, '').replace(/,\s*-?\d+$/, '').trim());
    if (!/\.exe$/i.test(p)) continue;
    if (existsSync(p)) found.push(p);
  }
  return found;
}

/** 从命令行（HKCR\<ProgId>\shell\open\command）里取出可执行文件路径 */
function exeFromCommand(cmd) {
  const s = String(cmd || '');
  const m = s.match(/"([^"]+?\.exe)"/i) || s.match(/^\s*(\S+?\.exe)/i);
  if (!m) return null;
  const p = expandEnv(m[1].trim());
  return existsSync(p) ? p : null;
}

/** 读注册表，找出系统默认浏览器的 exe（没有/认不出则返回 null） */
function defaultBrowserExe() {
  const key = 'HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
  const progId = (reg(['query', key, '/v', 'ProgId']).match(/ProgId\s+REG_SZ\s+(.+?)\s*$/m) || [])[1];
  if (!progId) return null;
  const cmd = (reg(['query', `HKCR\\${progId.trim()}\\shell\\open\\command`, '/ve']).match(/REG_SZ\s+(.+?)\s*$/m) || [])[1];
  return cmd ? exeFromCommand(cmd) : null;
}

/** PATH 目录里探测常见的浏览器可执行文件名 */
function fromPathEnv() {
  const dirs = String(process.env.PATH || '').split(';').map((d) => d.trim()).filter(Boolean);
  const out = [];
  for (const d of dirs) {
    for (const n of PROBE_NAMES) {
      const p = join(d, n);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

/** Playwright 自带的 Chromium（`npx playwright install chromium` 装的那份） */
function playwrightChromium() {
  const bases = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(LOCAL, 'ms-playwright'),
    join(BASE, 'ms-playwright'),
  ].filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const base of bases) {
    const key = base.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!existsSync(base)) continue;
    let dirs = [];
    try { dirs = readdirSync(base); } catch { continue; }
    for (const d of dirs) {
      if (!/^chromium-\d+$/.test(d)) continue;
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const p = join(base, d, sub, 'chrome.exe');
        if (existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}

function classify(exePath) {
  const p = String(exePath).toLowerCase();
  const n = basename(p);
  // Playwright 自带的那份也叫 chrome.exe，靠目录区分，避免和系统 Chrome 混用 profile
  if (p.includes('ms-playwright')) return 'playwright-chromium';
  // Chromium 官方构建也叫 chrome.exe，但目录是 \Chromium\
  if (n === 'chrome.exe' && p.includes('\\chromium\\')) return 'chromium';
  if (p.includes('yandex') && n === 'browser.exe') return 'yandex';
  for (const [re, name] of EXE_RULES) if (re.test(n)) return name;
  return null;
}

/** 这个浏览器固定用的 profile 目录（历史目录优先沿用，避免登录态丢失） */
const LEGACY_PROFILES = { edge: 'browser-profile-cdp' };
function profileOf(name) {
  const fixed = `${BASE}\\browser-profile-${name}`;
  const legacy = LEGACY_PROFILES[name] ? `${BASE}\\${LEGACY_PROFILES[name]}` : null;
  return (existsSync(fixed) || !legacy) ? fixed : legacy;
}

let discoverCache = null;

/**
 * 枚举本机「真实存在」的 Chromium 系浏览器。
 * 不预设品牌顺序：只有文件确实存在才会进列表；排序只按「有没有登录态 → 是不是系统默认」。
 * @returns {{name: string, exePath: string, port: number, source: string}[]}
 */
export function discoverChromium({ refresh = false } = {}) {
  if (discoverCache && !refresh) return discoverCache;

  const list = [];
  const add = (exePath, source) => {
    if (!exePath || !existsSync(exePath)) return;
    const name = classify(exePath);
    if (!name || name === 'firefox') return;
    // 同一浏览器可能被多处发现（升级子目录、注册表 DisplayIcon…），每种只留最先发现的那个
    if (list.some((b) => b.name === name)) return;
    list.push({ name, exePath, port: PORTS[name] ?? CUSTOM_PORT, source });
  };

  for (const p of HINT_PATHS) add(p, 'path-hint');
  for (const key of APP_PATHS_KEYS) for (const p of exePathsFromReg(reg(['query', key, '/s']))) add(p, 'registry');
  for (const key of UNINSTALL_KEYS) for (const p of exePathsFromReg(reg(['query', key, '/s', '/v', 'DisplayIcon']))) add(p, 'registry');
  for (const p of fromPathEnv()) add(p, 'PATH');
  for (const p of playwrightChromium()) add(p, 'playwright');

  const def = defaultBrowserExe();
  // 只在「已经有多个可用浏览器」时决定先用哪个：登录态 > 系统默认 > 发现顺序（sort 稳定）
  const rank = (b) => (existsSync(profileOf(b.name)) ? 0 : (def && b.exePath.toLowerCase() === def.toLowerCase() ? 1 : 2));
  list.sort((a, b) => rank(a) - rank(b));

  discoverCache = list;
  return list;
}

/**
 * 找一个 Chromium 系浏览器（本机实际装了什么就用什么）。
 * @param {string} [explicitExe] 显式指定可执行文件（任意基于 Chromium 的浏览器）
 */
export function findChromium(explicitExe) {
  if (explicitExe) {
    if (!existsSync(explicitExe)) throw new Error('指定的浏览器不存在：' + explicitExe);
    const name = classify(explicitExe) || 'custom';
    return { name, port: PORTS[name] ?? CUSTOM_PORT, exePath: explicitExe, source: 'explicit' };
  }
  return discoverChromium()[0] || null;
}

/** 列出本机可用的浏览器（供 doctor / 报错提示使用） */
export function listAvailableBrowsers() {
  const out = discoverChromium().map((b) => ({
    kind: 'chromium', name: b.name, exe: b.exePath, port: b.port, source: b.source,
  }));
  const ff = findFirefox();
  if (ff) out.push({ kind: 'firefox', name: 'firefox', exe: ff, port: FIREFOX_PORT, source: 'firefox' });
  return out;
}

export async function cdpAlive(port, timeoutMs = 2500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const v = await res.json();
    // 端口可能被别的本地服务占用：必须确认是 Chromium 的调试端点，否则后续接管理所当然会失败
    return typeof v?.webSocketDebuggerUrl === 'string' ? v : null;
  } catch { return null; }
}

/** 找已经在跑的调试实例（端口固定，所以探测端口就够了；并发探，避免串行等待） */
export async function findLiveCdp() {
  const ports = [];
  const push = (name, port) => { if (!ports.some((p) => p.port === port)) ports.push({ name, port }); };
  for (const b of discoverChromium()) push(b.name, b.port);
  for (const [name, port] of Object.entries(PORTS)) if (name !== 'firefox') push(name, port);
  push('custom', CUSTOM_PORT);

  const hits = await Promise.all(ports.map(async (p) => {
    const v = await cdpAlive(p.port);
    return v ? { browser: p.name, port: p.port, version: v } : null;
  }));
  return hits.find(Boolean) || null;
}

/** 启动系统 Chromium 系浏览器的远程调试（幂等：已在运行则复用） */
export async function ensureChromium({ headless = false, exe = null } = {}) {
  // 未指定可执行文件时才「谁在跑就用谁」；指定了就认准它
  if (!exe) {
    const live = await findLiveCdp();
    if (live) return { ...live, started: false };
  }

  const c = findChromium(exe);
  if (!c) {
    throw new Error([
      '没有检测到本机已安装的浏览器（已检查常见安装位置、注册表、PATH 以及 Playwright 自带的 Chromium）。',
      '  1) 装任意一个浏览器后重试：Edge / Chrome / Firefox / Brave / Vivaldi / Opera / 360 / QQ 都行',
      '  2) 或用 --browser-exe "D:\\路径\\chrome.exe" 指定可执行文件',
      '  3) 或运行 npx playwright install chromium，用 Playwright 自带的 Chromium',
    ].join('\n'));
  }

  const already = await cdpAlive(c.port);
  if (already) return { browser: c.name, port: c.port, version: already, started: false };

  // 统一使用固定的 profile 名，避免「登录在 A、脚本用 B」导致会话丢失
  const profile = profileOf(c.name);
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
  const child = spawn(c.exePath, args, { detached: true, stdio: 'ignore' });
  let spawnErr = null;
  child.on('error', (e) => { spawnErr = e; });
  child.unref();

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (spawnErr) throw new Error(`启动 ${c.name} 失败：${spawnErr.message}（${c.exePath}）`);
    const v = await cdpAlive(c.port);
    if (v) return { browser: c.name, port: c.port, version: v, started: true };
  }
  throw new Error(`${c.name} 调试端口 ${c.port} 启动超时（${c.exePath}；端口可能被其它程序占用）`);
}

/**
 * 统一会话入口。任意浏览器都能接：Chromium 系走 CDP，Firefox 走 WebDriver BiDi。
 * @param {{prefer?: 'chromium'|'firefox', exe?: string, firefoxProfile?: string, firefoxPort?: number}} opts
 * @returns {{kind, browserName, browser, ctx, describe, close}}
 */
export async function connect({ prefer = 'chromium', exe = null, firefoxProfile = null, firefoxPort = FIREFOX_PORT } = {}) {
  const kind = exe ? guessKind(exe) : (prefer === 'firefox' ? 'firefox' : 'chromium');

  if (kind === 'firefox') {
    const launched = await launchFirefoxBidi({
      exe: exe || undefined,
      profile: firefoxProfile || `${BASE}\\browser-profile-firefox`,
      port: firefoxPort,
    });
    return await createFirefoxBrowser(launched);
  }

  const info = await ensureChromium({ exe });
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${info.port}`);
  const ctx = b.contexts()[0] ?? await b.newContext();
  return {
    kind: 'cdp', browserName: info.browser, browser: b, ctx,
    describe: `${info.browser} @ CDP ${info.port} (${info.version?.Browser || '?'})`,
    close: () => b.close().catch(() => {}),
  };
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
    const { execFile } = await import('node:child_process');
    // 用异步 execFile：tidy() 每次都会走到这里，同步调用会把事件循环堵住最长 20 秒
    return await new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
        resolve(err ? 'focus-failed: ' + String(err.message || err).slice(0, 100) : String(stdout || '').trim());
      });
    });
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
