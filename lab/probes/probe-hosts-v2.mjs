// 全量域名巡检 v2：用 Node 原生 fetch 直连，状态码/响应头/内容都能干净拿到
// 不依赖浏览器导航，避免 goto 把 4xx/5xx 当异常、也不会被并发脚本干扰
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const BASE = ROOT;
const OUT = BASE + '\\recon\\hosts';
mkdirSync(OUT, { recursive: true });

const hosts = JSON.parse(readFileSync(BASE + '\\recon\\_artifacts\\all-hosts.json', 'utf8'));

// 用真实会话 cookie，保证「已登录视角」的巡检
let cookieByDomain = {};
try { cookieByDomain = JSON.parse(readFileSync(BASE + '\\session\\cookie-headers.json', 'utf8')); } catch {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

function cookieFor(host) {
  const parts = [];
  for (const [d, v] of Object.entries(cookieByDomain)) {
    if (host === d || host.endsWith('.' + d)) parts.push(v);
  }
  return parts.join('; ');
}

async function probe(host) {
  const url = `https://${host}/`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Cookie: cookieFor(host) },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text().catch(() => '');
    const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim().replace(/\s+/g, ' ').slice(0, 80);
    const textSample = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return {
      host, url, ok: true, status: res.status,
      server: res.headers.get('server') || '',
      contentType: (res.headers.get('content-type') || '').split(';')[0],
      location: res.headers.get('location') || '',
      setCookie: res.headers.getSetCookie ? res.headers.getSetCookie().map((c) => c.split('=')[0]) : [],
      bodyLen: body.length, title, textSample,
      ms: Date.now() - t0,
      looksLikeLogin: /登录中心|login|请输入密码/i.test(title) || /name=["']password["']/i.test(body),
    };
  } catch (e) {
    return { host, url, ok: false, error: (e && (e.cause?.code || e.name || e.message)) + '', ms: Date.now() - t0 };
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

console.log(`巡检 ${hosts.length} 个域名（带会话 cookie）…\n`);
const results = await mapLimit(hosts, 10, async (h) => {
  const r = await probe(h);
  const mark = r.ok ? String(r.status) : 'ERR';
  console.log(`  ${mark.padStart(4)}  ${h.padEnd(42)} ${(r.title || r.error || '').slice(0, 40)}`);
  return r;
});

writeFileSync(OUT + '\\probe-v2.json', JSON.stringify(results, null, 2));

const ok = results.filter((r) => r.ok);
console.log('\n\n================ 汇总 ================');
console.log('域名总数     :', results.length);
console.log('HTTP 有响应  :', ok.length);
console.log('200          :', ok.filter((r) => r.status === 200).length);
console.log('302/301 跳转 :', ok.filter((r) => [301, 302, 307, 308].includes(r.status)).length);
console.log('403/404 等   :', ok.filter((r) => r.status >= 400).length);
console.log('网络不可达   :', results.filter((r) => !r.ok).length);

const byStatus = {};
for (const r of results) {
  const k = r.ok ? String(r.status) : 'NETFAIL';
  (byStatus[k] ||= []).push(r.host);
}
console.log('\n=== 按状态码分组 ===');
for (const [k, v] of Object.entries(byStatus).sort()) console.log(`  ${k.padEnd(8)} (${String(v.length).padStart(2)})  ${v.join(', ')}`);
