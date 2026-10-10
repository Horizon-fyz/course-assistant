// 抓取 login.zhihuishu.com 的前端资源并抽取登录相关字符串
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'loginsite');
mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const REF = 'https://login.zhihuishu.com/';

async function grab(url, name) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: REF } });
    const text = await res.text();
    writeFileSync(join(OUT, name), text);
    return { url, name, status: res.status, bytes: text.length };
  } catch (e) {
    return { url, name, error: String(e) };
  }
}

// 先取首页，解析出所有 assets
const home = await fetch(REF, { headers: { 'User-Agent': UA } });
const html = await home.text();
writeFileSync(join(OUT, 'login.html'), html);

const assets = new Set();
for (const m of html.matchAll(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)) assets.add(m[1]);
for (const m of html.matchAll(/from\s*["'](\/assets\/[^"']+)["']/g)) assets.add(m[1]);

const report = [];
for (const a of assets) {
  const url = a.startsWith('http') ? a : 'https://login.zhihuishu.com' + a;
  const name = a.split('/').pop();
  report.push(await grab(url, name));
}

console.log('login.html bytes:', html.length);
console.log('assets found:', assets.size);
for (const r of report) console.log(`  ${r.status ?? 'ERR'}  ${String(r.bytes ?? r.error).padStart(8)}  ${r.name}`);
