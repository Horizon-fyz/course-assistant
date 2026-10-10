// 站点侦察：抓取入口页/资源，落盘到 out/，只打印摘要
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\//, '');
mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function save(name, text) {
  const p = join(OUT, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
}

async function get(url, cookie) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(url, { headers, redirect: 'follow' });
  const body = await res.text();
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, url: res.url, body, setCookie, headers: res.headers };
}

const targets = [
  ['root.html', 'https://onlineweb.zhihuishu.com/'],
  ['stu.html', 'https://onlineweb.zhihuishu.com/onlinestuh5'],
  ['stu-slash.html', 'https://onlineweb.zhihuishu.com/onlinestuh5/'],
  ['hike.html', 'https://hike.zhihuishu.com/'],
  ['passport.html', 'https://passport.zhihuishu.com/login'],
];

const report = [];
for (const [name, url] of targets) {
  try {
    const r = await get(url);
    save(name, r.body);
    report.push({ name, url, status: r.status, finalUrl: r.url, bytes: r.body.length, setCookie: r.setCookie });
  } catch (e) {
    report.push({ name, url, error: String(e) });
  }
}

// 从入口页里抽出 script/link 资源
const { readFileSync } = await import('node:fs');
const assets = new Set();
for (const [name] of targets) {
  let html = '';
  try { html = readFileSync(join(OUT, name), 'utf8'); } catch { continue; }
  for (const m of html.matchAll(/<(?:script|link)[^>]*?(?:src|href)=["']([^"']+)["']/gi)) {
    assets.add(m[1]);
  }
}
save('assets.txt', [...assets].join('\n'));

console.log(JSON.stringify({ report, assetCount: assets.size, assets: [...assets] }, null, 2));
