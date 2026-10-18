/**
 * bidi.mjs —— WebDriver BiDi 最小客户端（零第三方依赖）
 *
 * 为什么需要它：Firefox 官方构建已移除 CDP（`--remote-debugging-port` 只起 httpd.js，
 * 没有 /json/* 端点，Playwright 的 connectOverCDP 接管不了）；而 Playwright 自带 Firefox
 * 走 `-juggler-pipe` 命名管道，在受限沙箱里子进程创建被拒。唯一稳定的接管方式就是
 * WebDriver BiDi（HTTP 调试端口 + WebSocket）。
 *
 * 能力边界（都是实测确认过的）：
 *   - session.new / browsingContext.* / script.evaluate / input.performActions 可用
 *   - script.addPreloadScript 可用 → 用它抹掉 navigator.webdriver（易盾验证码前提）
 *   - network.addDataCollector + network.getData 可用 → 用它读响应体（抓题依赖）
 *
 * @module bidi
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
import { join } from 'node:path';

/** BiDi 的 RemoteValue → 普通 JS 值 */
export function toJs(rv) {
  if (rv === null || typeof rv !== 'object') return rv;
  switch (rv.type) {
    case 'undefined': return undefined;
    case 'null': return null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint': return rv.value;
    case 'array': return (rv.value || []).map(toJs);
    case 'set': return (rv.value || []).map(toJs);
    case 'object': {
      const o = {};
      for (const [k, v] of rv.value || []) o[k] = toJs(v);
      return o;
    }
    case 'map': {
      const o = {};
      for (const [k, v] of rv.value || []) o[String(toJs(k))] = toJs(v);
      return o;
    }
    default: return rv.value ?? null;
  }
}

/** 按 Content-Encoding 解压响应体（BiDi 返回的是「已编码」字节） */
export function decodeBody(buf, contentEncoding) {
  const enc = String(contentEncoding || '').toLowerCase();
  try {
    if (enc.includes('br')) return brotliDecompressSync(buf).toString('utf8');
    if (enc.includes('gzip')) return gunzipSync(buf).toString('utf8');
    if (enc.includes('deflate')) return inflateSync(buf).toString('utf8');
  } catch { /* 落到下面按原文处理 */ }
  // 没给编码信息时，按魔数猜一次
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return gunzipSync(buf).toString('utf8'); } catch { /* ignore */ }
  }
  return buf.toString('utf8');
}

/** 一条 BiDi 连接：命令-响应 + 事件订阅 */
export class BidiConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.collector = null;
    /** 已订阅的事件名 */
    this.subscribed = new Set();

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(typeof msg.error === 'string' ? msg.error : JSON.stringify(msg.error)))
                  : p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) {
          try { fn(msg.params); } catch { /* 单个监听器出错不影响其它 */ }
        }
      }
    });

    ws.addEventListener('close', () => { this.closed = true; });
  }

  /** 打开连接并完成握手（session.new） */
  static async open(wsUrl, { timeoutMs = 20000 } = {}) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('BiDi WebSocket 握手超时')), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('BiDi WebSocket 连接失败')); });
    });
    const conn = new BidiConnection(ws);
    const session = await conn.send('session.new', { capabilities: { alwaysMatch: {} } }, timeoutMs);
    conn.capabilities = session?.capabilities || {};
    return conn;
  }

  /** 发命令（带超时） */
  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('BiDi 连接已关闭'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  /** 发命令但不关心结果（用于「点击后页面会导航、执行上下文被销毁」的场景） */
  async fire(method, params = {}, timeoutMs = 2500) {
    try { return await this.send(method, params, timeoutMs); }
    catch { return null; }
  }

  /** 订阅事件；不支持的事件名会被静默忽略（不同 Firefox 版本支持面不同） */
  async subscribe(events) {
    for (const e of events) {
      if (this.subscribed.has(e)) continue;
      try { await this.send('session.subscribe', { events: [e] }, 10000); this.subscribed.add(e); }
      catch { /* 该事件名不被支持 */ }
    }
  }

  /** 注册事件监听，返回取消函数 */
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event)?.delete(fn);
  }

  /** 开启响应体收集器（不开启则 network.getData 会报 no such network data） */
  async enableBodyCollector(maxBytes = 200 * 1024 * 1024) {
    try {
      const r = await this.send('network.addDataCollector', { dataTypes: ['response'], maxEncodedDataSize: maxBytes }, 15000);
      this.collector = r?.collector || null;
    } catch { this.collector = null; }
    return this.collector;
  }

  /** 抹掉 navigator.webdriver：必须早于页面脚本执行，所以用 preload script */
  async hideWebdriver() {
    const src = `() => {
      try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true }); } catch (e) {}
    }`;
    try { return (await this.send('script.addPreloadScript', { functionDeclaration: src }, 10000))?.script || null; }
    catch { return null; }
  }

  /**
   * 原生弹窗不再阻塞页面。
   * Firefox 的 BiDi 弹窗事件默认就是 dismiss（事件里 handler="dismiss"，此时
   * 再发 handleUserPrompt 会报 no such alert），所以直接在 preload 里拦掉，
   * 语义等价于业务代码里的 page.on('dialog', d => d.accept())。
   */
  async neutralizeDialogs() {
    const src = `() => {
      try {
        window.alert = () => {};
        window.confirm = () => true;
        window.prompt = (message, defaultValue) => defaultValue === undefined ? '' : defaultValue;
      } catch (e) {}
    }`;
    try { return (await this.send('script.addPreloadScript', { functionDeclaration: src }, 10000))?.script || null; }
    catch { return null; }
  }

  /** 读取响应体（自动按 Content-Encoding 解压） */
  async getResponseBody(params) {
    const reqId = params?.request?.request;
    if (!reqId) return '';
    const args = { request: reqId, dataType: 'response', disown: true };
    if (this.collector) args.collector = this.collector;
    let res;
    try { res = await this.send('network.getData', args, 30000); }
    catch { return ''; }
    const b64 = res?.bytes?.value || '';
    if (!b64) return '';
    const enc = (params.response?.headers || [])
      .find((h) => String(h.name).toLowerCase() === 'content-encoding')?.value?.value;
    return decodeBody(Buffer.from(b64, 'base64'), enc);
  }

  /**
   * 断开连接。
   * 默认只关 WebSocket、不关浏览器（与 Chromium 路径的 close() 语义一致：
   * 断开接管，把窗口留给用户；下一个阶段还能重新接回来）。
   */
  close({ quitBrowser = false } = {}) {
    if (quitBrowser) {
      try { this.send('browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
    }
    setTimeout(() => { try { this.ws.close(); } catch { /* ignore */ } }, quitBrowser ? 600 : 0);
    this.closed = true;
  }
}

/* ------------------------------------------------------------------ *
 * Firefox 启动与接管
 * ------------------------------------------------------------------ */

/** 安装到非默认目录时，从「应用路径」注册表项里找 firefox.exe */
function firefoxFromRegistry() {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/REG_SZ\s+(.+?)\s*$/m);
      const p = m && m[1].replace(/^"|"$/g, '').trim();
      if (p && existsSync(p)) return p;
    } catch { /* 未安装 */ }
  }
  return null;
}

/** 自动发现系统 Firefox（跟随环境变量，不写死盘符；再退回注册表） */
export function findFirefox() {
  const PF = process.env.ProgramFiles || 'C:\\Program Files';
  const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const LOCAL = process.env.LOCALAPPDATA || '';
  const cands = [
    join(PF, 'Mozilla Firefox', 'firefox.exe'),
    join(PF86, 'Mozilla Firefox', 'firefox.exe'),
    join(LOCAL, 'Mozilla Firefox', 'firefox.exe'),
  ];
  return cands.find((p) => p && existsSync(p)) || firefoxFromRegistry();
}

/** 结束占用指定 profile 的残留 firefox 进程（避免 profile 被锁） */
export function killFirefoxByProfile(profileDir) {
  try {
    const tag = profileDir.replace(/'/g, "''");
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`],
      { encoding: 'utf8', timeout: 20000 });
    return true;
  } catch { return false; }
}

/** 默认的 user.js：关掉首启噪音；webdriver 由 preload script 处理（pref 在 BiDi 下无效） */
const DEFAULT_PREFS = [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage_override.mstone", "ignore");',
  // 关掉浏览器后「恢复上次会话」：Firefox 的 session cookie 靠它才能跨重启保留登录
  'user_pref("browser.startup.page", 3);',
  'user_pref("browser.sessionstore.resume_from_crash", true);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.enabled", false);',
  'user_pref("app.update.enabled", false);',
  'user_pref("browser.tabs.warnOnClose", false);',
  'user_pref("browser.discovery.enabled", false);',
];

/** 等 HTTP 调试端口就绪 */
async function waitPort(port, timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  return false;
}

/** 接管后统一订阅的事件 */
const EVENTS = [
  'network.responseCompleted',
  'browsingContext.contextCreated',
  'browsingContext.contextDestroyed',
  // 下面三个用来维护「当前地址」，供同步的 page.url() 使用
  'browsingContext.navigationStarted',
  'browsingContext.historyUpdated',
  'browsingContext.load',
  // 原生 alert/confirm/prompt（不处理会一直卡住页面）
  'browsingContext.userPromptOpened',
];

/** 接管后的公共准备：抹 webdriver、开响应体收集、订阅事件 */
async function prepare(conn) {
  // 顺序有讲究：preload 要早于任何导航；收集器要早于会抓 body 的请求
  await conn.hideWebdriver();
  await conn.neutralizeDialogs();
  await conn.enableBodyCollector();
  await conn.subscribe(EVENTS);
  return conn;
}

/** 端口上已经有一个我们之前拉起的 Firefox 时，直接接回去（不重启、不丢现场） */
async function tryAttach(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok && res.status !== 404) return null;
  } catch { return null; }
  try {
    const conn = await BidiConnection.open(`ws://127.0.0.1:${port}/session`, { timeoutMs: 12000 });
    return await prepare(conn);
  } catch { return null; }
}

/**
 * 启动系统 Firefox 并用 BiDi 接管。
 * @param {{exe?:string, profile?:string, port?:number, fresh?:boolean, extraPrefs?:string[]}} opts
 * @returns {Promise<{conn:BidiConnection, port:number, profile:string, exe:string, describe:string, close:()=>void}>}
 */
export async function launchFirefoxBidi(opts = {}) {
  const exe = opts.exe || findFirefox();
  if (!exe) throw new Error('未找到 firefox.exe（可用 --browser-exe 指定路径）');

  const profile = opts.profile || join(process.cwd(), 'browser-profile-firefox');
  const port = opts.port ?? 9224;

  // 已在运行就接回去：一键流程的每个阶段都是独立进程，
  // 如果每次都重启 Firefox，登录现场和正在播放的视频都会丢。
  if (!opts.fresh) {
    const attached = await tryAttach(port);
    if (attached) {
      const close = () => { try { attached.close(); } catch { /* ignore */ } };
      return {
        conn: attached, port, profile, exe,
        describe: `firefox @ BiDi ${port} (${attached.capabilities?.browserVersion || '?'}, 复用已开窗口)`,
        close,
      };
    }
  }

  killFirefoxByProfile(profile);
  if (opts.fresh) rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  // user.js 里的 prefs 每次启动都会覆盖，写进去是幂等的
  const prefs = [...DEFAULT_PREFS, ...(opts.extraPrefs || [])].join('\n');
  writeFileSync(join(profile, 'user.js'), prefs + '\n', 'utf8');

  spawn(exe, [
    '-no-remote',
    '--profile', profile,
    '--remote-debugging-port', String(port),
    '--no-first-run',
    'about:blank',
  ], { detached: true, stdio: 'ignore' }).unref();

  if (!await waitPort(port)) {
    killFirefoxByProfile(profile);
    throw new Error(`Firefox 调试端口 ${port} 启动超时（profile: ${profile}）`);
  }

  const conn = await prepare(await BidiConnection.open(`ws://127.0.0.1:${port}/session`));

  const close = () => { conn.close(); };
  return {
    conn, port, profile, exe,
    describe: `firefox @ BiDi ${port} (${conn.capabilities.browserVersion || '?'})`,
    close,
  };
}
