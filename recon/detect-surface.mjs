// 检测面自检：判断「自动化被识别」到底发生在哪一层
//
// 分五层看：
//   1) 协议/驱动层：navigator.webdriver、CDP/Playwright 注入痕迹、伪装是否可被反查
//   2) 环境层：headless 特征、窗口/焦点/可见性、WebGL、UA 一致性
//   3) 行为层：用真实输入在临时浮层上打点，看页面能观测到的轨迹/停留/节律
//   4) 第三方风控：页面实际加载了哪些验证码/指纹 SDK
//   5) 服务端层：本次访问触发了哪些 4xx/5xx 与风控响应
//
// 用法：
//   node recon/detect-surface.mjs
//   node recon/detect-surface.mjs --browser firefox
//   node recon/detect-surface.mjs --url https://onlineweb.zhihuishu.com/onlinestuh5 --reload
//   node recon/detect-surface.mjs --no-behavior     跳过行为探针
//
// 只读诊断：除临时浮层探针外，不改页面数据、不提交任何表单。

import { connect, readyPage, HOME } from '../src/core/browser.mjs';
import { humanType } from '../src/core/login-flow.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const round1 = (n) => Math.round(n * 10) / 10;

/* ------------------------------ 参数 ------------------------------ */

function parseArgs(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) out[k] = v;
    else if (list[i + 1] && !list[i + 1].startsWith('--')) { out[k] = list[i + 1]; i++; }
    else out[k] = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`检测面自检

  node recon/detect-surface.mjs [选项]

  --browser chromium|firefox   接管方式，默认 chromium（Edge/CDP）
  --browser-exe <路径>         指定任意浏览器可执行文件
  --url <地址>                 目标页，默认 ${HOME}
  --reload                     自检前刷新目标页（能多抓一轮首屏请求）
  --no-behavior                跳过真实输入探针
`);
  process.exit(0);
}

/* ------------------------------ 输出 ------------------------------ */

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
};

function sec(t) { console.log(`\n${C.b('=== ' + t + ' ===')}\x1b[0m`); }
function ok(label, detail = '') { console.log(`  ${C.ok('✅')} ${label}${detail ? '  ' + C.dim(detail) : ''}`); }
function warn(label, detail = '') { console.log(`  ${C.warn('⚠️')} ${label}${detail ? '  ' + C.dim(detail) : ''}`); }
function bad(label, detail = '') { console.log(`  ${C.bad('❌')} ${label}${detail ? '  ' + C.dim(detail) : ''}`); }
function info(label, detail = '') { console.log(`  ${C.dim('·')} ${label}${detail ? '  ' + C.dim(detail) : ''}`); }

/* ------------------------------ 主流程 ------------------------------ */

const prefer = args.browser === 'firefox' ? 'firefox' : 'chromium';
let session;
try {
  session = await connect({ prefer, exe: args['browser-exe'] || null });
} catch (e) {
  bad('浏览器接管失败', String(e).slice(0, 300));
  console.log('\n先跑 `node zhs.mjs doctor` 确认浏览器可用。');
  process.exit(1);
}

const { ctx, describe, close, kind } = session;
console.log(C.dim(`接管方式：${describe}（${kind}）`));

const target = args.url || HOME;
const page = await readyPage(ctx, target);
await page.waitForTimeout(2500);

/* --------------------- 5) 服务端响应（先挂监听） --------------------- */

const responses = [];
page.on('response', async (r) => {
  try {
    if (responses.length > 300) return;
    const url = r.url();
    const status = r.status();
    if (!/zhihuishu|polymas/.test(url)) return;
    const rec = { url, status };
    if (status >= 400) {
      try { rec.body = (await r.text()).slice(0, 240).replace(/\s+/g, ' '); } catch { /* 响应体可能已释放 */ }
    }
    responses.push(rec);
  } catch { /* 忽略单个响应异常 */ }
});

if (args.reload) {
  console.log(C.dim(`刷新目标页以捕获完整请求：${target}`));
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(4000);
}

/* ------------------------- 1/2/4) 页面内采集 ------------------------- */

const env = await page.evaluate(async () => {
  const nav = navigator;
  const out = {};

  out.url = location.href;
  out.title = document.title;
  out.ua = nav.userAgent;
  out.platform = nav.platform;
  out.vendor = nav.vendor;
  out.languages = Array.from(nav.languages || []);
  out.language = nav.language;
  out.hardwareConcurrency = nav.hardwareConcurrency;
  out.deviceMemory = nav.deviceMemory ?? null;
  out.maxTouchPoints = nav.maxTouchPoints;
  out.plugins = nav.plugins ? nav.plugins.length : -1;
  out.mimeTypes = nav.mimeTypes ? nav.mimeTypes.length : -1;
  out.webdriver = nav.webdriver;
  out.hasChrome = typeof window.chrome === 'object' && window.chrome !== null;
  out.chromeKeys = out.hasChrome ? Object.keys(window.chrome).slice(0, 20) : [];
  out.userAgentData = nav.userAgentData
    ? { brands: nav.userAgentData.brands, mobile: nav.userAgentData.mobile, platform: nav.userAgentData.platform }
    : null;

  out.screen = { w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight, dpr: devicePixelRatio, colorDepth: screen.colorDepth };
  out.window = { outerW: outerWidth, outerH: outerHeight, innerW: innerWidth, innerH: innerHeight };
  out.visibility = document.visibilityState;
  out.hasFocus = document.hasFocus();
  out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  out.tzOffsetMin = -new Date().getTimezoneOffset();

  out.connection = nav.connection
    ? { effectiveType: nav.connection.effectiveType, rtt: nav.connection.rtt, downlink: nav.connection.downlink }
    : null;

  // webdriver 的真实来源：是浏览器原生值，还是被脚本改写过的 getter
  try {
    const isNative = (fn) => {
      try { return /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn)); } catch { return null; }
    };
    const proto = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    const own = Object.getOwnPropertyDescriptor(nav, 'webdriver');
    out.webdriverDesc = {
      onProto: !!proto,
      onInstance: !!own,
      protoGetterNative: proto && proto.get ? isNative(proto.get) : null,
      instanceGetterNative: own && own.get ? isNative(own.get) : null,
    };
  } catch (e) {
    out.webdriverDesc = { error: String(e).slice(0, 120) };
  }

  // WebGL：headless 常见 SwiftShader / 空渲染器
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      out.webgl = {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      };
    } else {
      out.webgl = null;
    }
  } catch { out.webgl = null; }

  // 驱动/自动化框架残留的全局变量
  const suspicious = [];
  for (const k of Object.getOwnPropertyNames(window)) {
    if (/^(cdc_|__cdc|_phantom|callPhantom|__nightmare|domAutomation|domAutomationController|__webdriver|_selenium|__selenium|puppeteer|__puppeteer|__playwright|__pw_)/i.test(k)) {
      suspicious.push(k);
    }
  }
  out.suspiciousGlobals = suspicious;
  out.playwrightArtifacts = ['__playwright', '__pwInitScripts', '__playwright__binding__', '__pw_manual']
    .filter((k) => k in window);

  // 已加载的风控/验证码 SDK（全局对象）
  const sdkGlobals = [];
  const checks = [
    ['易盾', () => !!window.yidun || !!window.YidunCaptcha],
    ['极验', () => !!window.initGeetest || !!window.Geetest],
    ['腾讯防水墙', () => !!window.TencentCaptcha || !!window.TCaptcha],
    ['数美', () => !!window._smConf || !!window.smcp || !!window.SMConf],
    ['顶象', () => !!window.DXCaptcha || !!window.dingxiang],
    ['reCAPTCHA', () => !!window.grecaptcha],
    ['hCaptcha', () => !!window.hcaptcha],
    ['Turnstile', () => !!window.turnstile],
    ['FingerprintJS', () => !!window.FingerprintJS || !!window.Fingerprint2],
  ];
  for (const [name, fn] of checks) {
    try { if (fn()) sdkGlobals.push(name); } catch { /* 忽略 */ }
  }
  out.sdkGlobals = sdkGlobals;

  // 脚本 / iframe 里出现过的风控资源
  const urls = [];
  for (const s of Array.from(document.scripts || [])) if (s.src) urls.push(s.src);
  for (const f of Array.from(document.querySelectorAll('iframe'))) if (f.src) urls.push(f.src);
  out.assetHosts = Array.from(new Set(urls.map((u) => {
    try { return new URL(u).host; } catch { return ''; }
  }).filter(Boolean))).slice(0, 60);
  out.riskAssets = urls.filter((u) => /captcha|yidun|dun\.163|geetest|tcaptcha|smcp|ishumei|fingerprint|fpjs|recaptcha|hcaptcha|turnstile|akamai|_abck|riversecurity|tongdun|dingxiang/i.test(u)).slice(0, 20);

  return out;
}).catch((e) => ({ error: String(e).slice(0, 200) }));

if (env.error) {
  bad('页面内采集失败', env.error);
}

/* ------------------------------ 0) 概况 ------------------------------ */

sec('0) 概况');
info('当前页', `${env.title || '(无标题)'}  ${String(env.url || page.url()).slice(0, 110)}`);
info('UA', String(env.ua || '').slice(0, 120));

let cookieCount = 0;
let keyTickets = [];
try {
  const cookies = await ctx.cookies();
  const zhs = cookies.filter((c) => /zhihuishu|polymas/.test(c.domain));
  cookieCount = zhs.length;
  keyTickets = zhs.filter((c) => /SESSION|JSESSIONID|CASTGC|jt-cas|polymas-token/i.test(c.name)).map((c) => c.name);
} catch { /* 忽略 */ }
info('登录态', `智慧树 cookie ${cookieCount} 条，关键票据 ${keyTickets.length} 条${keyTickets.length ? '（' + keyTickets.slice(0, 6).join(', ') + '）' : ''}`);
if (cookieCount === 0) warn('当前没有智慧树 cookie：未登录状态下的行为更容易被风控按匿名流量处理');

/* ------------------------ 1) 协议/驱动层 ------------------------ */

sec('1) 协议 / 驱动指纹');
const protocolIssues = [];

if (env.webdriver === false) ok('navigator.webdriver = false');
else if (env.webdriver === true) { bad('navigator.webdriver = true'); protocolIssues.push('webdriver=true'); }
else info('navigator.webdriver = ' + String(env.webdriver));

const d = env.webdriverDesc || {};
if (d.onInstance) {
  bad('navigator.webdriver 被定义在实例上（原生属性在 Navigator.prototype）');
  protocolIssues.push('webdriver 定义位置异常');
}
if (d.protoGetterNative === false || d.instanceGetterNative === false) {
  bad('webdriver 的 getter 不是原生函数，可被 Function.prototype.toString 反查');
  protocolIssues.push('webdriver getter 非原生');
} else if (d.onProto && d.protoGetterNative) {
  ok('webdriver 描述符与原生实现一致');
}

if ((env.suspiciousGlobals || []).length) {
  bad('发现自动化残留全局变量', env.suspiciousGlobals.join(', '));
  protocolIssues.push('可疑全局变量');
} else {
  ok('未发现 cdc_ / puppeteer / playwright 等注入残留');
}

if ((env.playwrightArtifacts || []).length) {
  bad('发现 Playwright 注入标记', env.playwrightArtifacts.join(', '));
  protocolIssues.push('Playwright 注入标记');
}

const isChromiumUA = /Chrome|Chromium|Edg\//.test(env.ua || '');
if (isChromiumUA) {
  if (env.hasChrome) ok('window.chrome 存在', (env.chromeKeys || []).join(','));
  else { warn('Chromium 系 UA 但 window.chrome 缺失'); protocolIssues.push('window.chrome 缺失'); }
} else {
  info('非 Chromium UA，跳过 window.chrome 检查');
}

if (env.plugins === 0 && isChromiumUA) {
  warn('navigator.plugins 为 0：真实 Chromium 通常至少有 PDF 相关项');
  protocolIssues.push('plugins 为空');
} else {
  info(`plugins=${env.plugins}  mimeTypes=${env.mimeTypes}`);
}

if (env.userAgentData) {
  const brands = (env.userAgentData.brands || []).map((b) => `${b.brand}/${b.version}`).join(' ');
  info('userAgentData', `${brands}  platform=${env.userAgentData.platform}  mobile=${env.userAgentData.mobile}`);
  if (isChromiumUA && !(env.userAgentData.brands || []).length) {
    warn('UA 声称 Chromium，但 userAgentData.brands 为空');
  }
} else if (isChromiumUA) {
  warn('UA 声称 Chromium，但 navigator.userAgentData 不存在（版本过旧或被裁剪）');
}

/* --------------------------- 2) 环境层 --------------------------- */

sec('2) 环境一致性');
const envIssues = [];
const w = env.window || {};
const s = env.screen || {};

if (/Headless/i.test(env.ua || '')) { bad('UA 中出现 Headless'); envIssues.push('Headless UA'); }
else ok('UA 未出现 Headless 关键字');

const frameW = (w.outerW || 0) - (w.innerW || 0);
const frameH = (w.outerH || 0) - (w.innerH || 0);
if (isChromiumUA && (w.outerW === 0 || frameW <= 0)) {
  warn(`窗口无边框特征（outer-inner = ${frameW}×${frameH}），疑似 headless/无头窗口`);
  envIssues.push('无边框窗口');
} else {
  info(`窗口 ${w.innerW}×${w.innerH}，边框 ${frameW}×${frameH}，屏幕 ${s.w}×${s.h} @${s.dpr}x`);
}

if (env.visibility !== 'visible') { warn(`document.visibilityState = ${env.visibility}`); envIssues.push('页面不可见'); }
else ok('页面可见（visibilityState=visible）');

if (env.hasFocus === false) { warn('页面未获得焦点：后台标签页会被部分风控记为异常'); envIssues.push('页面未聚焦'); }
else ok('页面已聚焦');

const gl = env.webgl || {};
const glText = String(gl.unmaskedRenderer || gl.renderer || '');
if (!env.webgl) { warn('WebGL 上下文创建失败'); envIssues.push('WebGL 不可用'); }
else if (/SwiftShader|Software|llvmpipe/i.test(glText)) { warn('WebGL 使用软件渲染', glText.slice(0, 90)); envIssues.push('软件渲染'); }
else ok('WebGL 硬件渲染', glText.slice(0, 90));

info('硬件', `cores=${env.hardwareConcurrency}  memory=${env.deviceMemory ?? '?'}GB  touch=${env.maxTouchPoints}`);
info('语言/时区', `${(env.languages || []).join(',')}  ${env.timezone} (UTC${env.tzOffsetMin >= 0 ? '+' : ''}${(env.tzOffsetMin || 0) / 60})`);
if (!(env.languages || []).length) { warn('navigator.languages 为空'); envIssues.push('语言列表为空'); }
if (env.connection) info('网络特征', `type=${env.connection.effectiveType} rtt=${env.connection.rtt} downlink=${env.connection.downlink}`);

/* ------------------------ 4) 第三方风控 SDK ------------------------ */

sec('4) 第三方风控 / 验证码 SDK');
const SDK_PATTERNS = [
  ['易盾', /yidun|dun\.163\.com/i],
  ['极验', /geetest/i],
  ['腾讯防水墙', /tcaptcha|tencentcaptcha|captcha\.qq\.com/i],
  ['数美', /smcp|ishumei|fengkong/i],
  ['顶象', /dingxiang|dx-captcha/i],
  ['同盾', /tongdun|td\.captcha/i],
  ['瑞数', /riversecurity|FSSBBIl1UgzbN7N/i],
  ['reCAPTCHA', /recaptcha/i],
  ['hCaptcha', /hcaptcha/i],
  ['Cloudflare Turnstile', /turnstile|challenges\.cloudflare/i],
  ['FingerprintJS', /fingerprintjs|fpjs/i],
];
const sdk = new Set(env.sdkGlobals || []);
for (const [name, re] of SDK_PATTERNS) {
  if ((env.riskAssets || []).some((u) => re.test(u))) sdk.add(name);
}
const sdkList = Array.from(sdk);
if (sdkList.length) {
  warn('本页加载了：' + sdkList.join(' · '));
  if (sdkList.includes('易盾') || sdkList.includes('极验') || sdkList.includes('数美')) {
    info('这类 SDK 通常同时采集：环境指纹 + 鼠标轨迹 + 按键节律 + 页面可见性');
  }
  if (sdkList.includes('FingerprintJS')) info('FingerprintJS 会生成跨会话设备指纹，换输入层不改变该指纹');
} else {
  ok('本页未发现已知风控 SDK（不排除其它页面或接口才有）');
}
if ((env.riskAssets || []).length) {
  info('风控资源', env.riskAssets.map((u) => u.slice(0, 90)).join('  |  '));
}

/* --------------------------- 3) 行为层 --------------------------- */

let behavior = null;
if (args['no-behavior']) {
  sec('3) 行为面（已跳过：--no-behavior）');
} else if (env.error) {
  sec('3) 行为面（页面采集失败，跳过）');
} else {
  sec('3) 行为面（真实输入探针）');
  behavior = await runBehaviorProbe(page, kind);
  printBehavior(behavior);
}

/* --------------------------- 5) 服务端层 --------------------------- */

sec('5) 服务端响应');
const risky = responses.filter((r) => r.status >= 400);
const watch = responses.filter((r) => /captcha|risk|verify|check|exam/i.test(r.url));
if (!responses.length) {
  info('本次未捕获到智慧树响应（加 --reload 可以多抓一轮）');
} else {
  const byStatus = {};
  for (const r of responses) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  info('响应统计', Object.entries(byStatus).sort().map(([k, v]) => `${k}×${v}`).join('  '));
  for (const r of risky.slice(0, 10)) {
    const tag = r.status === 403 || r.status === 412 || r.status === 418 || r.status === 429 || r.status === 421 ? bad : warn;
    tag(`${r.status} ${r.url.slice(0, 110)}`, r.body ? `\n      ${r.body.slice(0, 180)}` : '');
  }
  if (!risky.length) ok('没有 4xx/5xx');
  for (const r of watch.slice(0, 6)) info('风控相关接口', `${r.status} ${r.url.slice(0, 100)}`);
}

/* ------------------------------ 结论 ------------------------------ */

sec('结论');
const behaviorIssues = behavior ? (behavior.C ? behavior.actual : behavior.issues) : [];
const serverIssues = risky.filter((r) => [403, 412, 418, 421, 429].includes(r.status));

const layer = (name, issues) => {
  if (!issues.length) ok(`${name}：干净`);
  else if (issues.length <= 2) warn(`${name}：${issues.join('；')}`);
  else bad(`${name}：${issues.join('；')}`);
};

layer('协议层', protocolIssues);
layer('环境层', envIssues);
if (behavior) layer('行为层', behaviorIssues);
if (sdkList.length) warn('风控 SDK：' + sdkList.join(' · '));
if (serverIssues.length) bad('服务端：本次出现 ' + serverIssues.map((r) => r.status).join('/') + '，优先看上面的响应体');

console.log('');
if (behavior && behaviorIssues.length) {
  info('建议', '行为层是最可疑的一层：真实输入探针已经能区分「流水线式」和「拟人式」输入');
  info('', '低成本做法：登录/关键表单改用逐字输入（随机 70–170ms），点击前补多段轨迹 + 随机停留');
}
if (protocolIssues.length) {
  info('建议', '协议层有残留时，才值得考虑 OS 级输入（Windows-MCP / SendInput），因为它能消掉驱动与注入痕迹');
}
if (!protocolIssues.length && !envIssues.length && behavior && !behaviorIssues.length && !serverIssues.length) {
  info('建议', '这一页三层都干净：问题可能在别的页面/接口，或服务端按账号/IP/设备打分，需针对报错那一次抓包');
}
if (sdkList.length && !behaviorIssues.length) {
  info('建议', '有风控 SDK 但行为探针无异常：重点查 SDK 上报的字段（设备指纹、页面路径、停留时长）');
}

console.log(C.dim('\n提示：本脚本只做诊断，不修改页面、不提交表单。'));

await close();
process.exit(0);

/* ═════════════════════════ 行为探针实现 ═════════════════════════ */

function makeDriver(p) {
  // Chromium/Playwright：直接有 mouse/keyboard
  if (p.mouse && p.keyboard && typeof p.mouse.move === 'function') {
    return {
      label: 'playwright',
      move: (x, y) => p.mouse.move(x, y),
      down: () => p.mouse.down(),
      up: () => p.mouse.up(),
      click: (x, y) => p.mouse.click(x, y),
      typeChar: (ch) => p.keyboard.type(ch),
    };
  }
  // Firefox/BiDi：没有 Playwright 的 mouse 适配，直接走 input.performActions
  const send = (actions) => p.conn.send('input.performActions', { context: p.contextId, actions }, 10000);
  const pointer = (actions) => send([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }]);
  return {
    label: 'bidi',
    move: (x, y) => pointer([{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), duration: 0 }]),
    down: () => pointer([{ type: 'pointerDown', button: 0 }]),
    up: () => pointer([{ type: 'pointerUp', button: 0 }]),
    click: (x, y) => pointer([
      { type: 'pointerMove', x: Math.round(x), y: Math.round(y), duration: 0 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ]),
    typeChar: (ch) => send([{ type: 'key', id: 'keyboard', actions: [
      { type: 'keyDown', value: ch },
      { type: 'keyUp', value: ch },
    ] }]),
  };
}

async function runBehaviorProbe(p, browserKind) {
  const drv = makeDriver(p);
  const geo = await p.evaluate(() => {
    const old = document.getElementById('__detect_surface_probe__');
    if (old) old.remove();

    const host = document.createElement('div');
    host.id = '__detect_surface_probe__';
    host.style.cssText = 'position:fixed;left:100px;top:100px;width:320px;height:180px;z-index:2147483647;'
      + 'background:rgba(0,0,0,0.02);border:1px dashed rgba(0,0,0,0.25);border-radius:6px;';
    const input = document.createElement('input');
    input.id = '__detect_surface_input__';
    input.type = 'text';
    input.style.cssText = 'position:absolute;left:20px;top:130px;width:220px;height:30px;'
      + 'font-size:14px;border:1px solid #999;border-radius:4px;padding:0 6px;';
    host.appendChild(input);
    document.documentElement.appendChild(host);

    window.__detectLog = [];
    window.__detectHandlers = [];
    const types = ['mousemove', 'pointermove', 'mousedown', 'pointerdown', 'mouseup', 'pointerup', 'click', 'keydown', 'keyup', 'input', 'beforeinput'];
    const push = (e) => {
      const log = window.__detectLog;
      if (!log || log.length > 4000) return;
      log.push({
        t: e.type,
        ts: Math.round(performance.now() * 10) / 10,
        trusted: !!e.isTrusted,
        x: typeof e.clientX === 'number' ? Math.round(e.clientX) : null,
        y: typeof e.clientY === 'number' ? Math.round(e.clientY) : null,
        key: e.key || null,
        target: (e.target && (e.target.id || e.target.tagName)) || '',
      });
    };
    for (const t of types) {
      document.addEventListener(t, push, true);
      window.__detectHandlers.push([t, push]);
    }

    const r = host.getBoundingClientRect();
    const ir = input.getBoundingClientRect();
    return {
      clicks: [0.22, 0.5, 0.78].map((f, i) => ({
        x: Math.round(r.left + r.width * f),
        y: Math.round(r.top + 45 + i * 24),
      })),
      input: { x: Math.round(ir.left + ir.width / 2), y: Math.round(ir.top + ir.height / 2) },
    };
  });

  const mark = (name) => p.evaluate((n) => {
    if (window.__detectLog) window.__detectLog.push({ t: '__mark__', ts: Math.round(performance.now() * 10) / 10, key: n });
  }, name);

  const { clicks, input } = geo;
  const text = 'abc123';

  // A 组：贴近当前流水线——瞬移、零停留、固定节奏
  await mark('pipeline');
  let cur = { x: clicks[0].x - 40, y: clicks[0].y - 30 };
  for (const pt of clicks) {
    await drv.move(pt.x, pt.y);
    await sleep(120);
    await drv.down();
    await drv.up();
    await sleep(200);
    cur = pt;
  }
  await drv.click(input.x, input.y);
  await sleep(100);
  for (const ch of text) await drv.typeChar(ch);
  await sleep(120);

  // B 组：拟人式——多段轨迹 + 随机停留 + 非均匀按键
  await mark('human');
  for (const pt of clicks) {
    const steps = 12;
    for (let i = 1; i <= steps; i++) {
      const nx = cur.x + (pt.x - cur.x) * (i / steps);
      const ny = cur.y + (pt.y - cur.y) * (i / steps);
      await drv.move(nx + rand(-1.5, 1.5), ny + rand(-1.5, 1.5));
      await sleep(rand(8, 22));
    }
    await sleep(rand(60, 160));
    await drv.down();
    await sleep(rand(55, 130));
    await drv.up();
    await sleep(rand(220, 520));
    cur = pt;
  }
  await drv.click(input.x, input.y);
  await sleep(rand(150, 300));
  for (const ch of text) {
    await drv.typeChar(ch);
    await sleep(rand(70, 170));
  }
  await sleep(150);

  // C 组：直接跑生产代码的 humanType（点击 + 逐字输入），验证真实登录写法
  await p.evaluate(() => {
    const el = document.getElementById('__detect_surface_input__');
    if (el) { el.value = ''; el.focus(); }
  });
  await mark('actual');
  await humanType(p, '#__detect_surface_input__', text).catch(() => {});
  await sleep(150);

  const log = await p.evaluate(() => {
    const l = window.__detectLog || [];
    for (const [t, fn] of window.__detectHandlers || []) document.removeEventListener(t, fn, true);
    const el = document.getElementById('__detect_surface_probe__');
    if (el) el.remove();
    delete window.__detectLog;
    delete window.__detectHandlers;
    return l;
  });

  const phases = {};
  let phase = null;
  for (const e of log) {
    if (e.t === '__mark__') { phase = e.key; phases[phase] = []; continue; }
    if (phase) phases[phase].push(e);
  }

  const analyze = (evts) => {
    const count = (t) => evts.filter((e) => e.t === t).length;
    const times = (t) => evts.filter((e) => e.t === t).map((e) => e.ts);
    const stats = (arr) => {
      if (!arr.length) return null;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
      return { n: arr.length, mean: round1(mean), sd: round1(sd), min: round1(Math.min(...arr)), max: round1(Math.max(...arr)) };
    };
    const inter = (t) => {
      const ts = times(t);
      return ts.slice(1).map((v, i) => v - ts[i]);
    };
    // 按下→抬起（中间会夹杂 pointerup 等事件，不能只看相邻两条）
    const downUp = [];
    for (let i = 0; i < evts.length; i++) {
      if (evts[i].t !== 'mousedown') continue;
      for (let k = i + 1; k < evts.length; k++) {
        if (evts[k].t === 'mouseup') { downUp.push(evts[k].ts - evts[i].ts); break; }
        if (evts[k].t === 'mousedown') break;
      }
    }
    const movePts = evts.filter((e) => e.t === 'mousemove' && e.x != null && e.y != null);
    const relevant = evts.filter((e) => ['mousedown', 'mouseup', 'click', 'keydown', 'input'].includes(e.t));
    return {
      moves: count('mousemove'),
      pointerMoves: count('pointermove'),
      movePoints: new Set(movePts.map((e) => e.x + ',' + e.y)).size,
      mouseDown: count('mousedown'),
      pointerDown: count('pointerdown'),
      clicks: count('click'),
      keyDown: count('keydown'),
      inputEvents: count('input'),
      dwell: stats(downUp),
      clickGap: stats(inter('mousedown')),
      keyGap: stats(inter('keydown')),
      trustedRatio: relevant.length ? relevant.filter((e) => e.trusted).length / relevant.length : null,
      pointerEventsSeen: count('pointerdown') + count('pointerup') + count('pointermove'),
    };
  };

  const A = analyze(phases.pipeline || []);
  const B = analyze(phases.human || []);
  const Cg = phases.actual ? analyze(phases.actual) : null;

  const issues = [];
  if (A.trustedRatio !== null && A.trustedRatio < 1) issues.push(`存在非可信事件（可信率 ${Math.round(A.trustedRatio * 100)}%）`);
  if ((browserKind === 'cdp' || browserKind === 'chromium') && A.pointerEventsSeen === 0) issues.push('没有 pointer 事件（真实鼠标必然产生）');
  if (A.moves <= clicks.length) issues.push('点击前无中间轨迹（瞬移）');
  if (A.dwell && A.dwell.mean < 5) issues.push(`按下→抬起 ${A.dwell.mean}ms（无停留）`);
  if (A.keyGap && A.keyGap.mean < 15) issues.push(`按键间隔均值 ${A.keyGap.mean}ms`);
  if (A.keyGap && A.keyGap.sd < 5) issues.push(`按键间隔 σ=${A.keyGap.sd}ms（机械节律）`);
  if (A.clickGap && A.clickGap.sd < 5) issues.push(`点击间隔 σ=${A.clickGap.sd}ms（固定节拍）`);

  // C 组 = 生产代码的 humanType：它应该和 B 组一样有轨迹、停留、逐字按键
  const actual = [];
  if (Cg) {
    if (Cg.trustedRatio !== null && Cg.trustedRatio < 1) actual.push('存在不可信事件');
    if (Cg.keyDown === 0 && Cg.inputEvents > 0) actual.push(`整段 ${text.length} 字符一次写入，零 keydown/keyup（fill / insertText 特征）`);
    if (Cg.keyGap && Cg.keyGap.mean < 40) actual.push(`按键间隔均值仅 ${Cg.keyGap.mean}ms（脚本节律）`);
    if (Cg.keyGap && Cg.keyGap.sd < 10) actual.push(`按键间隔 σ=${Cg.keyGap.sd}ms（过于均匀）`);
    if (Cg.movePoints <= Cg.clicks) actual.push('点击前无中间轨迹（瞬移）');
  }

  return { driver: drv.label, A, B, C: Cg, issues, actual };
}

function printBehavior(b) {
  const cols = [['A 流水线（对照）', b.A], ['B 拟人（对照）', b.B]];
  if (b.C) cols.push(['C humanType（实际）', b.C]);

  const cell = (v, unit = '') => (v === null || v === undefined || v === false ? '-' : v + unit);
  const rows = [
    ['点击前轨迹点', (x) => cell(x.movePoints)],
    ['mousemove / pointermove', (x) => `${x.moves} / ${x.pointerMoves}`],
    ['mousedown / pointerdown', (x) => `${x.mouseDown} / ${x.pointerDown}`],
    ['按下→抬起 均值', (x) => cell(x.dwell && x.dwell.mean, 'ms')],
    ['点击间隔 σ', (x) => cell(x.clickGap && x.clickGap.sd, 'ms')],
    ['按键间隔 均值/σ', (x) => (x.keyGap ? `${x.keyGap.mean} / ${x.keyGap.sd}ms` : '-')],
    ['keydown / input 次数', (x) => `${x.keyDown} / ${x.inputEvents}`],
    ['事件可信率', (x) => (x.trustedRatio === null ? '-' : Math.round(x.trustedRatio * 100) + '%')],
  ];

  const w1 = 24;
  const wc = 22;
  console.log(`  ${C.dim('输入通道：' + b.driver)}`);
  console.log(`  ${'指标'.padEnd(w1)}${cols.map(([name]) => name.padEnd(wc)).join('')}`);
  for (const [k, fn] of rows) {
    console.log(`  ${k.padEnd(w1)}${cols.map(([, x]) => String(fn(x)).padEnd(wc)).join('')}`);
  }

  if (b.issues.length) {
    bad(`A 组机械化特征 ${b.issues.length} 项`);
    for (const it of b.issues) console.log(`      · ${it}`);
  } else {
    ok('A 组未发现明显机械化特征');
  }
  if (b.actual && b.actual.length) {
    bad(`C 组（humanType 实际写法）特征 ${b.actual.length} 项`);
    for (const it of b.actual) console.log(`      · ${it}`);
  }
  if (b.B.moves > b.A.moves * 3) {
    info('对照', `B 组多出 ${b.B.moves - b.A.moves} 个轨迹点，页面完全能观测到这个差异`);
  }
}
