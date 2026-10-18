// 校验 MD 题库是否「一条不落」：拿 papers.json 逐题逐选项回查 MD 正文
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const ARGV = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = ARGV.indexOf('--' + n);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d;
};
const PAPERS = resolve(flag('papers', join(ROOT, 'export', 'papers.json')));
const MD = resolve(flag('md', join(ROOT, 'export', '智慧树作业题库_打印版.md')));

for (const p of [PAPERS, MD]) {
  if (!existsSync(p)) { console.error('缺少 ' + p); process.exit(1); }
}

let data;
try { data = JSON.parse(readFileSync(PAPERS, 'utf8')); }
catch (e) { console.error('papers.json 解析失败：' + String(e.message || e)); process.exit(1); }
const md = readFileSync(MD, 'utf8');

const clean = (t) => String(t ?? '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<\/(p|div|li)>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

const unesc = (t) => t.replace(/\\([\\`*_[\]]|<|>)/g, '$1');

// MD 里的可见文本（去掉样式块、去掉语法符号）
const mdBody = md.replace(/<style>[\s\S]*?<\/style>/g, '');
const mdText = unesc(mdBody.replace(/[*`>#_]/g, ' ')).replace(/\s+/g, ' ');

let qTotal = 0, qMissing = 0, optTotal = 0, optMissing = 0;
const missing = [];

for (const [course, items] of Object.entries(data)) {
  if (!Array.isArray(items)) continue;
  for (const it of items) {
    const qs = (it.paper?.rt?.examBase?.workExamParts ?? []).flatMap((p) => p.questionDtos ?? []);
    for (const q of qs) {
      qTotal++;
      const stem = clean(q.name).replace(/\s+/g, ' ');
      if (!mdText.includes(stem)) { qMissing++; missing.push(`题干缺失: ${course}/${it.examName} :: ${stem.slice(0, 60)}`); }
      for (const o of q.questionOptions ?? []) {
        optTotal++;
        const oc = clean(o.content).replace(/\s+/g, ' ');
        if (!mdText.includes(oc)) { optMissing++; missing.push(`选项缺失: ${course}/${it.examName} :: ${oc.slice(0, 50)}`); }
      }
    }
  }
}

// 结构检查
const h1 = (md.match(/^# /gm) ?? []).length;
const h2 = (md.match(/^## /gm) ?? []).length;
const styleBlocks = (md.match(/<style>/g) ?? []).length;

console.log('=== MD 完整性校验 ===');
console.log(`题目: ${qTotal - qMissing}/${qTotal} 命中`);
console.log(`选项: ${optTotal - optMissing}/${optTotal} 命中`);
console.log(`一级标题(# ) ${h1} 个，二级标题(## ) ${h2} 个，样式块 ${styleBlocks} 个`);
console.log(`文件大小: ${md.length} 字符`);
if (missing.length) {
  console.log('\n--- 缺失明细（最多 20 条）---');
  for (const m of missing.slice(0, 20)) console.log('  ' + m);
}
console.log(qMissing === 0 && optMissing === 0 ? '\n✅ 全部题目与选项均已收录' : '\n❌ 有缺失');
process.exit(qMissing === 0 && optMissing === 0 ? 0 : 3);
