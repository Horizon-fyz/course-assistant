// 验证 doHomework 的 secretStr 能否复用（决定批量抓取的实现方式）
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = await readyPage(ctx, 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=EOqgk1o%2BZedyU2sIWgDgNQ%3D%3D');
await page.waitForTimeout(6000);

// 从进入试卷时捕获到的 doHomework secretStr（测试对象：绪论单元测试 eglo6LgO / wKEgOnL5）
const SIG = 'NVFehMNK2TCkgpSCG5zhqiUeYMkGB6++X5OZs4QG5gIFV8ZBPtTJue8kYohJA6giCl731C1E9G71OwQqpMeWqjvP+Sueoupho1s2Q5DSRKY/4zvI9GiHJp+H8tPU1QrOFtBAeVP946ae63CpZU2Sdg==';

// 目标：换一个不同的作业（第一章单元测试 ePK02QbB / yqk4n2oe）
const TESTS = [
  { label: 'A_原样复用签名+同一作业', stuExamId: 'eglo6LgO', examId: 'wKEgOnL5' },
  { label: 'B_复用签名+换作业', stuExamId: 'ePK02QbB', examId: 'yqk4n2oe' },
];

const res = await page.evaluate(async ([sig, tests]) => {
  const out = {};
  for (const t of tests) {
    try {
      const body = new URLSearchParams({
        secretStr: sig,
        stuExamId: t.stuExamId,
        examId: t.examId,
      }).toString();
      const r = await fetch('https://studentexam-api.zhihuishu.com/studentExam/gateway/t/v1/student/doHomework', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const t2 = await r.text();
      let j = null;
      try { j = JSON.parse(t2); } catch {}
      out[t.label] = {
        status: r.status,
        code: j?.code,
        msg: j?.msg || j?.message,
        examName: j?.rt?.examBase?.name,
        problemNum: j?.rt?.examBase?.problemNum,
        raw: t2.slice(0, 400),
      };
    } catch (e) { out[t.label] = { error: String(e).slice(0, 150) }; }
  }
  return out;
}, [SIG, TESTS]);

for (const [k, v] of Object.entries(res)) {
  console.log(`\n=== ${k} ===`);
  console.log(JSON.stringify(v, null, 1));
}

writeFileSync(OUT + '\\sig-reuse-test.json', JSON.stringify(res, null, 2));
console.log('\n已保存');
await browser.close().catch(() => {});
