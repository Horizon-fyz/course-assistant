// 把抓到的试卷生成「可读 + 可打印」的 Markdown 复习稿
//
// 产物：export/智慧树作业题库_打印版.md
// 特点：
//   1) 完整 —— 3 门课 27 份作业 191 道题，题干 + 全部选项 + 题型 + 分值，一条不落
//   2) 可读 —— 标题层级清晰、题目编号连续、选项缩进对齐
//   3) 可打印 —— 顶部内嵌 @media print 样式；正文自 <h1> 起，课程/作业自动分页
//
// 用法：
//   node recon\make-md.mjs                       # 完整版（含打印样式）
//   node recon\make-md.mjs --bare                # 纯 Markdown（不含 HTML 样式块）
//   node recon\make-md.mjs --src X.json --out Y.md --account "示例用户（示例大学）"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const ARGV = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = ARGV.indexOf('--' + n);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d;
};
const bare = ARGV.includes('--bare');

const SRC = resolve(flag('src', join(ROOT, 'export', 'papers.json')));
const OUT = resolve(flag('out', join(ROOT, 'export', bare ? '智慧树作业题库.md' : '智慧树作业题库_打印版.md')));
const STUDENT = flag('student', '示例用户');
const SCHOOL = flag('school', '示例大学');

if (!existsSync(SRC)) { console.error('缺少 ' + SRC); process.exit(1); }
mkdirSync(dirname(OUT), { recursive: true });
const data = JSON.parse(readFileSync(SRC, 'utf8'));

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 清掉题干里的 HTML 标签，保留换行语义 */
function clean(text) {
  if (!text) return '';
  return String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Markdown 转义：只转义会破坏语法的符号，中文标点保持原样以便阅读 */
function esc(text) {
  return String(text).replace(/([\\`*_[\]]|<|>)/g, '\\$1');
}

function questionsOf(item) {
  const base = item?.paper?.rt?.examBase ?? {};
  return (base.workExamParts ?? []).flatMap((p) => p.questionDtos ?? []);
}

const courses = Object.entries(data).filter(([, items]) => items.length);
const totalHw = courses.reduce((s, [, items]) => s + items.length, 0);
const totalQ = courses.reduce((s, [, items]) => s + items.reduce((a, it) => a + questionsOf(it).length, 0), 0);
const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

// 题型统计
const typeCount = new Map();
for (const [, items] of courses) for (const it of items) for (const q of questionsOf(it)) {
  const t = q.questionType?.name ?? '未知';
  typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
}
const typeLine = [...typeCount.entries()].map(([k, v]) => `${k} ${v}`).join(' / ');

const L = [];

// ---------- 打印样式（仅完整版） ----------
if (!bare) {
  L.push('<style>');
  L.push('@media print {');
  L.push('  @page { size: A4; margin: 18mm 16mm; }');
  L.push('  h1 { page-break-before: always; }');
  L.push('  h1:first-of-type { page-break-before: avoid; }');
  L.push('  h2 { page-break-after: avoid; page-break-inside: avoid; }');
  L.push('  blockquote { page-break-inside: avoid; }');
  L.push('  body { font-size: 10.5pt; line-height: 1.5; }');
  L.push('}');
  L.push('body { font-family: "Microsoft YaHei", "微软雅黑", "Songti SC", serif; max-width: 900px; margin: 0 auto; padding: 24px; line-height: 1.6; }');
  L.push('h1 { color: #1f3a93; }');
  L.push('blockquote { margin: 2px 0 2px 1.2em; padding-left: 10px; border-left: 3px solid #e3e3e3; color: #222; }');
  L.push('code { background: #f4f4f4; padding: 0 4px; border-radius: 3px; font-size: 0.92em; }');
  L.push('hr { border: none; border-top: 1px solid #ddd; margin: 18px 0; }');
  L.push('</style>');
  L.push('');
}

// ---------- 封面（纯 Markdown，不依赖 HTML 容器） ----------
L.push('# 智慧树作业题库');
L.push('');
L.push('### 复习与打印稿');
L.push('');
L.push(`**共 ${courses.length} 门课程 · ${totalHw} 份作业 · ${totalQ} 道题目**`);
L.push('');
L.push(`题型分布：\`${typeLine}\``);
L.push('');
L.push(`生成时间：\`${stamp}\`　·　账号：\`${STUDENT}（${SCHOOL}）\``);
L.push('');
L.push('`本稿由已登录会话读取试卷内容生成，仅供本人复习使用；未作答、未提交任何作业。`');
L.push('');
L.push('---');
L.push('');

// ---------- 目录 ----------
L.push('## 目录');
L.push('');
for (const [course, items] of courses) {
  const cq = items.reduce((a, it) => a + questionsOf(it).length, 0);
  L.push(`- **${course}**（${items.length} 份作业 · ${cq} 题）`);
  for (const it of items) {
    const n = questionsOf(it).length;
    L.push(`  - ${it.examName ?? '(未知)'}　${n} 题　${it.totalScore ?? ''} 分　截止 ${String(it.endDate ?? '').slice(0, 10)}`);
  }
}
L.push('');
L.push('---');
L.push('');

// 全局题号
let gnum = 0;

// ---------- 正文 ----------
for (const [course, items] of courses) {
  const cq = items.reduce((a, it) => a + questionsOf(it).length, 0);
  L.push('');
  L.push(`# ${course}`);
  L.push('');
  L.push(`> 本课程 ${items.length} 份作业，共 ${cq} 道题目。`);
  L.push('');
  L.push('---');
  L.push('');

  for (const it of items) {
    const qs = questionsOf(it);
    if (!qs.length) continue;

    L.push(`## ${it.examName ?? ''}`);
    L.push('');
    const bits = [];
    if (it.cpOrderNumber) bits.push(`章节：${it.cpOrderNumber}`);
    if (it.problemNum != null) bits.push(`题目数：${it.problemNum}`);
    if (it.totalScore) bits.push(`总分：${it.totalScore} 分`);
    if (it.examUserName) bits.push(`出题：${it.examUserName}`);
    if (it.endDate) bits.push(`截止：${String(it.endDate).slice(0, 10)}`);
    if (it.startTime) bits.push(`开始：${String(it.startTime).slice(0, 10)}`);
    L.push(`*${bits.join('　·　')}*`);
    L.push('');
    // 提示与分隔线放在题目之前：若放在末尾，会被解析器并进最后一题的选项里
    L.push('> 提示：平台的选择题选项为随机排列，核对时请以选项内容为准；判断题的「对/错」顺序同样随机。');
    L.push('');
    L.push('---');
    L.push('');

    // 题型变化时插入 ### 小节标题：解析器据此判定题型
    // （只输出选项而不给标题时，解析器只能按选项特征猜，会把多选题误判成单选）
    let lastType = null;
    for (const q of qs) {
      const typeName = q.questionType?.name ?? '其他';
      if (typeName !== lastType) {
        L.push(`### ${typeName}`);
        L.push('');
        lastType = typeName;
      }

      gnum++; // 全局连续题号：跨作业不再从 1 重新开始（避免答案匹配时同号串题）
      const score = q.questionScore ? `${q.questionScore} 分` : '';
      const head = [typeName, score].filter(Boolean).join(' · ');

      // 纯 Markdown 写法（不嵌 HTML），保证任何 Markdown 渲染器都能正确显示：
      //   题干加粗 + 反引号包住题型/分值；选项作为缩进子列表挂在题目下
      L.push(`${gnum}. **${esc(clean(q.name))}**` + (head ? `　\`［${head}］\`` : ''));
      L.push('');
      const opts = q.questionOptions ?? [];
      for (const [oi, opt] of opts.entries()) {
        const label = LABELS[oi] ?? String(oi + 1);
        L.push(`   ${label}. ${esc(clean(opt.content))}`);
      }
      if (!opts.length) {
        L.push('   （本题无选项，为填空题/简答题）');
      }
      L.push('');
    }
  }
}

// ---------- 尾注 ----------
L.push('');
L.push('## 说明');
L.push('');
L.push(`- 数据来源：\`export/papers.json\`（原始接口数据，含题目 ID / 选项 ID / 题型 / 分值）`);
L.push(`- 题目总数：${totalQ} 道；作业总数：${totalHw} 份；课程：${courses.length} 门（正文编号 1–${gnum}，与目录一一对应）`);
L.push('- 本稿**不含答案**：抓取时只读取试卷内容，未作答、未提交、未消耗作答次数。');
L.push('- 打印建议：A4 纵向，页边距 18mm×16mm；浏览器打印（Ctrl+P）会自动套用文首打印样式，每门课、每份作业自动分页。');
L.push('');

const text = L.join('\n');
writeFileSync(OUT, text, 'utf8');

// 状态输出走 stderr，避免与管道缓冲打架
process.stderr.write(`saved: ${OUT}\n`);
process.stderr.write(`chars: ${text.length}\n`);
process.stderr.write(`courses: ${courses.length}  homework: ${totalHw}  questions: ${totalQ}\n`);
process.stderr.write(`types: ${typeLine}\n`);
