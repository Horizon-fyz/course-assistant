// 站点侦察 v2：抓 HTML + 前端打包产物，落盘，抽取接口线索
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'out');
const JS = join(OUT, 'js');
mkdirSync(JS, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchSave(url, dest, referer) {
  try {
    const headers = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' };
    if (referer) headers.Referer = referer;
    const res = await fetch(url, { headers, redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    return { url, dest, status: res.status, bytes: buf.length, md5: createHash('md5').update(buf).digest('hex').slice(0, 10), setCookie: res.headers.getSetCookie?.() ?? [] };
  } catch (e) {
    return { url, error: String(e) };
  }
}

const report = [];
report.push(await fetchSave('https://onlineweb.zhihuishu.com/onlinestuh5', join(OUT, 'stu.html')));
report.push(await fetchSave('https://onlineweb.zhihuishu.com/app.82078487.js', join(JS, 'app.js'), 'https://onlineweb.zhihuishu.com/onlinestuh5'));
report.push(await fetchSave('https://onlineweb.zhihuishu.com/chunk-vendors.82078487.js', join(JS, 'chunk-vendors.js'), 'https://onlineweb.zhihuishu.com/onlinestuh5'));

console.log(JSON.stringify(report, null, 2));
