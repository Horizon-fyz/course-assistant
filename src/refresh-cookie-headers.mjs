// 重新生成各域 Cookie 请求头（正确包含父域 .zhihuishu.com / .polymas.com 的 cookie）
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'session');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const cookies = await ctx.cookies();

// Chromium 的 cookie 匹配规则：host 等于 domain，或 domain 以点开头且 host 以之结尾
function cookieHeaderFor(host) {
  const matched = cookies.filter((c) => {
    const d = c.domain;
    if (d.startsWith('.')) return host === d.slice(1) || host.endsWith(d);
    return host === d;
  });
  return matched.map((c) => `${c.name}=${c.value}`).join('; ');
}

// 目标域 = 巡检清单里的所有主机
const hosts = JSON.parse((await import('node:fs')).readFileSync(join(ROOT, 'recon', 'all-hosts.json'), 'utf8'));
const headers = {};
for (const h of hosts) {
  const v = cookieHeaderFor(h);
  if (v) headers[h] = v;
}
writeFileSync(OUT + '\\cookie-headers.json', JSON.stringify(headers, null, 2));

console.log('有 cookie 的域:', Object.keys(headers).length);
for (const h of hosts) {
  const v = headers[h];
  const names = v ? v.split('; ').map((p) => p.split('=')[0]) : [];
  const key = names.filter((n) => /SESSION|JSESSIONID|CASTGC|jt-cas|token/i.test(n));
  console.log(`  ${h.padEnd(42)} len=${String(v ? v.length : 0).padStart(5)}  关键票据=[${key.join(',')}]`);
}
await browser.close().catch(() => {});
