// 侦察智慧树登录页的真实 DOM，核对自动登录用的选择器
// 用法：node recon\archive\login-dom.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, tidy } from '../../src/core/browser.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'recon', 'login');
mkdirSync(OUT, { recursive: true });

const LOGIN_URL = 'https://login.zhihuishu.com/?origin=zhs&service=https%3A%2F%2Fonlineservice-api.zhihuishu.com%2Fgateway%2Ff%2Fv1%2Flogin%2Fgologin';

const log = (m) => process.stdout.write(m + '\n');

const { ctx, describe, close } = await connect({
  prefer: process.argv.includes('--firefox') ? 'firefox' : 'chromium',
});
log('浏览器: ' + describe);

const page = ctx.pages().find((p) => p.url().includes('zhihuishu')) ?? ctx.pages()[0] ?? (await ctx.newPage());
log('复用页面: ' + page.url().slice(0, 80));

page.on('close', () => log('!! 页面被关闭'));
page.on('crash', () => log('!! 页面崩溃'));
ctx.on('page', (p) => log('新标签页: ' + p.url().slice(0, 80)));

try {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
} catch (e) {
  log('goto 失败: ' + String(e).slice(0, 120));
}
log('goto 后 url: ' + (page.isClosed() ? '(已关闭)' : page.url().slice(0, 100)));
await page.waitForTimeout(6000);

// 切换到「学号登录」
try {
  const tab = page.getByText('学号登录', { exact: true }).first();
  if (await tab.count()) { await tab.click({ timeout: 8000 }); log('已点击「学号登录」'); }
  else log('⚠️ 没找到「学号登录」文字');
} catch (e) { log('点击「学号登录」失败: ' + String(e).slice(0, 100)); }
await page.waitForTimeout(2500);

const dom = await page.evaluate(() => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const info = (sel) => {
    const els = [...document.querySelectorAll(sel)];
    return {
      count: els.length,
      visible: els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length,
      sample: els.slice(0, 3).map((e) => ({
        tag: e.tagName, type: e.type || null, name: e.name || null,
        cls: (e.className || '').toString().slice(0, 80),
        placeholder: e.placeholder || null,
        text: clean(e.innerText).slice(0, 60),
      })),
    };
  };
  return {
    url: location.href,
    title: document.title,
    bodyText: clean(document.body.innerText).slice(0, 800),
    selectors: {
      'input.el-select__input': info('input.el-select__input'),
      'input[name="unid"]': info('input[name="unid"]'),
      'input[type="password"]': info('input[type="password"]'),
      '.el-checkbox': info('.el-checkbox'),
      'input.el-checkbox__original': info('input.el-checkbox__original'),
      'div.btn-block__grandient_login': info('div.btn-block__grandient_login'),
      '[class*=login] button': info('[class*=login] button'),
      '[class*=btn]': info('[class*=btn]'),
      'iframe[dun]': info('iframe'),
      '[class*=yidun]': info('[class*=yidun]'),
    },
    // 把所有可见按钮/可点块列出来，便于找登录按钮
    clickables: [...document.querySelectorAll('div,button,a,span')]
      .filter((e) => {
        const r = e.getBoundingClientRect();
        const t = clean(e.innerText);
        return r.width > 40 && r.height > 20 && t && t.length <= 12 && e.children.length <= 1;
      })
      .map((e) => ({ tag: e.tagName, cls: (e.className || '').toString().slice(0, 70), text: clean(e.innerText).slice(0, 20) }))
      .slice(0, 25),
  };
});

log('\n=== 页面 ===');
log('url   : ' + dom.url);
log('title : ' + dom.title);
log('正文  : ' + dom.bodyText.slice(0, 300));

log('\n=== 选择器核对 ===');
for (const [sel, v] of Object.entries(dom.selectors)) {
  log(`  ${v.visible > 0 ? '✓' : '✗'} ${sel}  count=${v.count} visible=${v.visible}`);
  for (const s of v.sample) log(`       ${s.tag}.${String(s.cls).split(/\s+/)[0]} type=${s.type} name=${s.name} text="${s.text}"`);
}

log('\n=== 可见可点元素（找登录按钮）===');
for (const c of dom.clickables) log(`  ${c.tag}.${String(c.cls).split(/\s+/)[0]}  "${c.text}"`);

await page.screenshot({ path: join(OUT, 'login-page.png') }).catch(() => {});
writeFileSync(join(OUT, 'login-dom.json'), JSON.stringify(dom, null, 2), 'utf8');
log('\n已保存 recon/login/login-dom.json');

await tidy(ctx).catch(() => {});
await close();
