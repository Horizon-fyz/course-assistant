/**
 * answer.mjs —— 编排层
 *
 * 职责单一：把「题目数组」编排成对 AI 的批量请求，汇总为「答案表」。
 * 不负责渲染（见 render.mjs）、不负责读写文件（见 cli.mjs）、不负责具体网络（见 ai.mjs）。
 *
 * 可合并性设计：
 *   - 通过 `client` 参数注入任意符合 AIClient 接口的对象（宿主可换模型、加缓存、做代理）；
 *   - 未注入 client 时才用 `config` 现造一个（见 ai.createClient）；
 *   - 通过 `hooks` 暴露进度/批次/错误回调，宿主可接自己的日志或 UI；
 *   - 通过 `signal` 支持整体取消。
 *
 * @module answer
 */

import { createClient, extractJson } from './ai.mjs';
import { formatQuestionForPrompt } from './parser.mjs';

/**
 * @typedef {import('./ai.mjs').AIClient} AIClient
 * @typedef {import('./parser.mjs').Question} Question
 * @typedef {import('./render.mjs').Answer} Answer
 * @typedef {Record<string, any>} Config 见 config.mjs 的 Config
 */

/**
 * @typedef {Object} Hooks 编排过程回调（全部可选）
 * @property {(loaded:number, total:number) => void} [onProgress] 每完成一批回调
 * @property {(batch:Question[], answers:Map<number,Answer>) => void} [onBatch] 每批结束回调
 * @property {(error:Error, batch:Question[]) => void} [onError] 某批失败回调（不会中断整体）
 */

/**
 * 把数组按固定大小切片。
 * @template T
 * @param {T[]} list
 * @param {number} size
 * @returns {T[][]}
 */
export function chunk(list, size) {
  const n = Math.max(1, size | 0);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * 并发池：最多 `limit` 个任务同时执行，返回结果保持输入顺序。
 * @template T, R
 * @param {T[]} items
 * @param {number} limit 并发上限
 * @param {(item:T, index:number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (cursor < items.length) {
      const i = cursor++; // 先取号再 await，天然分配任务
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/** 各题型的作答规则，用于拼系统提示词 */
const TYPE_RULES = {
  single: '单选题：只需一个正确选项字母，answer 形如 "A"。',
  judge: '判断题：answer 取 "A"（正确）或 "B"（错误）。',
  multiple: '多选题：answer 为按字母升序拼接的字符串，如 "ABD"，不要有分隔符。',
  blank: '填空题：answer 为按空位顺序用 "；" 分隔的答案文本。',
  essay: '简答题：answer 为要点式参考答案，简洁分点。',
};

/**
 * 构造一批题目的对话消息。约定模型返回 JSON 数组。
 * @param {Question[]} batch
 * @param {Config} config
 * @param {number} total 题库总题数（用于提示上下文）
 * @returns {Array<{role:string,content:string}>}
 */
export function buildMessages(batch, config, total) {
  const body = batch.map((q) => formatQuestionForPrompt(q)).join('\n\n');

  const system = [
    config?.systemPrompt || '你是一名严谨的答题助手。',
    '严格只输出一个 JSON 数组，不要输出任何解释性文字。',
    '数组中每个元素形如 {"number":"题号(方括号内的数字)","answer":"答案","reason":"简要理由(<=40字)","confidence":0-1}。',
    '题型作答规则：',
    ...Object.entries(TYPE_RULES).map(([k, v]) => `- ${k}: ${v}`),
  ].join('\n');

  const user = [
    `下面是题库中的第 ${batch[0].id}~${batch[batch.length - 1].id} 题（共 ${total} 题），请逐题给出答案：`,
    '',
    body,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 归一化模型返回的单条答案，兼容多种字段命名。
 * @param {any} item
 * @returns {Answer}
 */
export function normalizeAnswerItem(item) {
  if (item == null) return { answer: '', reason: '', confidence: null };
  if (typeof item === 'string') return { answer: item.trim(), reason: '', confidence: null };
  return {
    answer: String(item.answer ?? item.ans ?? item.answers ?? '').trim(),
    reason: String(item.reason ?? item.explain ?? item.explanation ?? '').trim(),
    confidence: typeof item.confidence === 'number' ? item.confidence : null,
  };
}

/**
 * 把对话回复（可能是数组/对象）映射回具体题目。
 * @param {Question[]} batch
 * @param {any} parsed 模型返回并已解析的对象
 * @returns {Map<number, Answer>}
 */
function matchAnswersToBatch(batch, parsed) {
  const arr = Array.isArray(parsed) ? parsed : parsed?.answers || parsed?.data || [parsed];
  // 支持按 number / id 匹配
  const byNumber = new Map();
  for (const it of arr) {
    if (it && typeof it === 'object') {
      if (it.number != null) byNumber.set(String(it.number).trim(), it);
      if (it.id != null) byNumber.set(String(it.id).trim(), it);
    }
  }

  const out = new Map();
  batch.forEach((q, idx) => {
    // 优先用全局唯一的 id 匹配（原卷题号可能重复），再退回题号/顺序
    const item = byNumber.get(String(q.id)) ?? byNumber.get(String(q.number)) ?? arr[idx];
    out.set(q.id, normalizeAnswerItem(item));
  });
  return out;
}

/**
 * 离线模拟答案，用于自测（不联网）。
 * @param {Question} q
 * @returns {Answer}
 */
export function mockAnswer(q) {
  if (q.type === 'multiple') {
    const keys = q.options.slice(0, 2).map((o) => o.key);
    return { answer: keys.join('') || 'AB', reason: 'mock', confidence: 0.5 };
  }
  if (q.type === 'judge') return { answer: 'A', reason: 'mock', confidence: 0.5 };
  if (q.type === 'single') return { answer: q.options[0]?.key || 'A', reason: 'mock', confidence: 0.5 };
  return { answer: '（mock 参考答案）', reason: 'mock', confidence: 0.3 };
}

/**
 * 核心编排：批量并发地向 AI 提问并汇总答案。
 *
 * @param {Object} params
 * @param {Question[]} params.questions 解析后的题目数组
 * @param {Config} [params.config] AI 配置；未注入 client 时必填
 * @param {AIClient} [params.client] 可注入的 AI 客户端（优先于 config）
 * @param {boolean} [params.mock] true 则离线模拟，不发起任何网络请求
 * @param {AbortSignal} [params.signal] 用于中断整个流程
 * @param {Hooks} [params.hooks] 过程回调
 * @returns {Promise<Map<number, Answer>>} key 为题目 id
 *
 * @example
 * const answers = await answerQuestions({ questions, config, hooks: { onProgress: console.log } });
 */
export async function answerQuestions({
  questions,
  config,
  client,
  mock = false,
  signal,
  hooks = {},
} = {}) {
  if (!Array.isArray(questions) || questions.length === 0) return new Map();

  // 优先使用注入的 client；否则用配置现造一个
  const aiClient = mock ? null : client || createClient(config);

  const batches = chunk(questions, config?.batchSize || 5);
  const answers = new Map();
  let done = 0;

  await mapPool(batches, config?.concurrency || 3, async (batch) => {
    if (signal?.aborted) return;

    if (mock) {
      for (const q of batch) answers.set(q.id, mockAnswer(q));
    } else {
      try {
        const content = await aiClient.chat(buildMessages(batch, config, questions.length), { signal });
        const batchAnswers = matchAnswersToBatch(batch, extractJson(content));
        for (const [id, a] of batchAnswers) answers.set(id, a);
      } catch (e) {
        // 单批失败不中断整体：登记错误答案并回调
        for (const q of batch) answers.set(q.id, { answer: '', reason: `请求失败：${e.message}`, confidence: null });
        hooks.onError?.(e, batch);
      }
    }

    done += batch.length;
    hooks.onBatch?.(batch, answers);
    hooks.onProgress?.(done, questions.length);
  });

  return answers;
}
