// 用已登录会话直连接口，验证可行性并抓取真实数据
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'api');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => p.url().includes('onlineweb')) ?? (await ctx.newPage());

await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

// 在页面上下文里调用接口（自动带 cookie、同源策略由 fetch 处理）
const results = await page.evaluate(async () => {
  const out = {};
  async function call(name, url, opts = {}) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { credentials: 'include', ...opts });
      const txt = await r.text();
      out[name] = { status: r.status, ms: Date.now() - t0, len: txt.length, body: txt.slice(0, 2500) };
    } catch (e) {
      out[name] = { error: String(e) };
    }
  }

  await call('01_课程列表', 'https://onlineservice-api.zhihuishu.com/gateway/t/v1/student/course/share/queryShareCourseInfo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageNo: 1, pageSize: 20 }),
  });

  await call('02_公告未读数', 'https://onlineservice-api.zhihuishu.com/gateway/t/v1/mirror/home/cheat/findCheatListCount');

  await call('03_学习报告', 'https://stuonline.zhihuishu.com/stuonline/stuLearnReportNew/index?recruitId=435122&courseId=1000101708');

  await call('04_课程问答', 'https://qah5.zhihuishu.com/qa.html#/web/home/1000101708?role=2&recruitId=435122');

  await call('05_课程资料', 'https://stuonline.zhihuishu.com/stuonline/folder/stuIndexV2?recruitId=435122&courseId=1000101708');

  await call('06_见面课', 'https://stuonline.zhihuishu.com/stuonline/teachMeeting/stuListV2?recruitId=435122');

  await call('07_用户信息', 'https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo');

  await call('08_消息', 'https://onlineservice-api.zhihuishu.com/gateway/t/v1/teacher/message/message/listStudentSystemMessage');

  await call('09_待提交考试', 'https://onlineservice-api.zhihuishu.com/gateway/t/v1/student/getStudentNoCommitExam');

  return out;
});

writeFileSync(OUT + '\\direct-api.json', JSON.stringify(results, null, 2));
for (const [k, v] of Object.entries(results)) {
  console.log(`\n=== ${k} === status=${v.status} ${v.ms}ms len=${v.len}`);
  if (v.error) { console.log('  ERR', v.error); continue; }
  console.log('  ' + (v.body || '').replace(/\s+/g, ' ').slice(0, 700));
}

await browser.close().catch(() => {});
