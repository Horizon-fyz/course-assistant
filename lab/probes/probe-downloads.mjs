// 挖掘课程资料的下载接口
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const BASE = ROOT;
const OUT = BASE + '\\recon\\hosts';
mkdirSync(OUT, { recursive: true });
const H = JSON.parse(readFileSync(BASE + '\\session\\cookie-headers.json', 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';
const host = 'stuonline.zhihuishu.com';
const REF = `https://${host}/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708`;

async function get(path) {
  const res = await fetch(`https://${host}${path}`, {
    headers: { 'User-Agent': UA, Cookie: H[host] || '', Referer: REF },
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  const t = await res.text().catch(() => '');
  return { status: res.status, ct: res.headers.get('content-type'), text: t };
}

// 1) 把页面和它引用的 JS 全抓下来，搜下载相关逻辑
const page = await get('/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708');
console.log('页面状态:', page.status, '长度:', page.text.length);

const jsUrls = new Set();
for (const m of page.text.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) jsUrls.add(m[1]);
console.log('\n页面引用的 JS:');
for (const u of jsUrls) console.log('  ', u);

const files = {};
for (const u of jsUrls) {
  const path = u.startsWith('http') ? new URL(u).pathname : (u.startsWith('/') ? u : '/stuonline/web3/' + u);
  try {
    const r = await get(path);
    files[u] = r.text;
    console.log(`  下载 ${path} → ${r.status} ${r.text.length}B`);
  } catch (e) { console.log(`  下载 ${path} 失败: ${String(e).slice(0, 80)}`); }
}

// 2) 在 JS 里搜下载/文件相关关键词
const KEYS = ['download', 'downloadFile', 'fileId', '附件', 'downloadUrl', 'preview', 'getFileUrl', 'folder', 'fileList', 'findFile'];
console.log('\n=== JS 中的下载线索 ===');
for (const [name, txt] of Object.entries(files)) {
  if (!txt) continue;
  for (const k of KEYS) {
    let idx = -1, n = 0;
    while ((idx = txt.indexOf(k, idx + 1)) >= 0 && n < 2) {
      const ctx = txt.slice(Math.max(0, idx - 220), idx + 260).replace(/\s+/g, ' ');
      console.log(`\n[${name}] "${k}" @${idx}`);
      console.log('   ' + ctx);
      n++;
    }
  }
}

writeFileSync(OUT + '\\folder-js.json', JSON.stringify({ jsUrls: [...jsUrls], files }, null, 2));

// 3) 页面里出现的 json 接口路径
const apis = new Set();
for (const [name, txt] of Object.entries({ page: page.text, ...files })) {
  for (const m of txt.matchAll(/["'`](\/stuonline\/[A-Za-z0-9_\/.]*(?:json|folder|file|download)[A-Za-z0-9_\/.]*)["'`]/gi)) apis.add(m[1]);
}
console.log('\n=== 页面/JS 中的 stuonline 接口路径 ===');
for (const a of [...apis].sort()) console.log('  ', a);
writeFileSync(OUT + '\\folder-apis.json', JSON.stringify([...apis].sort(), null, 2));
