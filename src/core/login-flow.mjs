// 浏览器无关的「登录态校验 + 自动登录」公共模块
//
// 为什么要抽出来：Edge 走 CDP、Firefox 走 Playwright 持久化 profile，
// 两者拿到的都是标准 Playwright Page，登录表单逻辑应当完全共用，
// 否则每加一个浏览器就要重抄一遍学校下拉框的坑。
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAccount } from './accounts.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

export const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin';
export const API_USERINFO = 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo';

/**
 * 读取凭据（多来源，优先级见 src/core/accounts.mjs）。
 * 兼容旧调用：返回 `{ file, ...凭据字段 }`，找不到返回 null。
 */
export function loadAccount(opts = {}) {
  const r = resolveAccount(opts);
  if (!r.complete) return null;
  const files = [...new Set(Object.values(r.source).filter((s) => s && s !== 'cli' && s !== 'env'))];
  return { file: files[0] ?? '(命令行/环境变量)', sources: r.source, ...r.acc };
}

/** 读凭据的完整信息（含来源、缺失项），供 CLI 报错时给出可操作的提示 */
export function loadAccountDetail(opts = {}) {
  return resolveAccount(opts);
}

/** 当前会话是否已登录 */
export async function checkLogin(page) {
  try {
    return await page.evaluate(async (api) => {
      const r = await fetch(api, { credentials: 'include' });
      const j = await r.json();
      return { code: j.code, user: j.result };
    }, API_USERINFO);
  } catch (e) { return { code: -1, err: String(e).slice(0, 120) }; }
}

/** 是否出现真正的易盾验证码容器 */
export async function captchaVisible(page) {
  return page.evaluate(() => {
    const hit = [...document.querySelectorAll('[class*="yidun"]')].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 100 && r.height > 60;
    });
    const ifr = [...document.querySelectorAll('iframe')].filter((f) => /dun\.163|captcha|yidun/i.test(f.src || ''));
    return hit.length + ifr.length;
  }).catch(() => 0);
}

/* ------------------------- 拟人输入原语 ------------------------- */
//
// 直接 fill() 会让整段文本「一次写入」：页面只能看到一个 input 事件、
// 零 keydown/keyup。易盾这类 SDK 会把它当脚本特征（见 recon/detect-surface.mjs）。
// 这里改成：移动轨迹 + 按下停留 + 逐字输入、非均匀间隔。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

let lastMouse = null;

/** 统一输入通道：Chromium 用 Playwright，Firefox/BiDi 用 input.performActions */
function inputDriver(page) {
  if (page.mouse && page.keyboard && typeof page.mouse.move === 'function') {
    return {
      label: 'playwright',
      move: (x, y) => page.mouse.move(x, y),
      down: () => page.mouse.down(),
      up: () => page.mouse.up(),
      typeChar: (ch) => page.keyboard.type(ch),
    };
  }
  const conn = page.conn;
  if (conn && typeof conn.send === 'function') {
    const send = (actions) => conn.send('input.performActions', { context: page.contextId, actions }, 10000);
    const pointer = (actions) => send([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }]);
    return {
      label: 'bidi',
      move: (x, y) => pointer([{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), duration: 0 }]),
      down: () => pointer([{ type: 'pointerDown', button: 0 }]),
      up: () => pointer([{ type: 'pointerUp', button: 0 }]),
      typeChar: (ch) => send([{ type: 'key', id: 'keyboard', actions: [
        { type: 'keyDown', value: ch },
        { type: 'keyUp', value: ch },
      ] }]),
    };
  }
  return null;
}

/** 元素中心点：selector 会跳过隐藏元素；也接受 Playwright / BiDi locator */
async function centerOf(page, target) {
  if (typeof target === 'string') {
    return page.evaluate((sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, target).catch(() => null);
  }
  if (target && typeof target.boundingBox === 'function') {
    if (typeof target.scrollIntoViewIfNeeded === 'function') {
      await target.scrollIntoViewIfNeeded().catch(() => {});
    }
    const box = await target.boundingBox().catch(() => null);
    return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
  }
  if (target && typeof target._center === 'function') {
    const box = await target._center().catch(() => null);
    return box ? { x: box.x, y: box.y } : null;
  }
  return null;
}

/** 多段贝塞尔轨迹 + 抖动 + 随机步间延时 */
async function humanMove(drv, to) {
  const from = lastMouse ?? { x: to.x + rnd(-280, 280), y: to.y + rnd(-200, 200) };
  const steps = 8 + Math.floor(Math.random() * 7);
  const cx = (from.x + to.x) / 2 + rnd(-60, 60);
  const cy = (from.y + to.y) / 2 + rnd(-40, 40);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * cx + t ** 2 * to.x;
    const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * cy + t ** 2 * to.y;
    await drv.move(x + rnd(-1.5, 1.5), y + rnd(-1.5, 1.5));
    await sleep(rnd(8, 22));
  }
  lastMouse = { x: to.x, y: to.y };
}

/** 拟人点击：轨迹 → 随机停留 → 按下 → 停留 55–130ms → 抬起 */
export async function humanClick(page, target, { drv = null } = {}) {
  const d = drv ?? inputDriver(page);
  if (!d) throw new Error('没有可用的输入通道');
  const c = await centerOf(page, target);
  if (!c) throw new Error('定位失败: ' + (typeof target === 'string' ? target : 'locator'));
  await humanMove(d, c);
  await sleep(rnd(60, 160));
  await d.down();
  await sleep(rnd(55, 130));
  await d.up();
  lastMouse = { x: c.x, y: c.y };
  await sleep(rnd(160, 420));
  return c;
}

/** 拟人输入：点击聚焦 → 清空残留 → 逐字输入（70–170ms 随机间隔） */
export async function humanType(page, target, text, { drv = null } = {}) {
  const d = drv ?? inputDriver(page);
  if (!d) {
    await page.locator(target).fill(text);
    return String(text).length;
  }
  await humanClick(page, target, { drv: d });

  // 清空已有内容：Chromium 用 fill('')（触发真实 input 事件）；BiDi 直接改值
  const cur = await page.evaluate((sel) => {
    if (typeof sel !== 'string') return '';
    const el = document.querySelector(sel);
    return el ? String(el.value ?? '') : '';
  }, target).catch(() => '');
  if (cur) {
    let cleared = false;
    try {
      const loc = page.locator(target).first();
      if (typeof loc.fill === 'function') { await loc.fill(''); cleared = true; }
    } catch { /* 交给下面的脚本清空 */ }
    if (!cleared) await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, target).catch(() => {});
  }

  for (const ch of String(text)) {
    await d.typeChar(ch);
    await sleep(rnd(70, 170));
  }
  await sleep(rnd(120, 260));
  return String(text).length;
}


/**
 * 在给定 page 上完成「学号登录」表单。
 * 学校下拉框是易错点：必须精确选中 ACC.school，不能落到同名前缀项或列表首项。
 */
export async function fillLoginForm(page, acc, { log = console.log, shotDir = null } = {}) {
  const SCHOOL = acc.school;
  const drv = inputDriver(page);
  if (drv) log(`[form] 输入通道: ${drv.label}（拟人模式：轨迹 + 停留 + 逐字输入）`);
  const shot = async (name) => {
    if (!shotDir) return;
    try { mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: join(shotDir, name) }); } catch {}
  };

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);

  log('[form] 切换到「学号登录」…');
  await humanClick(page, page.getByText('学号登录', { exact: true }).first(), { drv })
    .catch(() => page.getByText('学号登录', { exact: true }).first().click({ timeout: 15000 }))
    .catch(() => {});
  await page.waitForTimeout(2000);

  log(`[form] 选择学校 = ${SCHOOL}`);
  let picked = null;
  try {
    await humanType(page, 'input.el-select__input', SCHOOL, { drv }).catch(async () => {
      // 兜底：定位不到元素时退回旧写法
      const sel = page.locator('input.el-select__input:visible').first();
      await sel.click({ timeout: 10000 });
      await page.waitForTimeout(800);
      await sel.fill('');
      await sel.type(SCHOOL, { delay: 90 });
    });
    await page.waitForTimeout(3000);

    const opts = page.locator('.el-select-dropdown__item:visible');
    const texts = await opts.allInnerTexts().catch(() => []);
    log('[form] 下拉候选: ' + JSON.stringify(texts.slice(0, 8)));

    const exact = opts.filter({ hasText: new RegExp(`^\\s*${SCHOOL}\\s*$`) }).first();
    if (await exact.count()) {
      await humanClick(page, exact, { drv }).catch(() => exact.click({ timeout: 8000 }));
      picked = SCHOOL;
    } else {
      const sel = page.locator('input.el-select__input:visible').first();
      await sel.press('ArrowDown').catch(() => {});
      await page.waitForTimeout(600);
      await sel.press('Enter').catch(() => {});
      picked = texts[0] ?? null;
    }
    await page.waitForTimeout(1500);
  } catch (e) { log('[form] ⚠️ 选择学校异常: ' + String(e).split('\n')[0].slice(0, 120)); }

  // 回读：学校下拉实际选中的文本（el-select 把显示值放在 .el-select__selected-item）
  const shown = await page.evaluate(() => {
    const box = document.querySelector('.el-select');
    if (!box) return '';
    const sel = box.querySelector('.el-select__selected-item, .el-select__placeholder');
    return ((sel?.innerText || box.innerText || '').trim().split('\n')[0] || '');
  }).catch(() => '');
  const schoolVerified = shown.includes(SCHOOL);
  log(`[form] 学校字段显示: "${shown}"  ${schoolVerified ? '✓' : '⚠️ 可能不对'}`);
  if (!schoolVerified && shown) {
    log(`[form] ⚠️ 请求的是「${SCHOOL}」，页面显示「${shown}」——若登录成功，将以页面实际值为准`);
  }

  log('[form] 填学号与密码…');
  await humanType(page, 'input[name="unid"]', acc.studentId, { drv })
    .catch(() => page.locator('input[name="unid"]').fill(acc.studentId))
    .catch(() => {});
  await humanType(page, 'input[type="password"]', acc.password, { drv })
    .catch(() => page.locator('input[type="password"]:visible').first().fill(acc.password))
    .catch(() => {});
  await page.waitForTimeout(600);

  log('[form] 勾选用户协议…');
  await humanClick(page, page.getByText('我已阅读并同意').first(), { drv }).catch(async () => {
    await page.locator('.el-checkbox:visible').first().click({ timeout: 5000 }).catch(() => {});
  });
  await page.waitForTimeout(800);
  let chk = await page.evaluate(() => document.querySelector('input.el-checkbox__original')?.checked ?? null).catch(() => null);
  if (!chk) {
    await humanClick(page, '.el-checkbox', { drv })
      .catch(() => page.locator('.el-checkbox:visible').first().click({ force: true }))
      .catch(() => {});
    await page.waitForTimeout(800);
    chk = await page.evaluate(() => document.querySelector('input.el-checkbox__original')?.checked ?? null).catch(() => null);
  }
  log('[form] 协议勾选: ' + chk);

  await shot('form-filled.png');

  log('[form] 提交…');
  await humanClick(page, 'div.btn-block__grandient_login', { drv })
    .catch(() => page.locator('div.btn-block__grandient_login').first().click({ timeout: 12000 }))
    .catch(() => {});
  return { picked, shown, schoolVerified, schoolShown: shown };
}

/**
 * 完整的「确保登录」流程：
 *  1) 先看是否已登录
 *  2) 否则填表提交
 *  3) 轮询等待（出现易盾验证码时提示人工完成）
 *
 * 返回 { code, user, form } —— form 里带上页面实际选中的学校，便于回写「平台真值」。
 */
export async function ensureLoggedIn(page, acc, { log = console.log, waitMs = 8 * 60 * 1000, shotDir = null } = {}) {
  const before = await checkLogin(page);
  if (before.code === 200) {
    log(`[login] 已登录: ${before.user?.realName}`);
    return { ...before, form: null };
  }

  const form = await fillLoginForm(page, acc, { log, shotDir });

  const t0 = Date.now();
  let announced = false;
  while (Date.now() - t0 < waitMs) {
    await page.waitForTimeout(3000);
    const st = await checkLogin(page);
    if (st.code === 200) {
      log(`[login] ✅ 登录成功: ${st.user?.realName}`);
      return { ...st, form };
    }
    if (!announced && (await captchaVisible(page)) > 0) {
      announced = true;
      if (shotDir) { try { await page.screenshot({ path: join(shotDir, 'captcha.png') }); } catch {} }
      log('[login] ⚠️ 出现人机验证，请在浏览器窗口里完成（自动等待中，最多 ' + Math.round(waitMs / 60000) + ' 分钟）…');
    }
  }
  return { code: -1, err: '登录等待超时', form };
}
