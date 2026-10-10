// 全量域名巡检：逐个实测可达性、登录态、页面职责
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy, HOME } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
const OUT = BASE + '\\recon\\hosts';
mkdirSync(OUT, { recursive: true });

const hosts = JSON.parse(readFileSync(BASE + '\\recon\\all-hosts.json', 'utf8'));
const { browser, ctx } = await connect();

// 在一个页面上下文里批量探测（并行 fetch，检测网络层可达性）
const page = await readyPage(ctx, HOME);

const CONCURRENCY = 8;
const results = [];

for (let i = 0; i < hosts.length; i += CONCURRENCY) {
  const batch = hosts.slice(i, i + CONCURRENCY);
  const batchRes = await page.evaluate(async (list) => {
    function testOne(h) {
      return new Promise((resolve) => {
        const t0 = performance.now();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort('timeout'), 12000);
        // no-cors：跨域也能发起，能拿到 opaque 响应说明网络可达 + TLS 正常
        fetch(`https://${h}/`, { mode: 'no-cors', signal: ctrl.signal, credentials: 'omit' })
          .then((r) => { clearTimeout(timer); resolve({ host: h, reachable: true, type: r.type, status: r.status, ms: Math.round(performance.now() - t0) }); })
          .catch((e) => { clearTimeout(timer); resolve({ host: h, reachable: false, error: String(e && e.message || e).slice(0, 120), ms: Math.round(performance.now() - t0) }); });
      });
    }
    return Promise.all(list.map(testOne));
  }, batch);
  results.push(...batchRes);
  console.log(`  探测进度 ${Math.min(i + CONCURRENCY, hosts.length)}/${hosts.length}`);
}

console.log('\n=== 网络层可达性 ===');
const reachable = results.filter((r) => r.reachable);
const unreachable = results.filter((r) => !r.reachable);
console.log('可达:', reachable.length, ' 不可达:', unreachable.length);
for (const r of unreachable) console.log(`  ✗ ${r.host.padEnd(42)} ${r.error}`);

writeFileSync(OUT + '\\reachability.json', JSON.stringify(results, null, 2));

// ---------- 用真实导航逐个确认状态码与页面 ----------
console.log('\n=== 页面导航巡检（真实请求，带 cookie）===');
const nav = [];
const navPage = await readyPage(ctx, HOME);

for (const h of hosts) {
  const url = `https://${h}/`;
  const rec = { host: h, url };
  try {
    const resp = await navPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await navPage.waitForTimeout(1500);
    const info = await navPage.evaluate(() => ({
      url: location.href,
      title: document.title,
      textLen: document.body ? document.body.innerText.length : 0,
      text: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 160) : '',
      isLoginPage: /登录|login/i.test(document.title) || !!document.querySelector('input[type=password]'),
    })).catch(() => ({}));
    rec.status = resp ? resp.status() : null;
    rec.finalUrl = info.url;
    rec.title = info.title;
    rec.textLen = info.textLen;
    rec.text = info.text;
    rec.isLoginPage = info.isLoginPage;
    rec.redirected = info.url && !info.url.startsWith(`https://${h}/`);
    console.log(`  ${String(rec.status).padStart(3)} ${h.padEnd(40)} ${String(rec.title || '').slice(0, 34)}  ${rec.redirected ? '→ ' + String(rec.finalUrl).slice(0, 46) : ''}`);
  } catch (e) {
    rec.error = String(e).slice(0, 130);
    console.log(`  ERR ${h.padEnd(40)} ${rec.error}`);
  }
  nav.push(rec);
}

writeFileSync(OUT + '\\navigation.json', JSON.stringify(nav, null, 2));

// 汇总表
const summary = hosts.map((h) => {
  const r = results.find((x) => x.host === h) || {};
  const n = nav.find((x) => x.host === h) || {};
  return {
    host: h,
    reachable: !!r.reachable,
    httpStatus: n.status ?? null,
    title: n.title ?? null,
    finalUrl: n.finalUrl ?? null,
    redirected: !!n.redirected,
    isLoginPage: !!n.isLoginPage,
    textLen: n.textLen ?? 0,
    error: n.error ?? r.error ?? null,
  };
});
writeFileSync(OUT + '\\summary.json', JSON.stringify(summary, null, 2));

console.log('\n=== 汇总 ===');
console.log('域名总数:', summary.length);
console.log('网络可达:', summary.filter((s) => s.reachable).length);
console.log('HTTP 200:', summary.filter((s) => s.httpStatus === 200).length);
console.log('需登录:', summary.filter((s) => s.isLoginPage).length);
console.log('不可达:', summary.filter((s) => !s.reachable).length);

await tidy(ctx);
await browser.close().catch(() => {});
