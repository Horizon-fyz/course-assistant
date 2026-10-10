// 找「作业考试」的真实跳转 URL 构造方式
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

// 1) 直接在活页面里 hook window.open / location 赋值，再点菜单
const { browser, ctx } = await connect();
const page = await readyPage(ctx, 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=4e5b5c59475b4859454a585858445e4350');
await page.waitForTimeout(8000);
try { await page.locator('.dialog-read .iconguanbi').first().click({ timeout: 6000 }); await page.waitForTimeout(2500); } catch {}

// 注入钩子，捕获跳转意图
await page.evaluate(() => {
  window.__captured = [];
  const origOpen = window.open;
  window.open = function (...args) {
    window.__captured.push({ type: 'window.open', args: args.map((a) => String(a).slice(0, 200)) });
    return null; // 阻止真实打开，避免弹窗堆积
  };
  // 捕获通过 location 跳转
  try {
    const d = Object.getOwnPropertyDescriptor(window.location, 'href');
    if (d && d.set) {
      Object.defineProperty(window.location, 'href', {
        set(v) { window.__captured.push({ type: 'location.href', value: String(v).slice(0, 200) }); },
        get() { return d.get.call(window.location); },
      });
    }
  } catch {}
  // 捕获 a[target=_blank] 的点击
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && a.href && !a.href.startsWith('javascript')) {
      window.__captured.push({ type: 'anchor', href: a.href.slice(0, 200), target: a.target });
    }
  }, true);
});

console.log('点击「作业考试」…');
const before = page.url();
try { await page.getByText('作业考试', { exact: true }).first().click({ timeout: 10000 }); } catch (e) { console.log('  click err:', String(e).slice(0, 100)); }
await page.waitForTimeout(6000);

const captured = await page.evaluate(() => ({ captured: window.__captured, url: location.href }));
console.log('\n捕获到的跳转意图:');
console.log(JSON.stringify(captured, null, 1));

// 新开标签页检测
const pages = ctx.pages().map((p) => p.url());
console.log('\n当前所有标签页:');
for (const u of pages) console.log('  -', u.slice(0, 130));

// 2) 从 JS 源码里找 examUrl 构造
console.log('\n=== 源码中 exam 链接构造 ===');
const jsRes = await page.evaluate(async () => {
  const urls = [...document.querySelectorAll('script[src]')].map((s) => s.src).filter((u) => /studyvideoh5/.test(u));
  const out = [];
  for (const u of urls) {
    try {
      const t = await (await fetch(u)).text();
      if (/onlineexamh5new|stuExamWeb|examList/i.test(t)) out.push({ url: u.split('/').pop(), len: t.length });
    } catch {}
  }
  return { urls: urls.map((u) => u.split('/').pop()), hit: out };
});
console.log('脚本:', JSON.stringify(jsRes.urls));
console.log('含 exam 链接的脚本:', JSON.stringify(jsRes.hit));

writeFileSync(OUT + '\\exam-menu-capture.json', JSON.stringify({ captured, pages, jsRes }, null, 2));
console.log('\n已保存 recon/exam/exam-menu-capture.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
