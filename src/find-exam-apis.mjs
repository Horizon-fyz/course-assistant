// 找出「开始答题」进入试卷的真实路由与取题接口（静态分析，不点击）
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = await readyPage(ctx, 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html');

// 在页面里直接下载 exam 前端 JS 并搜索取题接口
const found = await page.evaluate(async () => {
  const out = { scripts: [], hits: {} };
  const srcs = [...document.querySelectorAll('script[src]')].map((s) => s.src);
  out.scripts = srcs.map((s) => s.split('/').pop());
  const KEYS = ['getExamPaper', 'examPaper', 'startExam', 'getQuestion', 'questionList', 'paperId',
    'beginExam', 'startAnswer', 'getStuExam', 'answerSheet', 'submitExam', 'saveAnswer',
    'getExamInfo', 'examDetail', 'toExam', 'enterExam'];
  for (const u of srcs) {
    try {
      const t = await (await fetch(u)).text();
      for (const k of KEYS) {
        const c = (t.match(new RegExp(k, 'g')) || []).length;
        if (c) {
          if (!out.hits[k]) out.hits[k] = [];
          out.hits[k].push({ file: u.split('/').pop(), count: c });
        }
      }
    } catch {}
  }
  return out;
});

console.log('=== 脚本 ===');
console.log(found.scripts.join(', '));
console.log('\n=== 关键词命中 ===');
for (const [k, v] of Object.entries(found.hits)) {
  console.log(`  ${k.padEnd(18)} ${v.map((x) => `${x.file}(${x.count})`).join(', ')}`);
}

// 进一步：在最大那个 JS 里提取 /gateway 下的所有接口路径
const apis = await page.evaluate(async () => {
  const srcs = [...document.querySelectorAll('script[src]')].map((s) => s.src);
  const set = new Set();
  for (const u of srcs) {
    try {
      const t = await (await fetch(u)).text();
      for (const m of t.matchAll(/["'`]((?:https?:\/\/[a-z0-9.-]+)?\/[a-zA-Z0-9_-]*\/?gateway\/[A-Za-z0-9_\/.v-]+)["'`]/g)) set.add(m[1]);
      for (const m of t.matchAll(/["'`](\/(?:studentExam|taurusExam)\/[A-Za-z0-9_\/.-]+)["'`]/g)) set.add(m[1]);
    } catch {}
  }
  return [...set].sort();
});

console.log('\n=== 前端引用到的 exam 接口路径 ===');
for (const a of apis) console.log('  ' + a);
writeFileSync(OUT + '\\exam-js-apis.json', JSON.stringify({ found, apis }, null, 2));
console.log('\n已保存 recon/exam/exam-js-apis.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
