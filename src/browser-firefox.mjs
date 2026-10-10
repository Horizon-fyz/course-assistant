/**
 * browser-firefox.mjs —— 用 WebDriver BiDi 驱动的「Playwright 兼容」适配层
 *
 * 目的：让 pipeline / login 等既有代码在 Firefox 上原样跑，不需要改业务逻辑。
 * 只实现这些代码真正用到的那部分 Playwright API（不做完整实现）：
 *
 *   BrowserContext : pages() / newPage() / close() / newCDPSession()
 *   Page           : url() / goto() / reload() / title() / bringToFront() / close()
 *                    waitForTimeout() / evaluate() / locator() / getByText()
 *                    on('response'|'request') / off()
 *
 * 实现要点（都来自实测）：
 *   - evaluate → script.evaluate（awaitPromise），RemoteValue 需递归还原
 *   - 点击 → 先用 input.performActions 发真实鼠标事件（不依赖 JS 执行上下文，
 *     因此「点击触发导航」不会导致调用卡死），失败才退回脚本点击
 *   - 响应体 → network.responseCompleted 事件 + network.getData（需 collector）
 *
 * @module browser-firefox
 */
import { toJs } from './bidi.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v) => JSON.stringify(v === undefined ? null : v);

/* ----------------------------- 元素定位 ----------------------------- */

/**
 * 构造「在页面里找元素」的 JS 表达式（返回元素数组）。
 * 文本匹配时只保留最内层命中元素，避免点到包住整块的外层容器。
 */
function matchExpr({ css, text, exact }) {
  if (css != null) {
    return `(() => {
      try { return [...document.querySelectorAll(${j(css)})]; } catch (e) { return []; }
    })()`;
  }
  return `(() => {
    const t = ${j(text)};
    const exact = ${exact ? 'true' : 'false'};
    const hit = (e) => { const s = (e.textContent || '').trim(); return exact ? s === t : s.includes(t); };
    const all = [...document.querySelectorAll('a,button,span,div,li,p,label,td,th,h1,h2,h3,h4,strong,em')];
    return all.filter(hit).filter((e) => ![...e.children].some(hit));
  })()`;
}

/** 可见性过滤（在页面内执行，接在匹配表达式后面） */
const VISIBLE = `(els) => els.filter((e) => {
  const r = e.getBoundingClientRect();
  const s = getComputedStyle(e);
  return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.pointerEvents !== 'none';
})`;

/** 定位器：只实现用到的 count / first / click */
class BidiLocator {
  constructor(page, query, index = null) {
    this.page = page;
    this.query = query;     // { css } 或 { text, exact }
    this.index = index;     // null = 全部；0 = first()
  }

  first() { return new BidiLocator(this.page, this.query, 0); }

  _visibleExpr() {
    const base = matchExpr(this.query);
    return `(() => { const vis = ${VISIBLE}; const els = vis(${base}); return ${this.index === null ? 'els' : `els.slice(0, 1)`}; })()`;
  }

  async count() {
    try {
      const r = await this.page._eval(`${this._visibleExpr()}.length`, 10000);
      return Number(r) || 0;
    } catch { return 0; }
  }

  /** 滚动到元素并返回视口中心坐标 */
  async _center() {
    const expr = `(() => {
      const vis = ${VISIBLE};
      const els = vis(${matchExpr(this.query)});
      const el = els[${this.index === null ? 0 : this.index}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               w: Math.round(r.width), h: Math.round(r.height),
               tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40) };
    })()`;
    return await this.page._eval(expr, 15000);
  }

  async click({ timeout = 15000 } = {}) {
    const t0 = Date.now();
    let box = null;
    while (Date.now() - t0 < Math.min(timeout, 12000)) {
      box = await this._center().catch(() => null);
      if (box) break;
      await sleep(400);
    }
    if (!box) throw new Error(`定位失败（超时 ${timeout}ms）: ${this.query.css ?? 'text=' + this.query.text}`);

    // 主路径：真实鼠标事件。它不经过 JS 执行上下文，点击引发导航时也不会让调用卡死
    try {
      await this.page.conn.send('input.performActions', {
        context: this.page.contextId,
        actions: [{
          type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: box.x, y: box.y, duration: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        }],
      }, 15000);
      return;
    } catch { /* 落到脚本点击 */ }

    // 兜底：脚本点击（发出去就不等结果，导航会销毁执行上下文）
    await this.page.conn.fire('script.evaluate', {
      expression: `(() => { const vis = ${VISIBLE}; const els = vis(${matchExpr(this.query)}); const el = els[${this.index === null ? 0 : this.index}]; if (el) el.click(); })()`,
      target: { context: this.page.contextId },
      awaitPromise: false,
      resultOwnership: 'none',
    });
  }
}

/* -------------------------------- 页面 -------------------------------- */

/** 响应对象：只实现 url / status / headers / text / json */
class BidiResponse {
  constructor(conn, params) {
    this._conn = conn;
    this._params = params;
    this._body = null;
  }
  url() { return this._params.response?.url || ''; }
  status() { return this._params.response?.status ?? 0; }
  headers() {
    const out = {};
    for (const h of this._params.response?.headers || []) out[String(h.name).toLowerCase()] = h.value?.value ?? '';
    return out;
  }
  async text() {
    if (this._body === null) this._body = await this._conn.getResponseBody(this._params);
    return this._body;
  }
  async json() { return JSON.parse(await this.text()); }
}

class BidiPage {
  constructor(browser, contextId, url = 'about:blank') {
    this.browser = browser;
    this.conn = browser.launch.conn;
    this.contextId = contextId;
    this._lastUrl = url;
    this._closed = false;
    this._respHandlers = new Set();
  }

  isClosed() { return this._closed; }

  url() { return this._lastUrl; }

  async title() { return await this._eval('document.title', 5000).catch(() => ''); }

  /** 内部：执行页面脚本（带重试，容忍导航导致的上下文销毁） */
  async _eval(expr, timeoutMs = 30000) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await this.conn.send('script.evaluate', {
          expression: expr,
          target: { context: this.contextId },
          awaitPromise: true,
          resultOwnership: 'none',
        }, timeoutMs);
        if (r?.type === 'exception') {
          throw new Error('页面脚本异常: ' + String(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || '').slice(0, 160));
        }
        return toJs(r?.result);
      } catch (e) {
        lastErr = e;
        await sleep(300);
      }
    }
    throw lastErr;
  }

  /** Playwright 风格 evaluate：支持 fn(无参) 与 fn(arg)，支持 async */
  async evaluate(fn, arg) {
    const src = typeof fn === 'string' ? fn : `(${fn.toString()})`;
    return await this._eval(arg === undefined ? `${src}()` : `${src}(${j(arg)})`);
  }

  async goto(url, { waitUntil = 'domcontentloaded', timeout = 30000 } = {}) {
    const wait = waitUntil === 'domcontentloaded' ? 'interactive' : 'complete';
    this._lastUrl = url;
    try {
      await this.conn.send('browsingContext.navigate', { context: this.contextId, url, wait }, timeout);
    } catch {
      // 超时不致命：SPA / 长轮询页面常常等不到 complete，交给调用方自己 waitForTimeout
    }
  }

  async reload({ waitUntil = 'domcontentloaded', timeout = 30000 } = {}) {
    const wait = waitUntil === 'domcontentloaded' ? 'interactive' : 'complete';
    try {
      await this.conn.send('browsingContext.reload', { context: this.contextId, wait }, timeout);
    } catch { /* 同 goto */ }
  }

  async waitForTimeout(ms) { await sleep(ms); }

  async bringToFront() {
    try { await this.conn.send('browsingContext.activate', { context: this.contextId }, 8000); } catch { /* 老版本不支持 */ }
  }

  locator(selector) {
    const s = String(selector);
    if (s.startsWith('text=')) {
      let t = s.slice(5);
      const quoted = /^".*"$/.test(t);
      if (quoted) t = t.slice(1, -1);
      return new BidiLocator(this, { text: t, exact: quoted });
    }
    return new BidiLocator(this, { css: s });
  }

  getByText(text, opts = {}) {
    return new BidiLocator(this, { text: String(text), exact: Boolean(opts.exact) });
  }

  on(event, fn) {
    if (event === 'response') {
      this._respHandlers.add(fn);
      this.browser.ensureResponseDispatch();
    }
    // 其它事件（request 等）暂不需要，静默忽略
    return this;
  }

  off(event, fn) {
    if (event === 'response') this._respHandlers.delete(fn);
    return this;
  }

  async close() {
    this._closed = true;
    this.browser.dropPage(this.contextId);
    try { await this.conn.send('browsingContext.close', { context: this.contextId }, 8000); } catch { /* 已关闭 */ }
  }

  /** 浏览器级响应事件分发入口 */
  _emitResponse(params) {
    if (!this._respHandlers.size) return;
    const resp = new BidiResponse(this.conn, params);
    for (const fn of this._respHandlers) {
      try { fn(resp); } catch { /* 单个处理器出错不影响其它 */ }
    }
  }
}

/* ------------------------------- 上下文 ------------------------------- */

class BidiBrowserContext {
  constructor(browser) {
    this.browser = browser;
    this._pages = new Map(); // contextId → BidiPage
    /**
     * 能力声明，供上层按需降级：
     *   persistCookies —— Firefox 未实现 storage.setCookies，无法用协议改写 cookie 过期时间；
     *                     会话改为依赖 Firefox 自身的「恢复上次会话」（见 bidi.mjs 的 prefs）。
     */
    this.capabilities = { persistCookies: false, cdp: false, bidi: true };
  }

  pages() { return [...this._pages.values()].filter((p) => !p.isClosed()); }

  async newPage() {
    const r = await this.browser.launch.conn.send('browsingContext.create', { type: 'tab' }, 20000);
    const id = r?.context;
    const page = new BidiPage(this.browser, id, 'about:blank');
    this._pages.set(id, page);
    return page;
  }

  async close() { await this.browser.close(); }

  /** 读取全部 cookie（对应 Playwright ctx.cookies()；login 固化票据要用） */
  async cookies() {
    const r = await this.browser.launch.conn.send('storage.getCookies', {}, 20000).catch(() => ({ cookies: [] }));
    return (r?.cookies || []).map((c) => ({
      name: c.name,
      value: c.value?.value ?? c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expiry ?? -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite ? String(c.sameSite)[0].toUpperCase() + String(c.sameSite).slice(1) : 'None',
    }));
  }

  /** 写入 cookie（对应 Playwright ctx.addCookies()）；失败只告警，不打断主流程 */
  async addCookies(list) {
    const cookies = (list || [])
      .filter((c) => c && c.name && c.domain)
      .map((c) => ({
        name: c.name,
        value: { type: 'string', value: String(c.value ?? '') },
        domain: c.domain,
        path: c.path || '/',
        ...(Number(c.expires) > 0 ? { expiry: Math.floor(Number(c.expires)) } : {}),
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
      }));
    if (!cookies.length) return;
    try {
      await this.browser.launch.conn.send('storage.setCookies', { cookies }, 30000);
    } catch (e) {
      console.log('   ⚠ Firefox 写入 cookie 失败（会话可能无法长期保留）: ' + String(e).slice(0, 120));
    }
  }

  /** Firefox 没有 CDP，显式抛错让调用方的 try/catch 生效（例如 tidy 里的窗口最大化） */
  async newCDPSession() { throw new Error('Firefox/BiDi 不支持 CDP'); }

  async addPage(id, url) {
    if (this._pages.has(id)) return this._pages.get(id);
    const page = new BidiPage(this.browser, id, url || 'about:blank');
    this._pages.set(id, page);
    return page;
  }

  dropPage(id) { this._pages.delete(id); }
}

/* -------------------------------- 出口 -------------------------------- */

/**
 * 把一次 Firefox BiDi 启动包装成与 Chromium 路径一致的结构。
 * @param {{conn:object, port:number, profile:string, describe:string, close:Function}} launch
 * @returns {Promise<{kind:string, browserName:string, browser:null, ctx:object, describe:string, close:Function, launch:object}>}
 */
export async function createFirefoxBrowser(launch) {
  const browser = {
    launch,
    ctx: null,
    _dispatching: false,
    ensureResponseDispatch() {
      if (this._dispatching) return;
      this._dispatching = true;
      launch.conn.on('network.responseCompleted', (params) => {
        const page = this.ctx?._pages.get(params.context);
        if (page) page._emitResponse(params);
      });
    },
    dropPage(id) { this.ctx?.dropPage(id); },
    async close() { launch.close(); },
  };

  const ctx = new BidiBrowserContext(browser);
  browser.ctx = ctx;

  // 种子页面 + 跟踪后续新建/关闭
  const tree = await launch.conn.send('browsingContext.getTree', {}, 15000).catch(() => ({ contexts: [] }));
  for (const c of tree.contexts || []) await ctx.addPage(c.context, c.url);

  launch.conn.on('browsingContext.contextCreated', (p) => {
    const info = p.context || {};
    if (!info.parent) ctx.addPage(info.context, info.url);
  });
  launch.conn.on('browsingContext.contextDestroyed', (p) => {
    const id = p.context?.context ?? p.context;
    if (typeof id === 'string') ctx.dropPage(id);
  });

  // 维护 page.url()：Playwright 是同步的，所以只能靠事件把最新地址记下来。
  // 点击触发的导航（pipeline 里大量使用）不会经过 goto()，必须靠这些事件补上。
  const trackUrl = (p) => {
    const id = p.context;
    const url = p.url;
    if (typeof id !== 'string' || typeof url !== 'string') return;
    const page = ctx._pages.get(id);
    if (page) page._lastUrl = url;
  };
  launch.conn.on('browsingContext.navigationStarted', trackUrl);
  launch.conn.on('browsingContext.historyUpdated', trackUrl);
  launch.conn.on('browsingContext.load', trackUrl);

  return {
    kind: 'bidi',
    browserName: 'firefox',
    browser: null,
    ctx,
    describe: launch.describe,
    close: () => browser.close(),
    launch,
  };
}
