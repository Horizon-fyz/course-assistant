// 探查 papers.json 的字段结构，确认 MD 需要覆盖哪些内容
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('K:\\网页自动学习\\export\\papers.json', 'utf8'));

const courseNames = Object.keys(data);
console.log('课程:', courseNames);

// 作业级字段
const firstHw = data[courseNames[0]][0];
const hwNoPaper = Object.entries(firstHw).filter(([k]) => k !== 'paper');
console.log('\n=== 作业级字段 ===');
for (const [k, v] of hwNoPaper) console.log(`  ${k}: ${JSON.stringify(v)?.slice(0, 90)}`);

// 试卷级字段
const base = firstHw.paper?.rt?.examBase ?? {};
console.log('\n=== examBase 字段 ===');
for (const [k, v] of Object.entries(base)) {
  const t = Array.isArray(v) ? `Array(${v.length})` : typeof v;
  console.log(`  ${k}: ${t}${Array.isArray(v) || typeof v === 'object' ? '' : ' = ' + JSON.stringify(v)?.slice(0, 70)}`);
}
console.log('  workExamParts[].keys:', base.workExamParts?.[0] ? Object.keys(base.workExamParts[0]) : 'none');

// 题目级字段（取一道有选项的题）
const qs = (base.workExamParts ?? []).flatMap((p) => p.questionDtos ?? []);
console.log('\n=== 题目级字段（第一题）===');
const q0 = qs[0];
for (const [k, v] of Object.entries(q0)) {
  const t = Array.isArray(v) ? `Array(${v.length})` : typeof v;
  console.log(`  ${k}: ${t}${Array.isArray(v) || typeof v === 'object' ? '' : ' = ' + JSON.stringify(v)?.slice(0, 70)}`);
}
if (q0.questionOptions?.[0]) {
  console.log('  questionOptions[0] keys:', Object.keys(q0.questionOptions[0]));
  console.log('  questionOptions[0]:', JSON.stringify(q0.questionOptions[0]).slice(0, 300));
}
console.log('  questionType:', JSON.stringify(q0.questionType));

// 全局统计：有哪些题型、是否有图片/附件字段
const typeSet = new Map();
let withImg = 0, totalQ = 0, fillBlank = 0, withAnswerField = 0;
const allQ = [];
for (const items of Object.values(data)) {
  for (const it of items) {
    for (const p of it.paper?.rt?.examBase?.workExamParts ?? []) {
      for (const q of p.questionDtos ?? []) {
        totalQ++;
        allQ.push(q);
        const tn = q.questionType?.name ?? '?';
        typeSet.set(tn, (typeSet.get(tn) ?? 0) + 1);
        const s = JSON.stringify(q);
        if (/<img|\.png|\.jpg|image/i.test(s)) withImg++;
        if ((q.questionOptions ?? []).length === 0) fillBlank++;
        if (q.answer !== undefined || q.rightAnswer !== undefined || q.correctAnswer !== undefined) withAnswerField++;
      }
    }
  }
}
console.log('\n=== 全局统计 ===');
console.log('  题目总数:', totalQ);
console.log('  题型分布:', JSON.stringify([...typeSet.entries()], null, 1));
console.log('  含图片字样/图片字段的题:', withImg);
console.log('  无选项（填空/简答类）的题:', fillBlank);
console.log('  自带答案字段的题:', withAnswerField);

// 看一道没有选项的题
const noOpt = allQ.find((q) => (q.questionOptions ?? []).length === 0);
if (noOpt) {
  console.log('\n=== 一道无选项的题 ===');
  console.log(JSON.stringify(noOpt, null, 1).slice(0, 1200));
}
// 看一道有图片的题
const imgQ = allQ.find((q) => /<img|\.png|\.jpg/i.test(JSON.stringify(q)));
if (imgQ) {
  console.log('\n=== 一道含图片线索的题 ===');
  console.log(JSON.stringify(imgQ, null, 1).slice(0, 1200));
}
