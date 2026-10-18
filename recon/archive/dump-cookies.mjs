import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = b.contexts()[0];
const all = await ctx.cookies();
const zhs = all.filter(c => /zhihuishu|polymas/.test(c.domain));
const now = Math.floor(Date.now()/1000);
console.log('智慧树相关 cookie:', zhs.length);
console.log('name'.padEnd(34), 'domain'.padEnd(34), 'expires', '  session?', ' httpOnly', ' secure');
for (const c of zhs.sort((a,b)=>a.name.localeCompare(b.name))) {
  const exp = c.expires && c.expires > 0 ? new Date(c.expires*1000).toISOString().slice(0,19) : 'SESSION';
  const isSession = !(c.expires && c.expires > 0);
  console.log(String(c.name).padEnd(34), String(c.domain).padEnd(34), exp.padEnd(20), isSession ? 'YES' : 'no', '  ', c.httpOnly, '   ', c.secure);
}
console.log('\n关键票据:');
for (const c of zhs.filter(c=>/SESSION|CASTGC|jt-cas|polymas-token|JSESSIONID/i.test(c.name)))
  console.log('  ', c.domain, c.name, 'len=' + (c.value||'').length, 'expires=' + (c.expires>0?c.expires:'session'));
await b.close();
