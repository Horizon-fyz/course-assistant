// 下载 SPA 打包产物到 out/js/，打印大小与 md5
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'out', 'js');
mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const base = 'https://onlineweb.zhihuishu.com';
const files = ['/app.82078487.js', '/chunk-vendors.82078487.js', '/vue-runtime.82078487.js', '/polyfill.82078487.js'];

const out = [];
for (const f of files) {
  const url = base + f;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: base + '/onlinestuh5' } });
    const buf = Buffer.from(await res.arrayBuffer());
    const name = f.replace(/^\//, '');
    writeFileSync(join(OUT, name), buf);
    out.push({ file: name, status: res.status, bytes: buf.length, md5: createHash('md5').update(buf).digest('hex').slice(0, 12), ct: res.headers.get('content-type') });
  } catch (e) {
    out.push({ file: f, error: String(e) });
  }
}
console.log(JSON.stringify(out, null, 2));
