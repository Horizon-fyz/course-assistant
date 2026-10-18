// 挖掘课程资料下载接口 v2（修正协议相对 URL 处理）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const BASE = ROOT;
const OUT = BASE + '\\recon\\hosts';
mkdirSync(OUT, { recursive: true });
const H = JSON.parse(readFileSync(BASE + '\\session\\cookie-headers.json', 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const REF = 'https://stuonline.zhihuishu.com/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708';

function abs(u, baseHost = 'stuonline.zhihuishu.com') {
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('http')) return u;
  if (u.startsWith('/')) return 'https://' + baseHost + u;
  return 'https://' + baseHost + '/stuonline/web3/' + u;
}

async function grab(url) {
  const host = new URL(url).host;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Cookie: H[host] || '', Referer: REF },
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  const t = await res.text().catch(() => '');
  return { status: res.status, ct: (res.headers.get('content-type') || '').split(';')[0], text: t };
}

const pageUrl = 'https://stuonline.zhihuishu.com/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708';
const page = await grab(pageUrl);
console.log('资料页:', page.status, page.text.length, 'bytes');

const scripts = new Set();
for (const m of page.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) scripts.add(abs(m[1]));
console.log('脚本数:', scripts.size);

const files = { page: page.text };
for (const u of scripts) {
  const path = new URL(u).pathname;
  if (!/folder|common\.js|common_ui|tmpl|cookie/i.test(path)) continue;
  try {
    const r = await grab(u);
    if (r.status === 200) { files[u] = r.text; console.log(`  ✓ ${path} ${r.text.length}B`); }
  } catch {}
}

// 搜下载逻辑
console.log('\n\n=== 下载相关线索 ===');
const KEYS = ['download', 'downloadFile', 'fileId', 'getFile', 'preview', 'fileUrl', 'folderFile', 'loadFile', 'downLoad'];
for (const [name, txt] of Object.entries(files)) {
  if (!txt) continue;
  const shown = new Set();
  for (const k of KEYS) {
    let idx = -1, n = 0;
    while ((idx = txt.indexOf(k, idx + 1)) >= 0 && n < 3) {
      const snippet = txt.slice(Math.max(0, idx - 260), idx + 300).replace(/\s+/g, ' ');
      const sig = snippet.slice(0, 60);
      if (shown.has(sig)) { n++; continue; }
      shown.add(sig);
      console.log(`\n[${name.split('/').pop()}] "${k}"`);
      console.log('   ' + snippet);
      n++;
    }
  }
}

// 抽接口路径
const apis = new Set();
for (const txt of Object.values(files)) {
  for (const m of txt.matchAll(/["'`]((?:https?:\/\/[a-z0-9.-]+)?\/stuonline\/[A-Za-z0-9_\/.]{3,90})["'`]/gi)) apis.add(m[1]);
  for (const m of txt.matchAll(/["'`](\/json\/[A-Za-z0-9_\/.]{3,90})["'`]/gi)) apis.add(m[1]);
}
console.log('\n\n=== 抽到的接口路径 ===');
for (const a of [...apis].sort()) console.log('  ', a);
writeFileSync(OUT + '\\folder-apis-v2.json', JSON.stringify([...apis].sort(), null, 2));
writeFileSync(OUT + '\\folder-files.json', JSON.stringify(Object.keys(files), null, 2));
