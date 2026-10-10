// 下载登录中心全部 JS，抽取接口路径 / 参数名 / 加密线索
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const SRC = join(ROOT, 'recon', 'loginsite');
const JS = join(SRC, 'js');
mkdirSync(JS, { recursive: true });

const urls = readFileSync(join(SRC, 'asset-urls.txt'), 'utf8').split('\n').map((s) => s.trim()).filter((u) => u.endsWith('.js') || /\.js\?/.test(u));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

const saved = [];
for (const u of urls) {
  const name = u.split('/').pop().split('?')[0];
  try {
    const res = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://login.zhihuishu.com/' } });
    const text = await res.text();
    writeFileSync(join(JS, name), text);
    saved.push({ name, bytes: text.length, status: res.status });
  } catch (e) {
    saved.push({ name, error: String(e) });
  }
}

// 汇总所有 JS 里的接口线索
const interesting = /(\/api\/|\/zhsuser|\/login|gologin|ssoLogin|unid|schoolId|schoolName|NECaptchaValidate|captcha|validate|encrypt|aes|md5|sha|password|publicKey|getPublicKey|checkCode|preLogin|findCollege|collegeId)/i;
const findings = [];
for (const s of saved) {
  if (!s.bytes) continue;
  const text = readFileSync(join(JS, s.name), 'utf8');
  const paths = new Set();
  for (const m of text.matchAll(/["'`](\/[A-Za-z0-9_\-/.{}$]{4,90})["'`]/g)) {
    if (/api|login|user|captcha|validate|college|school|password|code/i.test(m[1])) paths.add(m[1]);
  }
  const keys = new Set();
  for (const m of text.matchAll(/["'`]([A-Za-z_][A-Za-z0-9_]{2,40})["'`]\s*:/g)) keys.add(m[1]);
  findings.push({ file: s.name, bytes: s.bytes, paths: [...paths], keys: [...keys].filter((k) => interesting.test(k)) });
}

writeFileSync(join(SRC, 'js-findings.json'), JSON.stringify(findings, null, 2));

console.log('downloaded js files:', saved.length);
for (const f of findings) {
  if (!f.paths.length && !f.keys.length) continue;
  console.log(`\n=== ${f.file} (${f.bytes}B) ===`);
  if (f.paths.length) console.log('  paths:', f.paths.join(' , '));
  if (f.keys.length) console.log('  keys :', f.keys.join(' , '));
}
