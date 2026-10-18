// 用 Firefox 里的 cookie 实测登录态，确证是否存在有效会话
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const WORK = join(ROOT, 'recon', 'ffcookie') + '\\';
const hdrs = JSON.parse(readFileSync(WORK + 'cookie-headers.json', 'utf8'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0';

async function probe(name, url, cookie, extra = {}) {
  const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...extra };
  if (cookie) headers.Cookie = cookie;
  try {
    const res = await fetch(url, { headers, redirect: 'manual' });
    const body = await res.text();
    return { name, url, status: res.status, location: res.headers.get('location'), bytes: body.length, body: body.slice(0, 600) };
  } catch (e) {
    return { name, url, error: String(e) };
  }
}

const ow = hdrs['onlineweb.zhihuishu.com'];
const api = hdrs['onlineservice-api.zhihuishu.com'];

const results = [];
// 1) 学生端首页：带 cookie 看是否被重定向到登录
results.push(await probe('student-home', 'https://onlineweb.zhihuishu.com/onlinestuh5', ow));
// 2) 身份网关接口：未登录应返回未授权
results.push(await probe('queryIdentity', 'https://onlineservice-api.zhihuishu.com/gateway/t/v1/teacher/index2/queryIdentity', api));
// 3) 取当前登录用户
results.push(await probe('getLoginUserInfo', 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', api));
// 4) 对照：gologin 入口是否把未登录用户送去 passport
results.push(await probe('gologin', 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/gologin?fromurl=' + encodeURIComponent('https://coursehomeh5.zhihuishu.com/onlineCourse/'), api));

writeFileSync(WORK + 'auth-probe.json', JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`\n--- ${r.name} ---`);
  console.log('status:', r.status, '| location:', r.location, '| bytes:', r.bytes);
  if (r.body) console.log('body:', r.body.replace(/\s+/g, ' ').slice(0, 400));
  if (r.error) console.log('error:', r.error);
}
