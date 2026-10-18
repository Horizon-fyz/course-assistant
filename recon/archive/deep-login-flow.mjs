// 深挖 index-CiBUKrg9.js 里的登录流程：如何构造 /login/account 请求、密码怎么加密
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const SRC = join(ROOT, 'recon', 'loginsite', 'js', 'index-CiBUKrg9.js');
const text = readFileSync(SRC, 'utf8');
const out = [];

function show(label, needle, before = 700, after = 1200, max = 4) {
  out.push(`\n############ ${label} :: ${needle} ############`);
  let idx = 0, n = 0;
  while (n < max) {
    const i = text.indexOf(needle, idx);
    if (i < 0) break;
    out.push(`--- occurrence @${i} ---`);
    out.push(text.slice(Math.max(0, i - before), i + after));
    idx = i + needle.length;
    n++;
  }
  if (n === 0) out.push('(not found)');
}

show('/login/account', '/login/account', 900, 1500, 3);
show('encrypt/aes', 'encrypt', 300, 700, 6);
show('JSEncrypt/RSA', 'JSEncrypt', 300, 700, 3);
show('publicKey', 'publicKey', 300, 700, 4);
show('AES', 'AES', 200, 500, 4);
show('md5', 'md5', 200, 500, 4);
show('NECaptchaValidate', 'NECaptchaValidate', 400, 800, 4);
show('unid', 'unid', 300, 700, 6);
show('schoolId', 'schoolId', 300, 700, 4);
show('/oauth/login/checkLogin', '/oauth/login/checkLogin', 600, 900, 2);
show('/sms/initLogin', '/sms/initLogin', 600, 900, 2);
show('polymasApi/getToken', '/polymasApi/getToken', 600, 900, 2);

writeFileSync(join(ROOT, 'recon', 'loginsite', 'login-flow.txt'), out.join('\n'));
console.log('written, total chars:', out.join('\n').length);
console.log('needle hits:', JSON.stringify({
  loginAccount: (text.match(/\/login\/account/g) || []).length,
  encrypt: (text.match(/encrypt/gi) || []).length,
  JSEncrypt: (text.match(/JSEncrypt/g) || []).length,
  publicKey: (text.match(/publicKey/gi) || []).length,
  AES: (text.match(/AES/g) || []).length,
  md5: (text.match(/md5/gi) || []).length,
  unid: (text.match(/unid/g) || []).length,
  schoolId: (text.match(/schoolId/gi) || []).length,
  NECaptchaValidate: (text.match(/NECaptchaValidate/g) || []).length,
}));
