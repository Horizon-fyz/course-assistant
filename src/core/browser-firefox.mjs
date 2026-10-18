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
 * 在页面里解析「定位描述」。描述结构：
 *   { base: { kind:'css', value } | { kind:'text', value, exact },
 *     within: 父定位描述 | null,      // 只在该父元素内部找（locator 链式调用）
 *     filters: [{ hasText: { source, flags, isRe } }],
 *     pick: null(全部) | 数字 | 'last' }
 *
 * 选择器里的 Playwright 专有伪类 :visible 会被去掉，因为下面统一做可见性过滤。
 */
const RESOLVE = `(spec) => {
  if (!spec || !spec.base) return [];
  const vis = (e) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const all = (root, sel) => { try { return [...root.querySelectorAll(sel)]; } catch (e) { return []; } };
  const byText = (root, t, exact) => {
    const hit = (e) => { const s = (e.textContent || '').trim(); return exact ? s === t : s.includes(t); };
    return all(root, 'a,button,span,div,li,p,label,td,th,h1,h2,h3,h4,strong,em')
      .filter(hit).filter((e) => ![...e.children].some(hit));
  };
  const base = (s, root) => (s.base.kind === 'css'
    ? all(root, s.base.value)
    : byText(root, s.base.value, s.base.exact));
  const resolve = (s) => {
    let els = base(s, document);
    if (s.within) {
      const set = new Set();
      for (const root of resolve(s.within)) {
        for (const el of base(s, root)) if (el !== root) set.add(el);
      }
      els = [...set];
    }
    els = els.filter(vis);
    for (const f of s.filters || []) {
      if (!f.hasText) continue;
      const h = f.hasText;
      const re = h.isRe ? new RegExp(h.source, h.flags) : null;
      els = els.filter((e) => {
        const t = (e.textContent || '').trim();
        return re ? re.test(t) : t.includes(h.source);
      });
    }
    return s.pick == null ? els : (s.pick === 'last' ? els.slice(-1) : els.slice(s.pick, s.pick + 1));
  };
  return resolve(spec);
}`;

/** Playwright 选择器 → 定位描述 */
function specFromSelector(selector, within = null) {
  let s = String(selector).replace(/:visible/g, '');
  if (s.startsWith('text=')) {
    let t = s.slice(5);
    const quoted = /^".*"$/.test(t);
    if (quoted) t = t.slice(1, -1);
    return { base: { kind: 'text', value: t, exact: quoted }, within, filters: [], pick: null };
  }
  return { base: { kind: 'css', value: s }, within, filters: [], pick: null };
}

/** 定位器：实现业务代码用到的那部分 Playwright Locator API */
class BidiLocator {
  constructor(page, spec) {
    this.page = page;
    this.spec = spec;     // 见 RESOLVE 注释
  }

  first() { return new BidiLocator(this.page, { ...this.spec, pick: 0 }); }
  last() { return new BidiLocator(this.page, { ...this.spec, pick: 'last' }); }
  nth(i) { return new BidiLocator(this.page, { ...this.spec, pick: Math.max(0, Math.trunc(Number(i) || 0)) }); }

  /** 在当前结果内部继续找（对应 Playwright 的 locator.locator） */
  locator(selector) {
    return new BidiLocator(this.page, specFromSelector(selector, this.spec));
  }

  /** 在当前结果内部按文本找（对应 Playwright 的 locator.getByText） */
  getByText(text, opts = {}) {
    return new BidiLocator(this.page, {
      base: { kind: 'text', value: String(text), exact: Boolean(opts.exact) },
      within: this.spec, filters: [], pick: null,
    });
  }

  /** 对应 Playwright 的 locator.filter({ hasText }) */
  filter({ hasText } = {}) {
    const filters = [...(this.spec.filters || [])];
    if (hasText != null) {
      filters.push({
        hasText: hasText instanceof RegExp
          ? { source: hasText.source, flags: hasText.flags, isRe: true }
          : { source: String(hasText), isRe: false },
      });
    }
    return new BidiLocator(this.page, { ...this.spec, filters });
  }

  _expr(body) {
    return `(() => {
      const resolve = ${RESOLVE};
      const els = resolve(${j(this.spec)});
      ${body}
    })()`;
  }

  async count() {
    try { return Number(await this.page._eval(this._expr('return els.length;'), 10000)) || 0; }
    catch { return 0; }
  }

  /** 滚动到元素并返回视口中心坐标 */
  async _center() {
    return await this.page._eval(this._expr(`
      const el = els[0];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               w: Math.round(r.width), h: Math.round(r.height),
               tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40) };
    `), 15000);
  }

  async boundingBox() {
    return await this.page._eval(this._expr(`
      const el = els[0];
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    `), 15000).catch(() => null);
  }

  async scrollIntoViewIfNeeded() {
    await this.page._eval(this._expr(`
      const el = els[0];
      if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
      return true;
    `), 10000).catch(() => {});
  }

  async getAttribute(name) {
    return await this.page._eval(this._expr(`
      const el = els[0];
      return el ? el.getAttribute(${j(String(name))}) : null;
    `), 10000).catch(() => null);
  }

  async fill(text) {
    await this.page._eval(this._expr(`
      const el = els[0];
      if (!el) return false;
      const v = ${j(String(text))};
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    `), 10000).catch(() => {});
  }

  /** 对应 Playwright 的 locator.allInnerTexts() */
  async allInnerTexts() {
    try {
      const out = await this.page._eval(this._expr(
        'return els.map((e) => (e.innerText || e.textContent || "").trim());'
      ), 10000);
      return Array.isArray(out) ? out : [];
    } catch { return []; }
  }

  /** 对应 Playwright 的 locator.press(key)：先聚焦元素再按键 */
  async press(key) {
    await this.page._eval(this._expr(`
      const el = els[0];
      if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
      return true;
    `), 10000).catch(() => {});
    await this.page.keyboard.press(key);
  }

  /** 对应 Playwright 的 locator.type(text)：先聚焦元素再逐字输入 */
  async type(text, { delay = 0 } = {}) {
    await this.page._eval(this._expr(`
      const el = els[0];
      if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
      return true;
    `), 10000).catch(() => {});
    for (const ch of String(text)) {
      await this.page.keyboard.type(ch);
      if (delay > 0) await sleep(delay);
    }
  }

  async click({ timeout = 15000 } = {}) {
    const t0 = Date.now();
    let box = null;
    while (Date.now() - t0 < Math.min(timeout, 12000)) {
      box = await this._center().catch(() => null);
      if (box) break;
      await sleep(400);
    }
    if (!box) throw new Error(`定位失败（超时 ${timeout}ms）: ${JSON.stringify(this.spec.base)}`);

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
      expression: this._expr('const el = els[0]; if (el) el.click(); return true;'),
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

/* ---------------------------- 鼠标 / 键盘 ---------------------------- */

/**
 * BiDi 的按键值：命名键用 WebDriver 的 Unicode 私有区码位；
 * 其它（如 'a' / '1' / '/'）直接按字符发送。
 */
const KEYS = {
  Escape: '\uE00C', Enter: '\uE007', Tab: '\uE004', Backspace: '\uE003',
  Delete: '\uE017', Insert: '\uE016', Home: '\uE011', End: '\uE010',
  PageUp: '\uE00E', PageDown: '\uE00F',
  ArrowLeft: '\uE012', ArrowUp: '\uE013', ArrowRight: '\uE014', ArrowDown: '\uE015',
  Shift: '\uE008', Control: '\uE009', Alt: '\uE00A', Meta: '\uE03D',
  ' ': ' ',
};

const BUTTONS = { left: 0, middle: 1, right: 2 };

/** 真实鼠标事件（不经过 JS 执行上下文，触发器也不认脚本点击） */
class BidiMouse {
  constructor(page) {
    this.page = page;
    this.x = 0;
    this.y = 0;
  }

  _pointer(actions) {
    return this.page.conn.send('input.performActions', {
      context: this.page.contextId,
      actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }],
    }, 15000);
  }

  /** 支持 steps：拆成多个 pointerMove，模拟连续移动 */
  async move(x, y, { steps = 1 } = {}) {
    const n = Math.max(1, Math.trunc(Number(steps)) || 1);
    const toX = Number(x) || 0;
    const toY = Number(y) || 0;
    const fromX = this.x;
    const fromY = this.y;
    const actions = [];
    for (let i = 1; i <= n; i++) {
      actions.push({
        type: 'pointerMove',
        x: Math.round(fromX + ((toX - fromX) * i) / n),
        y: Math.round(fromY + ((toY - fromY) * i) / n),
        duration: 0,
      });
    }
    await this._pointer(actions);
    this.x = toX;
    this.y = toY;
  }

  async down({ button = 'left' } = {}) {
    await this._pointer([{ type: 'pointerDown', button: BUTTONS[button] ?? 0 }]);
  }

  async up({ button = 'left' } = {}) {
    await this._pointer([{ type: 'pointerUp', button: BUTTONS[button] ?? 0 }]);
  }

  async click(x, y, { button = 'left', delay = 0 } = {}) {
    await this.move(x, y);
    await this.down({ button });
    if (delay > 0) await sleep(delay);
    await this.up({ button });
  }
}

/** 真实键盘事件 */
class BidiKeyboard {
  constructor(page) { this.page = page; }

  _send(actions) {
    return this.page.conn.send('input.performActions', {
      context: this.page.contextId,
      actions: [{ type: 'key', id: 'keyboard', actions }],
    }, 15000);
  }

  /** 逐字符输入（对应 Playwright 的 keyboard.type） */
  async type(text) {
    for (const ch of String(text)) {
      await this._send([{ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch }]);
    }
  }

  /** 按键（对应 Playwright 的 keyboard.press，支持 'Control+a' 形式） */
  async press(key) {
    const parts = String(key).split('+');
    const main = parts.pop();
    const mods = parts.map((p) => KEYS[p] ?? p);
    const value = KEYS[main] ?? main;
    const actions = [];
    for (const m of mods) actions.push({ type: 'keyDown', value: m });
    actions.push({ type: 'keyDown', value }, { type: 'keyUp', value });
    for (const m of [...mods].reverse()) actions.push({ type: 'keyUp', value: m });
    await this._send(actions);
  }
}

/* ------------------------------- 弹窗 ------------------------------- */

/** 原生 alert / confirm / prompt（对应 Playwright 的 Dialog） */
class BidiDialog {
  constructor(page, params) {
    this._page = page;
    this._params = params || {};
    this._done = false;
  }

  type() { return this._params.type || 'alert'; }
  message() { return this._params.message || ''; }
  defaultValue() { return this._params.defaultValue ?? ''; }

  async accept(promptText) { await this._handle(true, promptText); }
  async dismiss() { await this._handle(false); }

  async _handle(accept, userText) {
    if (this._done) return;
    this._done = true;
    const params = { context: this._page.contextId, accept };
    if (userText !== undefined) params.userText = String(userText);
    // Firefox 默认已按 dismiss 处理弹窗，此时再发会报 no such alert —— 不算错误
    try { await this._page.conn.send('browsingContext.handleUserPrompt', params, 10000); }
    catch { /* 弹窗已被浏览器处理 */ }
  }

  _autoAccept() {
    if (this._done) return;
    this._handle(true).catch(() => {});
  }
}

class BidiPage {
  constructor(browser, contextId, url = 'about:blank') {
    this.browser = browser;
    this.conn = browser.launch.conn;
    this.contextId = contextId;
    this._lastUrl = url;
    this._closed = false;
    this._respHandlers = new Set();
    this._dialogHandlers = new Set();
    this.mouse = new BidiMouse(this);
    this.keyboard = new BidiKeyboard(this);
  }

  isClosed() { return this._closed; }

  url() { return this._lastUrl; }

  async title() { return await this._eval('document.title', 5000).catch(() => ''); }

  /**
   * 内部：执行页面脚本。
   * 只对「执行上下文被导航销毁」这类瞬时错误重试；页面脚本自身抛异常是确定性的，
   * 重试只会把同一份错误拖慢 3 倍，并掩盖真正的失败原因。
   */
  async _eval(expr, timeoutMs = 30000) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      let r;
      try {
        r = await this.conn.send('script.evaluate', {
          expression: expr,
          target: { context: this.contextId },
          awaitPromise: true,
          resultOwnership: 'none',
        }, timeoutMs);
      } catch (e) {
        lastErr = e;
        await sleep(300);
        continue;
      }
      if (r?.type === 'exception') {
        throw new Error('页面脚本异常: ' + String(r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || '').slice(0, 160));
      }
      return toJs(r?.result);
    }
    throw lastErr;
  }

  /** Playwright 风格 evaluate：函数按 (arg) 调用；字符串本身就是表达式，不能再追加 () */
  async evaluate(fn, arg) {
    const expr = typeof fn === 'string'
      ? fn
      : (arg === undefined ? `(${fn.toString()})()` : `(${fn.toString()})(${j(arg)})`);
    return await this._eval(expr);
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
    return new BidiLocator(this, specFromSelector(selector));
  }

  getByText(text, opts = {}) {
    return new BidiLocator(this, {
      base: { kind: 'text', value: String(text), exact: Boolean(opts.exact) },
      within: null,
      filters: [],
      pick: null,
    });
  }

  on(event, fn) {
    if (event === 'response') {
      this._respHandlers.add(fn);
      this.browser.ensureResponseDispatch();
    } else if (event === 'dialog') {
      this._dialogHandlers.add(fn);
      this.browser.ensureDialogDispatch();
    }
    // 其它事件（request 等）暂不需要，静默忽略
    return this;
  }

  off(event, fn) {
    if (event === 'response') this._respHandlers.delete(fn);
    else if (event === 'dialog') this._dialogHandlers.delete(fn);
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

  /**
   * 原生弹窗分发。没有处理器时立即接受（等价 Playwright 的默认行为），
   * 有处理器但迟迟没动作时 3 秒后兜底接受，避免整页被 alert 卡死。
   */
  _emitDialog(params) {
    const dialog = new BidiDialog(this, params);
    for (const fn of this._dialogHandlers) {
      try {
        const r = fn(dialog);
        // 处理器常写成 d.accept()（返回 Promise），必须吞掉拒绝，否则会变成未处理异常
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch { /* 忽略 */ }
    }
    if (!this._dialogHandlers.size) dialog._autoAccept();
    else setTimeout(() => dialog._autoAccept(), 3000);
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

  /**
   * 读取全部 cookie（对应 Playwright ctx.cookies()；login 固化票据要用）。
   * 失败必须显式告警：上层会把「空 cookie」当成未登录，静默吞错很难排查。
   */
  async cookies() {
    let r;
    try {
      r = await this.browser.launch.conn.send('storage.getCookies', {}, 20000);
    } catch (e) {
      console.log('   ⚠ Firefox 读取 cookie 失败: ' + String(e.message || e).slice(0, 120));
      return [];
    }
    const SS = { none: 'None', lax: 'Lax', strict: 'Strict' };
    return (r?.cookies || []).map((c) => ({
      name: c.name,
      value: c.value?.value ?? c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expiry ?? -1,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      // BiDi 的 sameSite 是 none/lax/strict；不确定时不要伪造 'None'（会被当真实属性回写）
      ...(c.sameSite ? { sameSite: SS[String(c.sameSite).toLowerCase()] || null } : {}),
    }));
  }

  /** 写入 cookie（对应 Playwright ctx.addCookies()）；失败只告警，不打断主流程 */
  async addCookies(list) {
    const SS = { none: 'none', lax: 'lax', strict: 'strict' };
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
        // 丢掉 sameSite 会让 None/Lax 语义变味（跨站票据可能失效）
        ...(SS[String(c.sameSite || '').toLowerCase()] ? { sameSite: SS[String(c.sameSite).toLowerCase()] } : {}),
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
    _dialogDispatching: false,
    ensureResponseDispatch() {
      if (this._dispatching) return;
      this._dispatching = true;
      launch.conn.on('network.responseCompleted', (params) => {
        const page = this.ctx?._pages.get(params.context);
        if (page) page._emitResponse(params);
      });
    },
    ensureDialogDispatch() {
      // 弹窗监听在 createFirefoxBrowser 里已无条件注册，这里只做占位
      this._dialogDispatching = true;
    },
    dropPage(id) { this.ctx?.dropPage(id); },
    async close() { await launch.close(); },
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

  // 原生弹窗：有处理器就交给页面，没有就自动接受（否则会永久挡住页面）
  launch.conn.on('browsingContext.userPromptOpened', (p) => {
    const id = p?.context;
    const page = ctx._pages.get(id);
    if (page) {
      page._emitDialog(p);
      return;
    }
    launch.conn.send('browsingContext.handleUserPrompt', { context: id, accept: true }, 8000).catch(() => {});
  });

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
