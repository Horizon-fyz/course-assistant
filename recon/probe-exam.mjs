// 只读探针：打开指定作业页，输出锚点/可见题/按钮/选项结构，用于验证自动答题选择器
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from '../src/browser.mjs';

const ROOT = join(import.meta.dirname, '..');
const EXPORT = join(ROOT, 'export');
const papers = JSON.parse(readFileSync(join(EXPORT, 'papers.json'), 'utf8'));
const resolved = JSON.parse(readFileSync(join(EXPORT, 'courses-resolved.json'), 'utf8'));

const course = process.argv[2] || '国家安全教育';
const examLike = process.argv[3] || '第一章';
const it = papers[course].find((x) => x.examName.includes(examLike));
if (!it) throw new Error('未找到作业: ' + course + ' / ' + examLike);
const url = `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/`
  + `${resolved[course].recruitId}/${it.id}/${it.examId}/${it.courseId}/5371/${it.meetCourseType ?? 0}`;

const { ctx, describe, close } = await connect();
console.log('浏览器:', describe);
const page = ctx.pages().find((p) => p.url().includes('onlineexamh5new')) ?? await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
if (!(await page.evaluate((n) => document.body.innerText.includes(n), it.examName).catch(() => false))) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
}
await page.bringToFront().catch(() => {});

const info = await page.evaluate(() => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const subs = [...document.querySelectorAll('.examPaper_subject')].filter((s) => s.querySelector('.nodeLab'));
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const buttons = [...document.querySelectorAll('button, a, [class*=btn], div[role=button]')]
    .filter((n) => clean(n.innerText).length <= 8)
    .map((n) => ({ text: clean(n.innerText), cls: n.className, disabled: n.disabled || /disabled/.test(n.className) }))
    .filter((x) => x.text);
  return {
    url: location.href,
    bodyHead: clean(document.body.innerText).slice(0, 300),
    anchors: subs.map((s) => {
      const a = s.querySelector('.subject_num span[id^=anchor_]');
      const num = clean(s.querySelector('.subject_num')?.innerText || '');
      const r = s.getBoundingClientRect();
      return { id: a?.id || null, num, visible: vis(s), rect: { w: Math.round(r.width), h: Math.round(r.height) } };
    }),
    buttons,
    firstOptionHtml: subs[0]?.querySelector('.nodeLab')?.outerHTML?.slice(0, 900) || null,
  };
});
console.log(JSON.stringify(info, null, 2));
await close();
