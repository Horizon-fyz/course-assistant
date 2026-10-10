// 浏览器无关的「登录态校验 + 自动登录」公共模块
//
// 为什么要抽出来：Edge 走 CDP、Firefox 走 Playwright 持久化 profile，
// 两者拿到的都是标准 Playwright Page，登录表单逻辑应当完全共用，
// 否则每加一个浏览器就要重抄一遍学校下拉框的坑。
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAccount } from './accounts.mjs';

const ROOT = join(import.meta.dirname, '..');

export const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin';
export const API_USERINFO = 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo';

/**
 * 读取凭据（多来源，优先级见 src/accounts.mjs）。
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

/**
 * 在给定 page 上完成「学号登录」表单。
 * 学校下拉框是易错点：必须精确选中 ACC.school，不能落到同名前缀项或列表首项。
 */
export async function fillLoginForm(page, acc, { log = console.log, shotDir = null } = {}) {
  const SCHOOL = acc.school;
  const shot = async (name) => {
    if (!shotDir) return;
    try { mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: join(shotDir, name) }); } catch {}
  };

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);

  log('[form] 切换到「学号登录」…');
  await page.getByText('学号登录', { exact: true }).first().click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);

  log(`[form] 选择学校 = ${SCHOOL}`);
  let picked = null;
  try {
    const sel = page.locator('input.el-select__input:visible').first();
    await sel.click({ timeout: 10000 });
    await page.waitForTimeout(800);
    await sel.fill('');
    await sel.type(SCHOOL, { delay: 90 });
    await page.waitForTimeout(3000);

    const opts = page.locator('.el-select-dropdown__item:visible');
    const texts = await opts.allInnerTexts().catch(() => []);
    log('[form] 下拉候选: ' + JSON.stringify(texts.slice(0, 8)));

    const exact = opts.filter({ hasText: new RegExp(`^\\s*${SCHOOL}\\s*$`) }).first();
    if (await exact.count()) {
      await exact.click({ timeout: 8000 });
      picked = SCHOOL;
    } else {
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
  await page.locator('input[name="unid"]').fill(acc.studentId).catch(() => {});
  await page.locator('input[type="password"]:visible').first().fill(acc.password).catch(() => {});
  await page.waitForTimeout(600);

  log('[form] 勾选用户协议…');
  await page.getByText('我已阅读并同意').first().click({ timeout: 8000 }).catch(async () => {
    await page.locator('.el-checkbox:visible').first().click({ timeout: 5000 }).catch(() => {});
  });
  await page.waitForTimeout(800);
  let chk = await page.evaluate(() => document.querySelector('input.el-checkbox__original')?.checked ?? null).catch(() => null);
  if (!chk) {
    await page.locator('.el-checkbox:visible').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    chk = await page.evaluate(() => document.querySelector('input.el-checkbox__original')?.checked ?? null).catch(() => null);
  }
  log('[form] 协议勾选: ' + chk);

  await shot('form-filled.png');

  log('[form] 提交…');
  await page.locator('div.btn-block__grandient_login').first().click({ timeout: 12000 }).catch(() => {});
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
