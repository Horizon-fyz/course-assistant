// 探测 421 原因：单接口单独重试（带间隔）
import { chromium } from 'playwright';

const SIG_VIDEO = 'QhSgx0MEvvp0jRL20aaxWiUkrjuZvigMo7O0OApkaCEo76j+nBmFpel6fwHuTiRWnz+pGIblHqSmkUPS2xszknn3/CwHW1Br60fY/IJ4iX7UCYd8wCln28Ex0cB0bmgJ';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = await ctx.newPage();
await page.goto('https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=4e5b5c59475b4859454a585858445e4350', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(6000);

const cases = [
  ['queryStudyReadBefore', 'POST', '/learning/queryStudyReadBefore', { secretStr: SIG_VIDEO, dateFormate: Date.now(), recruitId: 435122, courseId: 1000101708 }],
  ['queryStuyInfo', 'POST', '/learning/queryStuyInfo', { secretStr: SIG_VIDEO, dateFormate: Date.now(), recruitId: 435122, courseId: 1000101708 }],
  ['videolist', 'POST', '/learning/videolist', { secretStr: SIG_VIDEO, dateFormate: Date.now(), recruitId: 435122, courseId: 1000101708 }],
];

const SVC = 'https://studyservice-api.zhihuishu.com/gateway/t/v1';

for (const [name, method, path, form] of cases) {
  const r = await page.evaluate(async ([u, f]) => {
    const res = await fetch(u, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(f).toString(),
    });
    const t = await res.text();
    return { status: res.status, ct: res.headers.get('content-type'), body: t.slice(0, 700) };
  }, [`${SVC}${path}`, form]);
  console.log(`\n=== ${name} === HTTP ${r.status} (${r.ct})`);
  console.log(r.body.replace(/\s+/g, ' ').slice(0, 500));
  await page.waitForTimeout(3000);
}

await page.close().catch(() => {});
await browser.close().catch(() => {});
