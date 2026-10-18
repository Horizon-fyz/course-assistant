// 实地抓取课程资料页的真实网络请求，确认列表接口与下载接口
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'hosts');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = await readyPage(ctx, 'https://stuonline.zhihuishu.com/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708');

const calls = [];
page.on('request', (r) => {
  const u = r.url();
  if (!/stuonline\.zhihuishu\.com/.test(u)) return;
  if (/\.(js|css|png|jpg|gif|woff2?|ico)(\?|$)/.test(u)) return;
  calls.push({ method: r.method(), url: u, post: (r.postData() || '').slice(0, 600) });
});
page.on('response', async (r) => {
  const u = r.url();
  if (!/stuonline\.zhihuishu\.com/.test(u)) return;
  const rec = calls.find((c) => c.url === u && !c.status);
  if (!rec) return;
  rec.status = r.status();
  const ct = r.headers()['content-type'] || '';
  if (/json|text/.test(ct)) { try { rec.body = (await r.text()).slice(0, 1200); } catch {} }
});

console.log('重新加载课程资料页以捕获请求…');
await page.reload({ waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(8000);

// 页面上的关键变量
const vars = await page.evaluate(() => {
  const g = (n) => (typeof window[n] !== 'undefined' ? String(window[n]) : null);
  const el = (id) => document.getElementById(id)?.value ?? null;
  return {
    jsonPath: g('jsonPath'), basePath: g('basePath'),
    canDownload: g('canDownload'), roleName: g('roleName'), role: g('role'),
    courseId: el('courseId'), recruitId: el('recruitId'),
    windowKeys: Object.keys(window).filter((k) => /path|download|role|course|recruit/i.test(k)).slice(0, 30),
  };
});
console.log('\n=== 页面全局变量 ===');
console.log(JSON.stringify(vars, null, 1));

console.log('\n=== 资料页请求 ===');
for (const c of calls) {
  console.log(`\n[${c.status ?? '...'}] ${c.method} ${c.url.slice(0, 130)}`);
  if (c.post) console.log('   post:', c.post.slice(0, 300));
  if (c.body) console.log('   body:', c.body.replace(/\s+/g, ' ').slice(0, 500));
}

// 页面上的资料条目
const items = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#course-folder-container tr, .allfiles_one')].slice(0, 10).map((tr) => ({
    text: (tr.innerText || '').replace(/\s+/g, ' ').slice(0, 120),
    opid: tr.getAttribute('opid'), name: tr.getAttribute('name'),
    canDownload: tr.getAttribute('canDownload'), roleName: tr.getAttribute('roleName'),
    fileType: tr.getAttribute('fileType'), isShare: tr.getAttribute('isShare'),
  }));
  return { rowCount: document.querySelectorAll('#course-folder-container tr').length, rows, bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) };
});
console.log('\n=== 资料条目 ===');
console.log(JSON.stringify(items, null, 1));

writeFileSync(OUT + '\\folder-live.json', JSON.stringify({ vars, calls, items }, null, 2));
console.log('\n已保存 recon/hosts/folder-live.json');

await tidy(ctx);
await browser.close().catch(() => {});
