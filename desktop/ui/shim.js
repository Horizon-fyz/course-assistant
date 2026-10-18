/**
 * desktop/ui/shim.js —— WinForms + WebView2 环境下的 window.zhs 桥
 *
 * 作用：用 WebView2 的消息通道，实现与 Electron preload 完全相同的 window.zhs 接口，
 * 因此 app.js / float.js 不需要任何改动即可复用。
 *
 * 必须在 app.js / float.js 之前加载（普通 script，非 module）。
 */
(function () {
  const wv = window.chrome && window.chrome.webview;
  if (!wv) {
    // 普通浏览器打开时没有宿主桥，保持 window.zhs 未定义，页面会走降级分支
    return;
  }

  let seq = 1;
  const pending = new Map();
  const stateListeners = [];
  const logListeners = [];

  // 宿主没有回包时不能一直挂着：按消息类型给出不同上限
  const DEFAULT_TIMEOUT = 30000;
  const TIMEOUTS = {
    'vision:once': 120000,   // 内含截屏 + 编码
    'page:scan': 300000,     // 网页扫描可能包含 AI 作答
    'page:apply': 300000,    // 回填答案
    'file:pickBank': 300000, // 等待用户选文件
    'file:saveText': 120000,
  };

  wv.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;

    // 请求应答
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject, timer } = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(timer);
      if (m.ok) resolve(m.data);
      else reject(new Error(m.error || '宿主返回错误'));
      return;
    }

    // 主动推送
    if (m.event === 'state:update') for (const f of stateListeners) f(m.data);
    else if (m.event === 'automation:log') for (const f of logListeners) f(m.data);
  });

  /** 请求/应答：调用宿主并等待结果（超时后抛出，避免界面永远转圈） */
  function call(type, payload) {
    return new Promise((resolve, reject) => {
      const id = seq++;
      const ms = TIMEOUTS[type] || DEFAULT_TIMEOUT;
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error('宿主响应超时（' + type + '）'));
      }, ms);
      pending.set(id, { resolve, reject, timer });
      try {
        wv.postMessage({ id, type, payload: payload === undefined ? null : payload });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  /** 单向通知：不等待结果（用于拖拽这类高频消息） */
  function post(type, payload) {
    wv.postMessage({ id: 0, type, payload: payload === undefined ? null : payload });
  }

  window.zhs = {
    isDesktop: true,

    // 配置
    getConfig: () => call('config:get'),
    setConfig: (patch) => call('config:set', patch),

    // 状态
    getState: () => call('state:get'),
    setState: (patch) => call('state:set', patch),
    onState: (cb) => { stateListeners.push(cb); return () => { const i = stateListeners.indexOf(cb); if (i >= 0) stateListeners.splice(i, 1); }; },

    // 悬浮窗
    openFloat: () => call('float:open'),
    closeFloat: () => call('float:close'),
    toggleFloat: () => call('float:toggle'),
    minimizeFloat: () => call('float:minimize'),

    // 截屏视觉识题
    visionOnce: () => call('vision:once'),
    startVision: () => call('vision:start'),
    stopVision: () => call('vision:stop'),
    toggleVision: () => call('vision:toggle'),

    // 本地题库
    getBankCount: () => call('bank:get'),
    clearBank: () => call('bank:clear'),

    // 退出
    quit: () => call('app:quit'),

    // 文件
    pickBank: () => call('file:pickBank'),
    saveText: (payload) => call('file:saveText', payload),

    // 浏览器页面操作（作用于主窗口的浏览器）
    scanPage: () => call('page:scan'),
    applyPage: () => call('page:apply'),
    login: () => call('page:login'),
    openPage: (url) => call('page:open', { url: url }),
    openSettings: (tab) => call('settings:open', { tab: tab || '' }),

    // 其它
    openExternal: (url) => call('shell:open', { url: url }),
    appInfo: () => call('app:info'),
    onAutomationLog: (cb) => { logListeners.push(cb); return () => { const i = logListeners.indexOf(cb); if (i >= 0) logListeners.splice(i, 1); }; },

    // 拖拽（无边框助手面板用）
    post: post,
  };
})();
