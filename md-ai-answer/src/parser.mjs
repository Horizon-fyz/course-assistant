/**
 * parser.mjs —— Markdown 题库解析层
 *
 * 职责单一：把「Markdown 文本」转换成「结构化题目数组」，不涉及任何网络、
 * 文件系统或 AI 调用，因此可以在 Node / 浏览器 / 安卓 WebView 中无差别复用。
 *
 * 设计约束（为了保证可合并性）：
 *   1. 全部为纯函数，无模块级可变状态，import 本模块不产生任何副作用；
 *   2. 不依赖 Node 专有 API（如 fs/path/process）；
 *   3. 输出为普通 JS 对象（可 JSON 序列化），便于跨进程/跨端传递。
 *
 * @module parser
 */

/**
 * 题目类型。
 * @typedef {'single'|'multiple'|'judge'|'blank'|'essay'} QuestionType
 */

/**
 * 单个选项。
 * @typedef {Object} QuestionOption
 * @property {string} key  选项字母，已统一为大写，如 'A'
 * @property {string} text 选项正文（已去除行内 Markdown 强调符号）
 */

/**
 * 一道结构化题目。
 * @typedef {Object} Question
 * @property {number} id                 解析后的连续序号（从 1 开始）
 * @property {string} number             原卷题号（保留字符串，避免丢前导零/非数字）
 * @property {string} section            所属小节标题，如「单选题」；无则为 ''
 * @property {QuestionType} type         推断出的题型
 * @property {string} stem               题干（多行已合并为一行）
 * @property {QuestionOption[]} options  选项列表；填空/简答为空数组
 * @property {string|null} given         原卷若已标注答案（`答案：X`），此处保留，供核对
 * @property {number} startLine          该题在源文本中的起始行号（0 基，含）
 * @property {number} endLine            该题在源文本中的结束行号（0 基，不含），用于回填
 */

/** 题型 → 中文名。渲染与提示词共用，保证两端标签一致。 */
export const TYPE_LABELS = Object.freeze({
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  blank: '填空题',
  essay: '简答题',
});

/** 行首题号：允许 `#` 标题前缀 + 数字 + 分隔符（. 、 ) ）） */
const QUESTION_START = /^\s*(?:#{1,6}\s*)?(\d+)\s*[.、)）]\s*(.*)$/;
/** 行首选项：单个字母 + 分隔符 */
const OPTION_START = /^\s*([A-Za-z])\s*[.、)）]\s*(.*)$/;
/** 纯标题行（用于识别小节名） */
const HEADING = /^\s*#{1,6}\s+(.+?)\s*$/;
/** 原卷答案行，如 `答案：A` / `参考答案: B` */
const ANSWER_LINE = /^\s*(?:参考)?答案\s*[:：]\s*(.+?)\s*$/;

/** 判断题选项判定用词 */
const TRUE_WORDS = ['正确', '对', '是', 'true', 'T', '√', '✓'];
const FALSE_WORDS = ['错误', '错', '否', 'false', 'F', '×', '✗', 'x'];

/**
 * 去掉行内 Markdown 强调/代码/引用符号，保留可读纯文本。
 * @param {string} text
 * @returns {string}
 */
function cleanInline(text) {
  return text
    .replace(/`([^`]*)`/g, '$1') // 行内代码
    .replace(/\*\*([^*]*)\*\*/g, '$1') // 加粗
    .replace(/\*([^*]*)\*/g, '$1') // 斜体
    .replace(/^\s*>\s?/, '') // 引用前缀
    .trim();
}

/**
 * 尝试把一行识别为选项。
 * @param {string} line
 * @returns {QuestionOption|null}
 */
function parseOptionLine(line) {
  const m = line.match(OPTION_START);
  if (!m) return null;
  return { key: m[1].toUpperCase(), text: cleanInline(m[2]) };
}

/**
 * 推断题型：小节标题优先，其次看选项特征。
 * @param {string} section
 * @param {QuestionOption[]} options
 * @returns {QuestionType}
 */
export function detectQuestionType(section, options) {
  const s = (section || '').replace(/\s/g, '');
  if (/多选|不定项|多项/.test(s)) return 'multiple';
  if (/判断|对错/.test(s)) return 'judge';
  if (/填空/.test(s)) return 'blank';
  if (/简答|问答|论述|名词解释/.test(s)) return 'essay';
  if (/单选|单项/.test(s)) return 'single';

  // 无小节标题时按选项特征兜底
  if (options.length === 0) return 'essay';
  if (options.length === 2) {
    const texts = options.map((o) => o.text.trim());
    if (texts.every((t) => TRUE_WORDS.includes(t) || FALSE_WORDS.includes(t))) return 'judge';
  }
  return 'single';
}

/**
 * 判断题统一成 A/B 两个选项，方便模型稳定作答。
 * @param {QuestionOption[]} options
 * @returns {QuestionOption[]}
 */
function normalizeJudgeOptions(options) {
  if (options.length >= 2) return options.slice(0, 2);
  return [
    { key: 'A', text: '正确' },
    { key: 'B', text: '错误' },
  ];
}

/**
 * 解析 Markdown 题库。
 *
 * @param {string} markdown 题库原文
 * @returns {Question[]} 结构化题目数组（已过滤空题）
 *
 * @example
 * import { parseQuestionBank } from './parser.mjs';
 * const questions = parseQuestionBank(mdText);
 */
export function parseQuestionBank(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  /** @type {Question[]} */
  const questions = [];

  let section = '';
  /** 当前正在累积的题目块 */
  let current = null;

  /**
   * 收束当前题目块，产出 Question。
   * @param {number} endLine 该块结束行号（0 基，不含）
   */
  const flush = (endLine) => {
    if (!current) return;

    const stemParts = [];
    const options = [];
    let given = null;

    for (const line of current.lines) {
      // 原卷答案行
      const ans = line.match(ANSWER_LINE);
      if (ans) {
        given = cleanInline(ans[1]);
        continue;
      }
      // 选项行：题干或已有选项出现后才认定为选项，避免误吞题干
      const opt = parseOptionLine(line);
      if (opt && (options.length > 0 || stemParts.length > 0)) {
        options.push(opt);
        continue;
      }
      // 选项延续行 → 并入上一个选项；否则并入题干
      if (options.length > 0) {
        const last = options[options.length - 1];
        last.text = `${last.text} ${cleanInline(line)}`.trim();
      } else if (line.trim() !== '') {
        stemParts.push(cleanInline(line));
      }
    }

    const type = detectQuestionType(current.section, options);
    const finalOptions = type === 'judge' ? normalizeJudgeOptions(options) : options;

    questions.push({
      id: questions.length + 1,
      number: current.number,
      section: current.section,
      type,
      stem: stemParts.join(' ').trim(),
      options: finalOptions,
      given,
      startLine: current.startLine,
      endLine,
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, '');

    // 命中新题号 → 先收束上一题
    const q = line.match(QUESTION_START);
    if (q) {
      flush(i);
      current = { number: q[1], section, startLine: i, lines: [q[2]] };
      continue;
    }

    // 命中小节标题 → 结束当前题并更新小节名
    const h = line.match(HEADING);
    if (h) {
      flush(i);
      section = cleanInline(h[1]);
      continue;
    }

    if (current) current.lines.push(line);
  }
  flush(lines.length);

  // 过滤完全没有题干的空块
  return questions.filter((x) => x.stem.length > 0);
}

/**
 * 把一道题渲染成适合放进提示词的紧凑文本。
 * 题号用全局唯一的 `q.id`（而非原卷题号 `q.number`）：同一份题库里原卷题号
 * 可能跨小节/跨试卷重复，模型回填时会串题，用 id 才能稳定对号入座。
 * @param {Question} q
 * @returns {string}
 */
export function formatQuestionForPrompt(q) {
  const typeLabel = TYPE_LABELS[q.type] || '题目';
  // 多选题额外提示一句：这类题通常不止一个正确项，避免模型只给一个字母
  const extra = q.type === 'multiple' ? '（注意：多选题通常有多个正确选项，请选出全部）' : '';
  const optionText = q.options.map((o) => `${o.key}. ${o.text}`).join('\n');
  return [`[#${q.id}] (${typeLabel})${extra}`, q.stem, optionText || '(无选项)'].join('\n');
}
