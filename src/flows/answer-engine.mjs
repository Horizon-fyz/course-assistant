// answer-engine.mjs —— 作答匹配引擎（纯逻辑，无浏览器、无网络）
//
// 职责：把「算好的答案（题库）」或「现场问 AI」映射成「页面上该点第几个选项」。
// 为什么需要它：平台的选项顺序每次刷新都随机，字母（A/B/C）不能直接拿来点，
// 必须把答案换算成选项正文再去页面上按正文（或选项 id）定位。
//
// 两种答案来源（可组合）：
//   1) 题库：solve 产出的 <题库>.answers.json，按「题干归一化」匹配，再按选项正文匹配；
//   2) AI  ：现场读页面题干+选项，直接让模型按页面上的字母作答。
//
// @module answer-engine

import { extractJson } from '../../md-ai-answer/src/ai.mjs';

/** 判断题：视为「正确」的选项文本（比较前会做轻量归一） */
export const TRUE_WORDS = ['正确', '对', '对的', '是', '是的', 'true', 't', '√', '✓', 'v'];
/** 判断题：视为「错误」的选项文本 */
export const FALSE_WORDS = ['错误', '错', '错的', '不对', '否', '不是', 'false', 'f', '×', '✗', 'x'];

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** 题型 → 中文名（与 md-ai-answer 的 TYPE_LABELS 对齐） */
export const TYPE_LABELS = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  blank: '填空题',
  essay: '简答题',
};

/**
 * 题干/选项归一化：去 HTML、统一全半角、去空白、去标点、转小写。
 * 目的：让「题库文本」与「页面文本」在格式差异下仍能相等。
 * 只保留 Unicode 字母与数字（中文属 \p{L}，会被保留）。
 * @param {string} s
 * @returns {string}
 */
export function normalize(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 判断题选项语义判定。
 * @param {string} text
 * @returns {'true'|'false'|null}
 */
export function judgeValue(text) {
  const t = String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/[\s\u3000.。、，,；;：:]/g, '').toLowerCase();
  if (!t) return null;
  if (TRUE_WORDS.includes(t)) return 'true';
  if (FALSE_WORDS.includes(t)) return 'false';
  // 兜底：包含关系（如「正确（√）」）
  if (TRUE_WORDS.some((w) => w.length > 1 && t.includes(w))) return 'true';
  if (FALSE_WORDS.some((w) => w.length > 1 && t.includes(w))) return 'false';
  return null;
}

/**
 * 从答案字母串提取选项序号（0 基）。非法字母会被忽略。
 * @param {string} letters 形如 "ABD"
 * @param {number} optionCount 选项总数，用于过滤越界
 * @returns {number[]}
 */
export function lettersToIndexes(letters, optionCount) {
  const out = [];
  for (const ch of String(letters || '').toUpperCase()) {
    const i = LABELS.indexOf(ch);
    if (i >= 0 && i < optionCount && !out.includes(i)) out.push(i);
  }
  return out;
}

/**
 * 用 solve 的结构化答案建立索引：归一化题干 → 条目。
 * @param {{questions: Array<any>}} answersJson
 * @returns {{byStem: Map<string, any>, count: number}}
 */
export function indexFromAnswersJson(answersJson) {
  const byStem = new Map();
  const list = answersJson?.questions || [];
  for (const q of list) {
    const key = normalize(q.stem);
    if (!key) continue;
    if (!byStem.has(key)) byStem.set(key, q);
  }
  return { byStem, count: list.length };
}

/**
 * 把题库条目换算成「页面选项序号」。
 * @param {any} entry 题库条目（含 options[{key,text}] 与 answer）
 * @param {LiveQuestion} live 页面上的题目
 * @returns {{ok:boolean, indexes:number[], unmatched:string[], note:string}}
 */
function resolveFromBank(entry, live) {
  const letters = String(entry.answer || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!letters) return { ok: false, indexes: [], unmatched: [], note: '题库该题无答案' };

  const liveIsJudge = isJudge(live);
  const bankIsJudge = entry.type === 'judge' || isJudgeTexts(entry.options?.map((o) => o.text) || []);

  // —— 判断题：走语义（正确/错误），绕开「对/错」顺序随机 ——
  if (liveIsJudge || bankIsJudge) {
    const wanted = new Set();
    for (const ch of letters) {
      const opt = (entry.options || []).find((o) => String(o.key).toUpperCase() === ch);
      const v = judgeValue(opt?.text ?? '');
      if (v) wanted.add(v);
    }
    if (!wanted.size) return { ok: false, indexes: [], unmatched: [], note: '判断题答案无法判定语义' };
    const indexes = [];
    const unmatched = [];
    for (const v of wanted) {
      const idx = live.options.findIndex((o) => judgeValue(o.text) === v);
      if (idx >= 0) indexes.push(idx); else unmatched.push(v === 'true' ? '正确' : '错误');
    }
    return { ok: unmatched.length === 0, indexes: indexes.sort((a, b) => a - b), unmatched, note: '判断题语义匹配' };
  }

  // —— 选择/多选：按选项正文匹配 ——
  const wantedTexts = [];
  for (const ch of letters) {
    const opt = (entry.options || []).find((o) => String(o.key).toUpperCase() === ch);
    if (opt) wantedTexts.push(opt.text);
  }
  const indexes = [];
  const unmatched = [];
  for (const t of wantedTexts) {
    const n = normalize(t);
    const idx = live.options.findIndex((o) => normalize(o.text) === n);
    if (idx >= 0) { if (!indexes.includes(idx)) indexes.push(idx); } else unmatched.push(String(t).slice(0, 40));
  }
  return { ok: unmatched.length === 0 && indexes.length > 0, indexes: indexes.sort((a, b) => a - b), unmatched, note: '选项正文匹配' };
}

function isJudgeTexts(texts) {
  if (texts.length !== 2) return false;
  return texts.every((t) => judgeValue(t) !== null);
}

/**
 * @typedef {Object} LiveQuestion
 * @property {string} stem 题干
 * @property {'single'|'multiple'|'judge'|'blank'|'essay'|string} type
 * @property {Array<{index:number, letter?:string, id?:string|null, text:string, selector?:string}>} options
 */

/** 判断一道题是否判断题 */
export function isJudge(live) {
  if (live?.type === 'judge') return true;
  const opts = live?.options || [];
  return opts.length === 2 && opts.every((o) => judgeValue(o.text) !== null);
}

/**
 * 用题库解析页面题目。失败返回 ok:false，由调用方决定是否转 AI。
 * @param {LiveQuestion} live
 * @param {{byStem: Map<string, any>}} index
 * @returns {{ok:boolean, indexes:number[], source:string, note:string, unmatched:string[]}}
 */
export function resolveFromIndex(live, index) {
  const key = normalize(live?.stem);
  if (!key) return { ok: false, indexes: [], source: 'bank', note: '页面题干为空', unmatched: [] };
  const entry = index?.byStem?.get(key);
  if (!entry) return { ok: false, indexes: [], source: 'bank', note: '题库未命中（题干不一致）', unmatched: [] };
  const r = resolveFromBank(entry, live);
  return { ok: r.ok, indexes: r.indexes, source: 'bank', note: r.note + (r.unmatched.length ? `；未匹配选项 ${r.unmatched.length} 个` : ''), unmatched: r.unmatched };
}

/**
 * 为「页面上的单道题」构造 AI 提示词。选项字母按页面顺序给出，
 * 模型返回的字母可直接对应页面选项，无需再做文本匹配。
 * @param {LiveQuestion} live
 * @returns {Array<{role:string,content:string}>}
 */
export function buildLivePrompt(live) {
  const typeLabel = TYPE_LABELS[live?.type] || '题目';
  const opts = (live?.options || [])
    .map((o, i) => `${o.letter || LABELS[i]}. ${String(o.text || '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  const system = [
    '你是一名严谨的答题助手。',
    '严格只输出一个 JSON 数组，不要输出任何解释性文字。',
    '数组只含一个元素，形如 {"answer":"答案","reason":"简要理由(<=40字)","confidence":0-1}。',
    '规则：单选题 answer 为一个字母；多选题 answer 为按字母升序拼接的字符串（如 "ABD"）；判断题 answer 为 "A" 或 "B"。',
  ].join('\n');
  const user = [`[#1] (${typeLabel})`, live?.stem || '', opts || '(无选项)'].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 解析 AI 回复为页面选项序号。
 * @param {string} content 模型回复原文
 * @param {number} optionCount
 * @param {Array<{text?:string, content?:string}>|null} options 页面选项（判断题答「正确/错误」时用来定位）
 * @returns {{ok:boolean, indexes:number[], raw:string, note:string, confidence:number|null, reason:string}}
 */
export function parseAiAnswer(content, optionCount, options = null) {
  let parsed;
  try { parsed = extractJson(content); } catch (e) {
    return { ok: false, indexes: [], raw: '', note: 'JSON 解析失败：' + e.message, confidence: null, reason: '' };
  }
  const item = Array.isArray(parsed) ? parsed[0] : (parsed?.answers?.[0] ?? parsed);
  const raw = String(item?.answer ?? item?.ans ?? '').trim();
  let indexes = lettersToIndexes(raw, optionCount);
  // 模型偶尔不按约定给字母，而是直接答「正确/错误」：两选项题按语义兜底
  if (!indexes.length && Array.isArray(options) && options.length === 2) {
    const v = judgeValue(raw);
    if (v) {
      const i = options.findIndex((o) => judgeValue(o?.text ?? o?.content ?? '') === v);
      if (i >= 0) indexes = [i];
    }
  }
  // 模型自报的置信度（0~1）：缺失或非法时记 null，由调用方决定怎么用
  const confRaw = Number(item?.confidence ?? item?.conf);
  const confidence = Number.isFinite(confRaw) ? Math.min(1, Math.max(0, confRaw)) : null;
  const reason = String(item?.reason ?? item?.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { ok: indexes.length > 0, indexes, raw, note: indexes.length ? 'AI 作答' : 'AI 未给出有效字母', confidence, reason };
}

/**
 * 判断两组选项序号是否完全相同（用于交叉验证）。
 * @param {number[]} a
 * @param {number[]} b
 * @returns {boolean}
 */
export function sameIndexes(a, b) {
  const x = [...new Set(a || [])].sort((p, q) => p - q);
  const y = [...new Set(b || [])].sort((p, q) => p - q);
  return x.length > 0 && x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * 统一入口：先查题库，未命中可选转 AI。
 * @param {LiveQuestion} live
 * @param {Object} opts
 * @param {{byStem: Map<string, any>}|null} [opts.index] 题库索引
 * @param {(live:LiveQuestion)=>Promise<string>} [opts.ask] AI 回调（返回模型回复原文）
 * @returns {Promise<{ok:boolean, indexes:number[], source:'bank'|'ai'|'none', note:string}>}
 */
export async function resolveAnswer(live, { index = null, ask = null } = {}) {
  if (index && index.byStem?.size) {
    const r = resolveFromIndex(live, index);
    if (r.ok) return { ok: true, indexes: r.indexes, source: 'bank', note: r.note };
  }
  if (ask) {
    try {
      const content = await ask(live);
      const a = parseAiAnswer(content, live.options?.length || 0, live.options);
      return { ok: a.ok, indexes: a.indexes, source: 'ai', note: a.note };
    } catch (e) {
      return { ok: false, indexes: [], source: 'none', note: 'AI 调用失败：' + String(e).slice(0, 80) };
    }
  }
  return { ok: false, indexes: [], source: 'none', note: '题库未命中，且未启用 AI 兜底' };
}
