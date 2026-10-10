// 实地枚举学生端接口：遍历课程功能页，记录所有 XHR/fetch 调用与响应
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
const OUT = BASE + '\\recon\\api';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('onlineweb')) ?? (await ctx.newPage());

// 只记录真正的数据请求
const SKIP = /\.(png|jpg|jpeg|gif|webp|svg|woff2?|ttf|css|ico|mp4)(\?|$)|google|gstatic|baidu|hm\.js|dun\.163|easemob|alipayobjects|alicdn/i;
const calls = [];
const pending = new Map();

page.on('request', (r) => {
  const u = r.url();
  if (SKIP.test(u)) return;
  if (!/zhihuishu|polymas/.test(u)) return;
  const key = `${r.method()} ${u}`;
  pending.set(key, { method: r.method(), url: u, postLen: r.postData()?.length ?? 0, post: (r.postData() || '').slice(0, 600), ct: r.headers()['content-type'] || '' });
});
page.on('response', async (r) => {
  const u = r.url();
  if (SKIP.test(u) || !/zhihuishu|polymas/.test(u)) return;
  const key = `${r.request().method()} ${u}`;
  const rec = pending.get(key) || { method: r.request().method(), url: u };
  rec.status = r.status();
  rec.resCt = r.headers()['content-type'] || '';
  if (/json|text/.test(rec.resCt)) {
    try { rec.body = (await r.text()).slice(0, 900); } catch {}
  }
  calls.push(rec);
});

const visited = [];
async function visit(label, action) {
  const before = calls.length;
  const log = [];
  try {
    await action();
    await page.waitForTimeout(5000);
  } catch (e) {
    log.push('ERR: ' + String(e).slice(0, 160));
  }
  const newCalls = calls.slice(before);
  visited.push({ label, url: page.url(), newCalls: newCalls.length, log });
  console.log(`\n### ${label}  (新请求 ${newCalls.length}) url=${page.url().slice(0, 100)}`);
  for (const l of log) console.log('   ' + l);
  for (const c of newCalls) {
    console.log(`   ${String(c.status ?? '...').padStart(3)} ${c.method.padEnd(4)} ${c.url.slice(0, 135)}`);
    if (c.body) console.log(`        → ${c.body.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  await page.screenshot({ path: `${OUT}\\${label.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.png` }).catch(() => {});
}

// 1. 学生首页
await visit('01-学生首页', async () => {
  await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'networkidle', timeout: 60000 });
});

// 2. 抓首页上所有可点入口
const links = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('a[href], [class*=card], [class*=course], li, span').forEach((el) => {
    const t = (el.innerText || '').trim();
    if (t && t.length <= 12 && /成绩分析|作业考试|问答|见面课|课程退课|选课|查看全部|共享课|翻转课|兴趣课|智慧课程|消息/.test(t)) {
      out.push({ text: t, tag: el.tagName, cls: (el.className || '').toString().slice(0, 60) });
    }
  });
  return out;
});
console.log('\n=== 首页可用入口 ===');
for (const l of links.slice(0, 40)) console.log(`  "${l.text}" <${l.tag} cls=${l.cls}>`);

// 3. 逐个点击课程入口（成绩分析 / 作业考试 / 问答 / 见面课）
for (const target of ['成绩分析', '作业考试', '问答', '见面课']) {
  const loc = page.getByText(target, { exact: true }).first();
  if (await loc.count() === 0) { console.log(`\n(跳过 ${target}: 未找到)`); continue; }
  await visit(`02-${target}`, async () => {
    await loc.click({ timeout: 8000 });
    await page.waitForTimeout(2000);
  });
  // 回到首页
  await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
}

writeFileSync(OUT + '\\all-calls.json', JSON.stringify(calls, null, 2));
writeFileSync(OUT + '\\visited.json', JSON.stringify(visited, null, 2));

// 汇总去重接口清单
const uniq = new Map();
for (const c of calls) {
  const u = c.url.split('?')[0];
  const k = `${c.method} ${u}`;
  if (!uniq.has(k)) uniq.set(k, { method: c.method, url: u, sampleQuery: c.url.includes('?') ? c.url.split('?')[1].slice(0, 200) : '', status: c.status });
}
console.log('\n\n========== 去重接口清单 (' + uniq.size + ') ==========');
for (const v of [...uniq.values()].sort((a, b) => a.url.localeCompare(b.url))) {
  console.log(`${String(v.status ?? '?').padStart(3)} ${v.method.padEnd(4)} ${v.url}`);
  if (v.sampleQuery) console.log(`        ?${v.sampleQuery}`);
}
writeFileSync(OUT + '\\endpoints.json', JSON.stringify([...uniq.values()], null, 2));

await browser.close().catch(() => {});
