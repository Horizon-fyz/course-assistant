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

/** 运行中检测只认这些进程名（浏览器主进程/子进程都可能出现，后面按命令行去重取端口） */
const RUNNING_NAMES = [
  'msedge.exe', 'chrome.exe', 'chromium.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe',
  '360se.exe', '360chrome.exe', 'qqbrowser.exe', 'sogouexplorer.exe', 'maxthon.exe',
  'firefox.exe', 'browser.exe',
];

let runningCache = { at: 0, list: [] };

/**
 * 枚举本机「正在运行」的浏览器进程。
 * 用途：
 *   1. 发现已经打开、且带 --remote-debugging-port 的浏览器 → 直接接管（登录态就在那个窗口里）；
 *   2. 发现装在非常规目录（便携版、自定义安装路径）的浏览器 → 补进发现列表。
 * 只有 Windows 有 CIM；其它平台返回空数组。结果缓存 4 秒。
 * @returns {{name:string, exe:string|null, pid:number, port:number|null, userDataDir:string|null, own:boolean}[]}
 */
export function runningBrowsers({ refresh = false } = {}) {
  if (process.platform !== 'win32') return [];
  if (!refresh && Date.now() - runningCache.at < 4000) return runningCache.list;

  const ps = `
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$names = @('${RUNNING_NAMES.join("','")}')
Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name.ToLower() } |
  Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress
`;
  const list = [];
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 12000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let rows = JSON.parse(String(out || '').replace(/^\uFEFF/, '').trim() || '[]');
    if (!Array.isArray(rows)) rows = [rows];
    for (const p of rows) {
      const exe = p.ExecutablePath || null;
      const name = (exe && classify(exe)) || classify(String(p.Name || '')) || null;
      if (!name) continue;
      const cmd = String(p.CommandLine || '');
      const port = Number((cmd.match(/--remote-debugging-port(?:=|\s+)(\d{2,5})/i) || [])[1]) || null;
      // --user-data-dir 可能带引号：三种写法都兼容
      const ud = (cmd.match(/--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s"]+))/i) || []).slice(1).find(Boolean) || null;
      list.push({
        name, exe, pid: Number(p.ProcessId) || 0, port, userDataDir: ud,
        own: !!(ud && ud.toLowerCase().startsWith(BASE.toLowerCase())),
      });
    }
  } catch { /* 查不到就当没有运行中的浏览器 */ }

  // 浏览器会为每个渲染进程/内容进程复制同一份命令行，这里按「浏览器 + 端口 + 用户目录」去重
  const seen = new Set();
  const uniq = list.filter((b) => {
    const key = `${b.name}|${b.exe}|${b.port}|${b.userDataDir}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  runningCache = { at: Date.now(), list: uniq };
  return uniq;
}

let discoverCache = null;

/**
 * 枚举本机「真实存在」的 Chromium 系浏览器。
 * 不预设品牌顺序：只有文件确实存在才会进列表；排序按「可接管的运行中实例 → 有登录态 → 系统默认 → Edge 最后」。
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
  // 运行中的浏览器：补上便携版/自定义安装目录（注册表里查不到的）
  for (const b of runningBrowsers()) if (b.exe) add(b.exe, 'running');

  const def = defaultBrowserExe();
  const running = runningBrowsers();
  const live = new Map(running.map((b) => [b.name, b]));
  // Edge 只是兜底（Windows 自带，永远能检测到），只有没装任何其它浏览器时才用；
  // 其它浏览器之间：带调试端口的运行中实例 > 登录态 > 运行中 > 系统默认 > 发现顺序（sort 稳定）
  const rank = (b) => {
    if (b.name === 'edge') return 5;
    const r = live.get(b.name);
    if (r?.port) return 0;
    if (existsSync(profileOf(b.name))) return 1;
    if (r) return 2;
    return (def && b.exePath.toLowerCase() === def.toLowerCase()) ? 3 : 4;
  };
  list.sort((a, b) => rank(a) - rank(b));

  discoverCache = list;
  return list;
}

/**
 * 自动选择浏览器种类（不指定 --browser 时的默认策略）：
 *   1. 正在运行、且带调试端口的非 Edge Chromium 系 → 直接接管（登录态就在这个窗口里）
 *   2. 正在运行、带调试端口的 Firefox（通常已登录智慧树）
 *   3. 任意已安装的「非 Edge」Chromium 系浏览器（Chrome / Brave / 360 / QQ …，含便携版）
 *   4. 本机安装的 Firefox
 *   5. 都没有才退回 Edge
 * @returns {'chromium'|'firefox'}
 */
export function autoPrefer() {
  const running = runningBrowsers();
  const isChromium = (b) => b.name !== 'edge' && b.name !== 'firefox';
  if (running.some((b) => isChromium(b) && b.port)) return 'chromium';
  // 运行中的 Firefox 往往已经登录过智慧树，优先于「装了但可能没登录」的 Chromium
  if (running.some((b) => b.name === 'firefox' && b.port)) return 'firefox';
  if (discoverChromium().some((b) => b.name !== 'edge')) return 'chromium';
  if (findFirefox() || running.some((b) => b.name === 'firefox' && b.exe)) return 'firefox';
  return 'chromium'; // 只剩 Edge（或什么都没有，交给 connect 报安装提示）
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

/** 端口上是否已经打开智慧树页面（决定「接管哪个窗口」：登录态就在这个窗口里） */
async function cdpHasTarget(port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const list = await res.json();
    return Array.isArray(list) && list.some((t) => t.type === 'page' && /zhihuishu\.com/.test(String(t.url || '')));
  } catch { return false; }
}

/**
 * 找已经在跑的 CDP 实例。
 * 候选来源（优先级从高到低）：
 *   1. 运行中的浏览器进程自己在命令行里声明的调试端口（用户手动开的 / 上次流程留下的，端口不固定也能发现）
 *   2. 各浏览器固定端口（browser-profile-* 启动的实例）
 *   3. 自定义调试端口 9231
 * 多个都活着时：已经打开智慧树页面的非 Edge 实例 > 运行中的非 Edge 实例 > 其它。
 * @param {{allowEdge?: boolean, excludePorts?: number[]}} [opts]
 */
export async function findLiveCdp({ allowEdge = true, excludePorts = [] } = {}) {
  const byPort = new Map();
  const push = (name, port, extra = {}, priority = 0) => {
    if (!port) return;
    const cur = byPort.get(port);
    if (!cur || priority > cur.priority) byPort.set(port, { name, port, priority, ...extra });
  };
  for (const b of runningBrowsers()) push(b.name, b.port, { running: true, own: b.own, pid: b.pid }, 3);
  for (const b of discoverChromium()) push(b.name, b.port, {}, 2);
  for (const [name, port] of Object.entries(PORTS)) if (name !== 'firefox') push(name, port, {}, 1);
  push('custom', CUSTOM_PORT, {}, 0);

  const skip = new Set(excludePorts);
  const candidates = [...byPort.values()].filter((p) => !skip.has(p.port) && (allowEdge || p.name !== 'edge'));

  const hits = await Promise.all(candidates.map(async (p) => {
    const version = await cdpAlive(p.port);
    if (!version) return null;
    return {
      browser: p.name, port: p.port, version,
      running: !!p.running, own: !!p.own, pid: p.pid,
      hasTarget: await cdpHasTarget(p.port),
    };
  }));

  const alive = hits.filter(Boolean);
  const score = (h) => (h.browser === 'edge' ? 0 : 10) + (h.running ? 4 : 0) + (h.hasTarget ? 2 : 0);
  // sort 稳定：同分时保留候选来源的先后（运行中 > 固定端口 > 自定义）
  alive.sort((a, b) => score(b) - score(a));
  return alive[0] || null;
}

/** 启动系统 Chromium 系浏览器的远程调试（幂等：已在运行则复用） */
export async function ensureChromium({ headless = false, exe = null } = {}) {
  // 未指定可执行文件时才「谁在跑就用谁」；指定了就认准它
  if (!exe) {
    // 本机还有非 Edge 浏览器时，不复用残留的 Edge 实例（Edge 只作兜底）
    const hasOther = discoverChromium().some((b) => b.name !== 'edge')
      || runningBrowsers().some((b) => !['edge', 'firefox'].includes(b.name));
    const live = await findLiveCdp({ allowEdge: !hasOther });
    if (live) return { ...live, started: false };
  }

  const c = findChromium(exe);

  // 指定的浏览器可能早就被手动开着调试端口：优先接管那个实例（端口不固定也认）
  if (exe && c) {
    const same = runningBrowsers().find((b) => b.port && b.exe
      && b.exe.toLowerCase() === c.exePath.toLowerCase());
    if (same) {
      const v = await cdpAlive(same.port);
      if (v) return { browser: c.name, port: same.port, version: v, started: false };
    }
  }
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
  // 不指定 exe 时按统一优先级挑：非 Edge 的 Chromium 系 → Firefox → Edge（Edge 仅兜底）。
  // 只有显式 prefer:'firefox' 才强制走 Firefox。
  const kind = exe ? guessKind(exe) : (prefer === 'firefox' ? 'firefox' : autoPrefer());

  if (kind === 'firefox') {
    // 已经打开的 Firefox 如果带调试端口，优先接管（登录态就在那个窗口里）；
    // 没带端口的运行中 Firefox 接不了，只能另开一个实例，但可复用它的 exe（便携版也能找到）
    const running = runningBrowsers();
    const attachPorts = exe ? [] : running.filter((b) => b.name === 'firefox' && b.port).map((b) => b.port);
    const runningExe = running.find((b) => b.name === 'firefox' && b.exe)?.exe;
    const launched = await launchFirefoxBidi({
      exe: exe || runningExe || undefined,
      profile: firefoxProfile || `${BASE}\\browser-profile-firefox`,
      port: firefoxPort,
      attachPorts,
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
