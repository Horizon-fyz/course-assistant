// 在活浏览器里读取 window.yxyz 的实现与密钥机制
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

await page.goto('https://onlinestuh5.zhihuishu.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);

const info = await page.evaluate(() => {
  const out = { hasYxyz: typeof window.yxyz, keys: [], secretFns: [] };
  out.yxyzSource = typeof window.yxyz === 'function' ? window.yxyz.toString().slice(0, 3000) : null;
  // 找出所有与 secret/aes 相关的全局函数
  for (const k of Object.keys(window)) {
    if (/secret|aes|crypt|yxyz|sign/i.test(k)) {
      const v = window[k];
      out.keys.push({ k, type: typeof v });
      if (typeof v === 'function') out.secretFns.push({ k, src: v.toString().slice(0, 1200) });
    }
  }
  out.localStorageToken = localStorage.getItem('token');
  out.lsKeys = Object.keys(localStorage);
  // 加密相关可用性
  out.crypto = { subtle: !!(window.crypto && window.crypto.subtle), CryptoJS: typeof window.CryptoJS };
  return out;
});

console.log('typeof window.yxyz =', info.hasYxyz);
console.log('\n=== localStorage ===', JSON.stringify(info.lsKeys), 'token=', info.localStorageToken);
console.log('\n=== 相关全局函数 ===');
for (const k of info.keys) console.log('  ', k.k, '→', k.type);

if (info.yxyzSource) {
  console.log('\n=== window.yxyz 源码 ===\n');
  console.log(info.yxyzSource);
  writeFileSync(join(ROOT, 'recon', 'sign', 'yxyz-source.js'), info.yxyzSource);
}
for (const f of info.secretFns) {
  if (f.k === 'yxyz') continue;
  console.log(`\n=== window.${f.k} ===\n${f.src}`);
  writeFileSync(`${ROOT}\\recon\\sign\\fn-${f.k}.js`, f.src);
}

// 试着实际生成一次签名，验证可用性
const sig = await page.evaluate(() => {
  try {
    if (typeof window.yxyz !== 'function') return { err: 'yxyz not a function' };
    const payload = { pageNo: 1, pageSize: 20 };
    const s1 = window.yxyz(payload, 13);
    return { ok: true, sample: s1, len: (s1 || '').length, payload };
  } catch (e) { return { err: String(e) }; }
});
console.log('\n=== 签名实测 ===');
console.log(JSON.stringify(sig).slice(0, 800));

await page.close().catch(() => {});
await browser.close().catch(() => {});
