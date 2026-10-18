// 用一个全新的临时 profile 访问智慧树登录页，抓真实登录表单的 DOM
// （已登录的专用 profile 会被重定向回首页，看不到表单）
// 用法：node recon\archive\login-dom2.mjs
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'recon', 'login');
mkdirSync(OUT, { recursive: true });

const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin';
const PORT = 9233;
const PROFILE = join(OUT, 'tmp-profile');

const log = (m) => process.stdout.write(m + '\n');

// 找 Edge
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const EDGE = [
  join(PF86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
].find((p) => existsSync(p));
if (!EDGE) { log('未找到 Edge'); process.exit(1); }

log('启动全新 profile 的 Edge: ' + EDGE);
mkdirSync(PROFILE, { recursive: true });
spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1280,900',
  LOGIN_URL,
], { detached: true, stdio: 'ignore' }).unref();

// 等调试端口
let up = false;
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) { up = true; break; }
  } catch { /* 继续等 */ }
}
if (!up) { log('Edge 调试端口未就绪'); process.exit(1); }
log('已连上，等待登录页渲染…');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
let page = ctx.pages().find((p) => /zhihuishu/.test(p.url())) ?? (await ctx.newPage());
if (!/login\.zhihuishu/.test(page.url())) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
}
await page.waitForTimeout(7000);

log('当前 url: ' + page.url());

// 尝试切换到「学号登录」
try {
  const tab = page.getByText('学号登录', { exact: true }).first();
  if (await tab.count()) { await tab.click({ timeout: 8000 }); log('已点击「学号登录」'); await page.waitForTimeout(2500); }
  else log('⚠️ 页面上没有「学号登录」文字');
} catch (e) { log('点击失败: ' + String(e).slice(0, 100)); }

const dump = async () => page.evaluate(() => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const info = (sel) => {
    const els = [...document.querySelectorAll(sel)];
    const vis = els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    return {
      count: els.length, visible: vis.length,
      sample: els.slice(0, 3).map((e) => ({
        tag: e.tagName, type: e.type || null, name: e.name || null,
        cls: (e.className || '').toString().slice(0, 90),
        placeholder: e.placeholder || null, text: clean(e.innerText).slice(0, 50),
      })),
    };
  };
  return {
    url: location.href, title: document.title,
    bodyText: clean(document.body.innerText).slice(0, 900),
    selectors: {
      'input.el-select__input': info('input.el-select__input'),
      '.el-select': info('.el-select'),
      'input[name="unid"]': info('input[name="unid"]'),
      'input[type="password"]': info('input[type="password"]'),
      '.el-checkbox': info('.el-checkbox'),
      'input.el-checkbox__original': info('input.el-checkbox__original'),
      'div.btn-block__grandient_login': info('div.btn-block__grandient_login'),
      '[class*=yidun]': info('[class*=yidun]'),
    },
    inputs: [...document.querySelectorAll('input')].map((e) => ({
      type: e.type, name: e.name || null, placeholder: e.placeholder || null,
      cls: (e.className || '').toString().slice(0, 70),
      visible: e.getBoundingClientRect().width > 0,
    })),
    clickables: [...document.querySelectorAll('div,button,a,span')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        const t = clean(e.innerText);
        return r.width > 40 && r.height > 20 && t && t.length <= 14 && e.children.length <= 1;
      })
      .map((e) => ({ tag: e.TagName || e.tagName, cls: (e.className || '').toString().slice(0, 70), text: clean(e.innerText).slice(0, 24) }))
      .slice(0, 30),
  };
});

const dom = await dump();

log('\n=== 页面 ===');
log('url   : ' + dom.url);
log('title : ' + dom.title);
log('正文  : ' + dom.bodyText.slice(0, 400));

log('\n=== 选择器核对 ===');
for (const [sel, v] of Object.entries(dom.selectors)) {
  log(`  ${v.visible > 0 ? '✓' : '✗'} ${sel}  count=${v.count} visible=${v.visible}`);
  for (const s of v.sample) log(`       ${s.tag}.${String(s.cls).split(/\s+/)[0]} type=${s.type} name=${s.name} ph="${s.placeholder}"`);
}

log('\n=== 页面上所有 input ===');
for (const i of dom.inputs) log(`  ${i.visible ? '✓' : '✗'} type=${i.type} name=${i.name} ph="${i.placeholder}" cls=${String(i.cls).split(/\s+/)[0]}`);

log('\n=== 可见可点元素 ===');
for (const c of dom.clickables) log(`  ${c.tag}.${String(c.cls).split(/\s+/)[0]}  "${c.text}"`);

await page.screenshot({ path: join(OUT, 'login-form.png') }).catch(() => {});
writeFileSync(join(OUT, 'login-dom2.json'), JSON.stringify(dom, null, 2), 'utf8');
log('\n已保存 recon/login/login-dom2.json');

// 这个临时 profile 用完即弃，直接关掉整个浏览器
await browser.close().catch(() => {});
try { process.kill(-0); } catch {}
log('完成（临时浏览器已关闭）');
