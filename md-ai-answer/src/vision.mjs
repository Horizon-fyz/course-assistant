/**
 * vision.mjs —— 视觉识题层（截图 → 题目 + 答案）
 *
 * 两阶段分工（千问只识别、DeepSeek 只思考）：
 *   1. 识别：把截图交给识别模型（通义千问 VL），只提取题干/题型/选项，不作答；
 *   2. 思考：把识别出的题目文本交给思考模型（DeepSeek），依据题目推理出答案。
 *
 * 与 answer.mjs 的关系：answer.mjs 处理「已经有结构化文本」的题目（其提示词被本模块复用），
 * vision.mjs 负责把「一张屏幕截图」先转成结构化文本，再走思考阶段。
 *
 * 只依赖 ai.mjs 的 OpenAI 兼容客户端，因此任何支持多模态 `image_url` 的服务都能当识别模型
 * （通义千问 qwen-vl、GPT-4o、Claude 兼容网关、本地多模态模型等），任何文本模型都能当思考模型。
 *
 * @module vision
 */

import { createClient, extractJson } from './ai.mjs';
import { buildMessages, normalizeAnswerItem } from './answer.mjs';
import { pickVision, pickReason } from './config.mjs';

/** 视觉识别的系统提示词：只做「识别」，把截图里的题干/题型/选项原样提取，**不作答**。 */
export const RECOGNIZE_SYSTEM_PROMPT = [
  '你是一个严谨的题目识别助手。用户会给你一张屏幕截图，截图里可能包含一道或多道题目，',
  '也可能是课程页面、视频页面等与题目无关的内容。',
  '',
  '请只做「识别」，**不要作答**：把截图里所有题目的题干、题型、选项原样提取出来。',
  '',
  '严格只输出一个 JSON 对象，不要输出任何解释文字、不要用 Markdown 代码块包裹，格式：',
  '{"questions":[{"stem":"题干原文","type":"single","options":[{"key":"A","text":"选项原文"}]}]}',
  '',
  '字段要求：',
  '- type：单选题 single、多选题 multiple、判断题 judge、填空题 blank、简答题 essay；',
  '- options：选择题必须给出全部可见选项（key 依次为 A/B/C…）；判断题给 [{"key":"A","text":"正确"},{"key":"B","text":"错误"}]；',
  '  填空 / 简答题给空数组 []；',
  '- 不要输出 answer / reason 等答案字段；',
  '- 忠实还原原文，看不清就照录，**不要臆测、不要补全、不要作答**；',
  '- 截图里没有题目时，返回 {"questions":[]}。',
].join('\n');

/**
 * 构造多模态识图消息（OpenAI 兼容格式：content 为数组）。
 * @param {string} imageDataUrl 形如 `data:image/jpeg;base64,....`
 * @returns {Array<object>}
 */
export function buildVisionMessages(imageDataUrl) {
  return [
    { role: 'system', content: RECOGNIZE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: '请识别这张截图里的题目（题干、题型、选项），只输出 JSON，不要作答。' },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ];
}

/** 把模型给的题型收敛到内部枚举 */
export function normalizeType(t) {
  const s = String(t || '').toLowerCase();
  if (/multi|多选|不定项/.test(s)) return 'multiple';
  if (/judge|判断|对错/.test(s)) return 'judge';
  if (/blank|fill|填空/.test(s)) return 'blank';
  if (/essay|answer|简答|问答|论述/.test(s)) return 'essay';
  return 'single';
}

/** 把识别模型返回的一条题目整理成内部统一结构；无题干则返回 null */
function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stem = String(raw.stem || '').replace(/\s+/g, ' ').trim();
  if (!stem) return null;

  const type = normalizeType(raw.type);
  const options = Array.isArray(raw.options)
    ? raw.options
        .map((o, i) => ({
          key: String((o && o.key) || '').replace(/[.\s、)）]/g, '') || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i] || String(i + 1),
          text: String((o && o.text) || (typeof o === 'string' ? o : '')).replace(/\s+/g, ' ').trim(),
        }))
        .filter((o) => o.text || o.key)
    : [];

  return { stem, type, options };
}

/**
 * 阶段一（识别）：把截图交给识别模型（通义千问 VL），只取题干/题型/选项，不含答案。
 * @returns {Promise<Array<{stem:string,type:string,options:object[]}>>}
 */
export async function recognizeQuestions({ imageDataUrl, client, signal }) {
  const text = await client.chat(buildVisionMessages(imageDataUrl), { signal, temperature: 0.1 });
  const parsed = extractJson(text);
  const list = Array.isArray(parsed) ? parsed : parsed && parsed.questions;
  if (!Array.isArray(list)) return [];
  return list.map(normalizeQuestion).filter(Boolean);
}

/**
 * 阶段二（思考）：把识别出的题目文本交给思考模型（DeepSeek），依据题目推理出答案。
 * @returns {Promise<Array<{stem:string,type:string,options:object[],answer:string,reason:string}>>}
 */
export async function reasonAnswers({ questions, config, client, signal }) {
  if (!questions.length) return questions;
  // 转成 answer.mjs 认识的 Question 形状（批量作答只需 id/number/type/stem/options）
  const asQuestions = questions.map((q, i) => ({
    id: i + 1,
    number: String(i + 1),
    type: q.type,
    stem: q.stem,
    options: q.options || [],
  }));
  const content = await client.chat(buildMessages(asQuestions, config, asQuestions.length), { signal });
  const parsed = extractJson(content);
  const arr = Array.isArray(parsed) ? parsed : (parsed && (parsed.answers || parsed.data)) || [parsed];
  const byNumber = new Map();
  for (const it of arr) {
    if (it && typeof it === 'object' && it.number != null) byNumber.set(String(it.number).trim(), it);
  }
  return questions.map((q, i) => {
    const item = byNumber.get(String(i + 1)) || arr[i];
    const a = normalizeAnswerItem(item);
    return { ...q, answer: a.answer, reason: a.reason };
  });
}

/**
 * 识别一张截图并作答：先由识别模型（通义千问 VL）识图，再由思考模型（DeepSeek）推理答案。
 * @param {{imageDataUrl:string, config:object, client?:object, reasonClient?:object, signal?:AbortSignal}} opts
 * @returns {Promise<Array<{stem:string,type:string,options:object[],answer:string,reason:string}>>}
 */
export async function recognizeImage({ imageDataUrl, config, client, reasonClient, signal }) {
  if (!imageDataUrl) throw new Error('缺少截图数据');
  const visionClient = client || createClient(pickVision(config));
  const recognized = await recognizeQuestions({ imageDataUrl, client: visionClient, signal });
  if (!recognized.length) return [];
  const reasonCli = reasonClient || createClient(pickReason(config));
  return reasonAnswers({ questions: recognized, config, client: reasonCli, signal });
}
