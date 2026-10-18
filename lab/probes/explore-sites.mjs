// 遍历智慧树各学习子系统 SPA，采集接口与页面结构
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'api');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];

const SKIP = /\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|css|ico|mp4)(\?|$)|google|gstatic|baidu|hm\.js|dun\.163|easemob|alipayobjects|alicdn|sockjs/i;

const SITES = [
  { name: 'A-我的学堂', url: 'https://onlinemuster.zhihuishu.com/' },
  { name: 'B-视频学习', url: 'https://studyvideoh5.zhihuishu.com/' },
  { name: 'C-课程主页', url: 'https://coursehome.zhihuishu.com/courseHome/' },
  { name: 'D-课程H5', url: 'https://courseh5.zhihuishu.com/cc.html' },
  { name: 'E-问答', url: 'https://qah5.zhihuishu.com/qa.html' },
  { name: 'F-在线学堂', url: 'https://onlineweb.zhihuishu.com/onlinestuh5' },
  { name: 'G-智慧课程', url: 'https://wisdomh5.zhihuishu.com/' },
  { name: 'H-考试', url: 'https://tchexamh5.zhihuishu.com/' },
];

const all = [];

for (const site of SITES) {
  const page = await ctx.newPage();
  const calls = [];
  const seen = new Set();

  page.on('request', (r) => {
    const u = r.url();
    if (SKIP.test(u) || !/zhihuishu|polymas/.test(u)) return;
    const k = `${r.method()} ${u}`;
    if (seen.has(k)) return;
    seen.add(k);
    calls.push({ method: r.method(), url: u, post: (r.postData() || '').slice(0, 400) });
  });
  page.on('response', async (r) => {
    const u = r.url();
    if (SKIP.test(u) || !/zhihuishu|polymas/.test(u)) return;
    const rec = calls.find((c) => c.url === u && c.method === r.request().method());
    if (!rec) return;
    rec.status = r.status();
    const ct = r.headers()['content-type'] || '';
    if (/json|text/.test(ct)) { try { rec.body = (await r.text()).slice(0, 700); } catch {} }
  });

  console.log(`\n\n########## ${site.name} :: ${site.url} ##########`);
  try {
    await page.goto(site.url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(7000);
  } catch (e) {
    console.log('  goto:', String(e).slice(0, 120));
  }

  const info = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 700),
    links: [...document.querySelectorAll('a[href]')].map((a) => ({ t: (a.innerText || '').trim().slice(0, 20), h: a.href })).filter((x) => x.t).slice(0, 30),
  })).catch(() => ({}));
  console.log('  url:', info.url);
  console.log('  title:', info.title);
  console.log('  text:', (info.text || '').slice(0, 400));
  if (info.links?.length) {
    console.log('  links:');
    for (const l of info.links.slice(0, 15)) console.log(`    "${l.t}" → ${l.h.slice(0, 110)}`);
  }

  console.log('  --- 接口 ---');
  for (const c of calls) {
    const mark = c.status && c.status >= 400 ? 'ERR' : String(c.status ?? '...');
    console.log(`    ${mark.padStart(3)} ${c.method.padEnd(4)} ${c.url.slice(0, 140)}`);
    if (c.body) console.log(`         → ${c.body.replace(/\s+/g, ' ').slice(0, 260)}`);
  }

  await page.screenshot({ path: `${OUT}\\site-${site.name}.png` }).catch(() => {});
  all.push({ site: site.name, url: site.url, info, calls });
  await page.close().catch(() => {});
}

writeFileSync(OUT + '\\sites.json', JSON.stringify(all, null, 2));
console.log('\n\n已保存 sites.json，共', all.reduce((a, b) => a + b.calls.length, 0), '条请求');
await browser.close().catch(() => {});
