// 定位 window.yxyz 与密钥获取函数 s.e 的实现
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const dir = join(ROOT, 'recon', 'sign') + '\\';
const files = ['crypto.60e00844.js', 'core.60e00844.js', 'chunk-vendors.60e00844.js', 'app.60e00844.js', 'vue-runtime.60e00844.js'];
const out = [];

for (const f of files) {
  let t;
  try { t = readFileSync(dir + f, 'utf8'); } catch { continue; }
  out.push(`\n\n##################### ${f} (${t.length}B) #####################`);
  for (const n of ['yxyz', 'window.yxyz', 'getSecret', 'secretKey', 'xhr', 'aesKey', 'AES_KEY']) {
    const c = (t.match(new RegExp(n.replace(/[.$]/g, '\\$&'), 'g')) || []).length;
    if (c) out.push(`  [${n}] x${c}`);
  }
  let idx = -1, k = 0;
  while ((idx = t.indexOf('yxyz', idx + 1)) >= 0 && k < 6) {
    out.push(`\n--- yxyz @${idx} in ${f} ---`);
    out.push(t.slice(Math.max(0, idx - 1500), idx + 1200).replace(/\n/g, ' '));
    k++;
  }
}

writeFileSync(dir + 'yxyz-locate.txt', out.join('\n'));
console.log(out.join('\n').slice(0, 12000));
