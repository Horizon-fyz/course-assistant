/**
 * render.mjs —— 结果渲染层
 *
 * 职责单一：把「题目 + 答案」渲染成 Markdown 文本。纯函数，不读写文件，
 * 宿主可自行决定把结果写到磁盘、塞进 DOM，还是通过接口回传。
 *
 * @module render
 */

import { TYPE_LABELS } from './parser.mjs';

/**
 * @typedef {Object} Answer
 * @property {string} answer            答案文本（选择题为字母，如 'A' / 'ABD'）
 * @property {string} [reason]          简要理由/解析
 * @property {number|null} [confidence] 置信度 0~1，未知为 null
 */

/**
 * 格式化本地时间，形如 `2026-10-10 16:12:19`。
 * @param {Date} [d]
 * @returns {string}
 */
function formatTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 生成独立的「答案汇总」Markdown。
 * 结构：标题信息 → 答案速查 → 逐题详解（按小节分组）。
 *
 * @param {Object} params
 * @param {import('./parser.mjs').Question[]} params.questions
 * @param {Map<number, Answer>} params.answers   key 为题目的 id
 * @param {{source?:string, model?:string, generatedAt?:Date}} [params.meta]
 * @returns {string} Markdown 文本
 */
export function renderAnswerMarkdown({ questions, answers, meta = {} }) {
  const lines = [];
  lines.push('# 答案汇总');
  lines.push('');
  lines.push(
    `> 题库：${meta.source || '-'}　模型：${meta.model || '-'}　生成时间：${formatTime(meta.generatedAt)}　共 ${questions.length} 题`,
  );
  lines.push('');

  // —— 答案速查区：一行看完全部答案 ——
  lines.push('## 答案速查');
  lines.push('');
  lines.push(questions.map((q) => `${q.number}.${answers.get(q.id)?.answer || '?'}`).join('　'));
  lines.push('');

  // —— 逐题详解区：按小节分组 ——
  lines.push('## 逐题详解');
  lines.push('');
  let lastSection = null;
  for (const q of questions) {
    if (q.section && q.section !== lastSection) {
      lines.push(`### ${q.section}`);
      lines.push('');
      lastSection = q.section;
    }
    const a = answers.get(q.id) || {};
    const type = TYPE_LABELS[q.type] || '';
    const conf = typeof a.confidence === 'number' ? `（置信度 ${a.confidence}）` : '';

    lines.push(`**${q.number}. ${q.stem}**${type ? ` _(${type})_` : ''}`);
    lines.push('');
    if (q.options.length) {
      for (const o of q.options) lines.push(`- ${o.key}. ${o.text}`);
      lines.push('');
    }
    lines.push(`- 答案：**${a.answer || '（未作答）'}**${conf}`);
    if (a.reason) lines.push(`- 解析：${a.reason}`);
    if (q.given) lines.push(`- 原卷标注：${q.given}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 在原题库文本中「回填」答案，生成带答案的题库副本。
 * 借助 Question.startLine/endLine 定位，从后往前插入以避免行号漂移。
 *
 * @param {Object} params
 * @param {string} params.sourceText 原始题库文本
 * @param {import('./parser.mjs').Question[]} params.questions
 * @param {Map<number, Answer>} params.answers
 * @returns {string} 回填后的 Markdown 文本
 */
export function renderFilledMarkdown({ sourceText, questions, answers }) {
  const lines = String(sourceText).replace(/\r\n?/g, '\n').split('\n');

  // 从后往前处理，保证前面的行号不受插入影响
  const sorted = [...questions].sort((a, b) => b.endLine - a.endLine);
  for (const q of sorted) {
    // 把插入点回退到该题最后一行非空内容之后
    let insertAt = q.endLine;
    while (insertAt > q.startLine && lines[insertAt - 1].trim() === '') insertAt--;

    const a = answers.get(q.id) || {};
    const reason = a.reason ? `　解析：${a.reason}` : '';
    lines.splice(insertAt, 0, `> **答案：${a.answer || '（未作答）'}**${reason}`);
  }
  return lines.join('\n');
}
