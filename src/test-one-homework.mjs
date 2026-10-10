// 单份作业抓题测试 —— 验证「进入试卷」是否消耗作答次数
// 测试对象：思想道德与法治 / 绪论单元测试（仅 1 题，代价最小）
// 绝对不提交
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const TARGET = {
  course: '思想道德与法治',
  name: '绪论单元测试',
  recruitId: 453708,
  courseId: 1000070264,
  schoolId: 5371,
  stuExamId: 'eglo6LgO',
  examId: 'wKEgOnL5',
  meetCourseType: 0,
};
const LIST_URL = 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=EOqgk1o%2BZedyU2sIWgDgNQ%3D%3D';

const { browser, ctx } = await connect();
const page = await ctx.newPage();

const api = [];
page.on('request', (r) => {
  const u = r.url();
  if (!/studentexam-api|taurusexam-api|zhihuishu/.test(u)) return;
  if (/\.(js|css|png|jpg|gif|woff2?|ico)(\?|$)/.test(u)) return;
  api.push({ method: r.method(), url: u.slice(0, 180), post: (r.postData() || '').slice(0, 600) });
});
page.on('response', async (r) => {
  const u = r.url();
  if (!/studentexam-api|taurusexam-api/.test(u)) return;
  const rec = api.find((c) => u.startsWith(c.url) && !c.status);
  if (!rec) return;
  rec.status = r.status();
  const ct = r.headers()['content-type'] || '';
  if (/json/.test(ct)) { try { rec.body = (await r.text()).slice(0, 3000); } catch {} }
});

// ---------- 步骤 1：记录测试前的列表状态 ----------
console.log('[1] 读取测试前状态…');
await page.goto(LIST_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(12000);

async function readListState() {
  const found = await page.evaluate(() => {
    const el = document.querySelector('#app') || document.body;
    const vm = el && el.__vue__;
    if (!vm) return null;
    const walk = (o, depth = 0) => {
      if (!o || depth > 4) return null;
      if (Array.isArray(o) && o.length && o[0] && o[0].examName) return o;
      for (const k of Object.keys(o)) {
        try { const r = walk(o[k], depth + 1); if (r) return r; } catch {}
      }
      return null;
    };
    return walk(vm.$data);
  });
  return found;
}

let beforeList = await readListState();
console.log('    列表项数:', beforeList ? beforeList.length : '未取到');
let beforeItem = beforeList ? beforeList.find((x) => x.id === TARGET.stuExamId) : null;
console.log('    目标项（前）:', beforeItem ? JSON.stringify({ examName: beforeItem.examName, state: beforeItem.state, backNum: beforeItem.backNum, score: beforeItem.score }) : '未找到');

// ---------- 步骤 2：进入试卷 ----------
const url = `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/${TARGET.recruitId}/${TARGET.stuExamId}/${TARGET.examId}/${TARGET.courseId}/${TARGET.schoolId}/${TARGET.meetCourseType}`;
console.log('\n[2] 进入试卷:', url);
const apiBefore = api.length;
await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 }).catch((e) => console.log('   goto:', String(e).slice(0, 100)));
await page.waitForTimeout(15000);

const paper = await page.evaluate(() => {
  const out = {
    url: location.href,
    title: document.title,
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 2000),
    // 题目结构探测
    questionSelectors: {},
    submitButtons: [],
    dialogs: [],
  };
  for (const s of ['[class*=question]', '[class*=topic]', '[class*=subject]', '[class*=stem]', '.question-item', '[class*=paper]', '[class*=answer]']) {
    out.questionSelectors[s] = document.querySelectorAll(s).length;
  }
  out.submitButtons = [...document.querySelectorAll('button, a, [class*=btn]')]
    .map((b) => (b.innerText || '').trim()).filter((t) => /提交|交卷|保存/.test(t));
  out.dialogs = [...document.querySelectorAll('[class*=dialog], [class*=modal], [class*=confirm], [class*=tip]')]
    .map((d) => (d.innerText || '').replace(/\s+/g, ' ').trim()).filter((t) => t).slice(0, 5);
  out.inputs = document.querySelectorAll('input[type=radio], input[type=checkbox]').length;
  return out;
});

console.log('\n[3] 试卷页状态');
console.log('    url:', paper.url);
console.log('    题干预选择器命中:', JSON.stringify(paper.questionSelectors));
console.log('    选项输入数:', paper.inputs);
console.log('    提交类按钮:', JSON.stringify(paper.submitButtons));
if (paper.dialogs.length) console.log('    弹层:', JSON.stringify(paper.dialogs));
console.log('    正文:', paper.text.slice(0, 900));

console.log('\n[4] 进入试卷产生的新请求:');
for (const c of api.slice(apiBefore)) {
  console.log(`    [${c.status ?? '...'}] ${c.method} ${c.url}`);
  if (c.post) console.log('        post:', c.post.slice(0, 350));
  if (c.body) console.log('        body:', c.body.replace(/\s+/g, ' ').slice(0, 700));
}

await page.screenshot({ path: OUT + '\\paper-test.png', fullPage: false }).catch(() => {});

// ---------- 步骤 3：退出（不提交），回列表复查 ----------
console.log('\n[5] 退出试卷（不提交），回列表复查 backNum…');
await page.goto(LIST_URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(14000);
const afterList = await readListState();
const afterItem = afterList ? afterList.find((x) => x.id === TARGET.stuExamId) : null;
console.log('    目标项（后）:', afterItem ? JSON.stringify({ examName: afterItem.examName, state: afterItem.state, backNum: afterItem.backNum, score: afterItem.score }) : '未找到');

const verdict = (beforeItem && afterItem)
  ? (beforeItem.backNum === afterItem.backNum ? `✅ 未消耗次数（backNum 仍为 ${afterItem.backNum}）` : `⚠️ 次数已变化：${beforeItem.backNum} → ${afterItem.backNum}`)
  : '无法判定（数据缺失）';

console.log('\n========== 测试结论 ==========');
console.log('  ' + verdict);
console.log('  state: ' + (beforeItem?.state) + ' → ' + (afterItem?.state));

writeFileSync(OUT + '\\paper-test-result.json', JSON.stringify({ target: TARGET, beforeItem, afterItem, verdict, paper, newApi: api.slice(apiBefore) }, null, 2));
console.log('\n已保存 recon/exam/paper-test-result.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
