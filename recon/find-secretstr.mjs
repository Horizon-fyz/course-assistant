// 在学生端 onlinestuh5 全部产物中定位 secretStr 生成逻辑
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'sign');
mkdirSync(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

async function grab(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://onlinestuh5.zhihuishu.com/' } });
  return await r.text();
}

const html = await grab('https://onlinestuh5.zhihuishu.com/');
writeFileSync(OUT + '\\index.html', html);
console.log('index.html', html.length);
console.log(html.slice(0, 1500));

// 收集所有 script/link
const assets = new Set();
for (const m of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))["']/g)) assets.add(m[1]);
console.log('\nassets in html:', [...assets]);

// 也把同目录下常见的按名字补上
for (const extra of ['chunk-vendors.60e00844.js', 'element-ui.60e00844.js', 'vue-runtime.60e00844.js']) {
  assets.add('/' + extra);
}

const hits = [];
for (const a of assets) {
  const url = a.startsWith('http') ? a : 'https://onlinestuh5.zhihuishu.com' + a;
  const name = a.split('/').pop();
  try {
    const t = await grab(url);
    writeFileSync(OUT + '\\' + name, t);
    const has = t.includes('secretStr');
    const cnt = (t.match(/secretStr/g) || []).length;
    console.log(`  ${name.padEnd(40)} ${String(t.length).padStart(8)}B  secretStr=${cnt}`);
    if (cnt) hits.push({ name, text: t, cnt });
  } catch (e) {
    console.log(`  ${name.padEnd(40)} ERR ${String(e).slice(0, 60)}`);
  }
}

for (const h of hits) {
  console.log(`\n\n############ ${h.name} :: secretStr x${h.cnt} ############`);
  let idx = -1, n = 0;
  while ((idx = h.text.indexOf('secretStr', idx + 1)) >= 0 && n < 5) {
    console.log(`\n--- @${idx} ---`);
    console.log(h.text.slice(Math.max(0, idx - 1300), idx + 800).replace(/\n/g, ' '));
    n++;
  }
}
