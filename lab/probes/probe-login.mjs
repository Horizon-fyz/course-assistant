// 侦察 passport 登录页：表单结构、登录方式、密码加密、验证码触发条件
import { chromium, firefox } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'login');
mkdirSync(OUT, { recursive: true });

const log = [];
function rec(kind, data) {
  log.push({ t: new Date().toISOString(), kind, ...data });
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  viewport: { width: 1440, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
});
const page = await ctx.newPage();

page.on('request', (r) => {
  const u = r.url();
  if (/zhihuishu|polymas/.test(u) && r.resourceType() !== 'image') {
    const pd = r.postData();
    rec('request', { method: r.method(), url: u, hasPost: !!pd, postLen: pd ? pd.length : 0, postKeys: pd ? [...new Set([...pd.matchAll(/(?:^|&)([A-Za-z0-9_]+)=/g)].map((m) => m[1]))] : [] });
  }
});
page.on('response', (r) => {
  const u = r.url();
  if (/login|passport|ssoLogin|gologin/.test(u) && r.request().resourceType() !== 'image') {
    rec('response', { status: r.status(), url: u, ct: r.headers()['content-type'] });
  }
});
page.on('console', (m) => rec('console', { type: m.type(), text: m.text().slice(0, 300) }));

await page.goto('https://passport.zhihuishu.com/login?service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);

// 表单结构
const forms = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('input,select,button,a.btn,[class*=login],[class*=tab]').forEach((el) => {
    const t = (el.tagName || '').toLowerCase();
    if (t === 'input' || t === 'select') {
      out.push({ tag: t, type: el.type || '', id: el.id || '', name: el.name || '', cls: (el.className || '').toString().slice(0, 80), ph: el.placeholder || '', visible: !!(el.offsetParent) });
    }
  });
  return out;
});

const tabs = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('div,span,li,a').forEach((el) => {
    const tx = (el.innerText || '').trim();
    if (tx && tx.length <= 12 && /登录|扫码|验证码|密码|学生|学号|手机/.test(tx) && el.children.length === 0) {
      out.push({ tx, cls: (el.className || '').toString().slice(0, 60), id: el.id || '' });
    }
  });
  return out.slice(0, 40);
});

const cookies = await ctx.cookies();
const title = await page.title();
const html = await page.content();
writeFileSync(OUT + '\\passport.html', html);

// 页面是否出现滑块/验证码元素
const captchaEls = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('*').forEach((el) => {
    const idc = ((el.id || '') + ' ' + (el.className || '')).toString();
    if (/yidun|geetest|captcha|slider|verify|nc_/i.test(idc)) out.push({ tag: el.tagName, id: el.id || '', cls: (el.className || '').toString().slice(0, 60) });
  });
  return out.slice(0, 30);
});

writeFileSync(OUT + '\\probe.json', JSON.stringify({ title, url: page.url(), cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, expires: c.expires })), forms, tabs, captchaEls, network: log }, null, 2));

console.log('title:', title);
console.log('final url:', page.url());
console.log('\n--- cookies ---');
for (const c of cookies) console.log(`  ${c.domain}  ${c.name}  httpOnly=${c.httpOnly}`);

console.log('\n--- visible inputs ---');
for (const f of forms.filter((x) => x.visible)) console.log(`  <${f.tag} type=${f.type} id=${f.id} name=${f.name} ph="${f.ph}" cls=${f.cls}>`);

console.log('\n--- all inputs (incl hidden) count:', forms.length);
for (const f of forms.filter((x) => !x.visible)) console.log(`  (hidden) <${f.tag} type=${f.type} id=${f.id} name=${f.name}>`);

console.log('\n--- login-ish text ---');
for (const t of tabs) console.log(`  "${t.tx}"  cls=${t.cls}`);

console.log('\n--- captcha elements ---');
for (const c of captchaEls) console.log(`  <${c.tag} id=${c.id} cls=${c.cls}>`);

console.log('\n--- network (login related) ---');
for (const n of log.filter((x) => x.kind === 'request' || x.kind === 'response')) {
  if (n.kind === 'request') console.log(`  REQ ${n.method} ${n.url}${n.hasPost ? ` postKeys=[${(n.postKeys || []).join(',')}]` : ''}`);
  else console.log(`  RES ${n.status} ${n.url}`);
}

await browser.close();
