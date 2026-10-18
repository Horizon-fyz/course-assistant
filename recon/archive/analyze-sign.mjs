// 解析 secretStr 签名机制（从在线学堂学生端 onlinestuh5 的产物里找）
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'sign');
mkdirSync(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

async function grab(url, name) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://onlinestuh5.zhihuishu.com/' } });
  const t = await r.text();
  writeFileSync(OUT + '\\' + name, t);
  return t;
}

const files = ['crypto.60e00844.js', 'core.60e00844.js', 'app.60e00844.js'];
const texts = {};
for (const f of files) {
  try { texts[f] = await grab('https://onlinestuh5.zhihuishu.com/' + f, f); console.log(f, texts[f].length, 'bytes'); }
  catch (e) { console.log(f, 'ERR', String(e)); }
}

// 在 crypto / core 里找 secretStr 相关实现
const needles = ['secretStr', 'AES', 'aes', 'encrypt', 'CryptoJS', 'sign', 'md5', 'MD5', 'timestamp', 'iv', 'key'];
for (const [f, t] of Object.entries(texts)) {
  console.log(`\n########## ${f} ##########`);
  for (const n of needles) {
    const c = (t.match(new RegExp(n.replace(/[$]/g, '\\$'), 'g')) || []).length;
    if (c) console.log(`  ${n}: ${c} 次`);
  }
  // 打印 secretStr 出现的上下文
  let idx = -1, n = 0;
  while ((idx = t.indexOf('secretStr', idx + 1)) >= 0 && n < 4) {
    console.log(`\n  --- secretStr @${idx} ---`);
    console.log('  ' + t.slice(Math.max(0, idx - 1100), idx + 700).replace(/\n/g, ' '));
    n++;
  }
}
