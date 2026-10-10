/**
 * hud.mjs —— 悬浮窗的「识别 + 作答」核心
 *
 * 职责：把「一张屏幕截图」或「一段页面文本」交给 AI，拿回结构化的题目与答案。
 * 纯逻辑，不碰 Electron、不碰文件系统（截图由 Electron 主进程负责）。
 *
 * 定位说明（重要）：
 *   本模块只做「读题 + 给答案」供人核对，**不点击、不填写、不提交**任何页面元素。
 *
 * @module hud
 */
import { createClient, extractJson } from './ai.mjs';

/** 让模型返回固定结构的指令 */
const SYSTEM = `你是一个题目识别与作答助手。你会收到一张屏幕截图或一段页面文本，其中可能包含一道或多道正在显示的题目。
要求：
1. 找出「当前正在作答的那一道题」（若有多道，取最靠上、最完整的一道）。
2. 严格只输出一个 JSON 对象，不要任何解释文字。
3. JSON 结构：
   {"found":true,"type":"单选题|多选题|判断题|填空题|简答题","stem":"题干原文","options":[{"key":"A","text":"选项原文"}],"answer":"答案","reason":"简要解析(<=60字)","confidence":0.0-1.0,"note":""}
4. 作答规则：
   - 单选题：answer 为单个字母，如 "A"
   - 多选题：answer 为字母升序拼接，如 "ABD"，不要分隔符
   - 判断题：answer 取 "A"（正确）或 "B"（错误）
   - 填空题：answer 为按空位顺序用 "；" 分隔的文本
   - 简答题：answer 为要点式参考答案
5. 图中/文本中没有题目时，返回 {"found":false,"note":"未发现题目"}。
6. 题干与选项必须**原样抄录**，不要改写、不要翻译；抄不全就在 note 里说明。`;

/**
 * 把模型的回复规范化为统一结构。
 * @param {any} obj
 * @returns {{found:boolean,type:string,stem:string,options:Array<{key:string,text:string}>,answer:string,reason:string,confidence:number|null,note:string}}
 */
export function normalizeResult(obj) {
  const o = obj && typeof obj === 'object' ? obj : {};
  const options = Array.isArray(o.options)
    ? o.options
        .map((x) => (typeof x === 'string'
          ? { key: '', text: x }
          : { key: String(x?.key ?? x?.label ?? '').trim(), text: String(x?.text ?? x?.content ?? '').trim() }))
        .filter((x) => x.text)
    : [];
  return {
    found: o.found !== false && Boolean(o.stem || options.length),
    type: String(o.type ?? '').trim(),
    stem: String(o.stem ?? '').trim(),
    options,
    answer: String(o.answer ?? o.ans ?? '').trim(),
    reason: String(o.reason ?? o.explain ?? o.explanation ?? '').trim(),
    confidence: typeof o.confidence === 'number' ? o.confidence : null,
    note: String(o.note ?? '').trim(),
  };
}

/**
 * 用文字（页面可见文本）识别并作答。
 * @param {{text:string, config:object, client?:object, signal?:AbortSignal}} p
 */
export async function askFromText({ text, config, client, signal }) {
  const ai = client || createClient(config);
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `以下是页面可见文本，请找出题目并作答：\n\n${String(text).slice(0, 6000)}` },
  ];
  const content = await ai.chat(messages, { signal });
  return normalizeResult(extractJson(content));
}

/**
 * 用截图（多模态）识别并作答。
 * @param {{imageBase64:string, mime?:string, hint?:string, config:object, client?:object, signal?:AbortSignal}} p
 */
export async function askFromImage({ imageBase64, mime = 'image/png', hint = '', config, client, signal }) {
  const ai = client || createClient(config);
  const messages = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: hubPromptText(hint) },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } },
      ],
    },
  ];
  const content = await ai.chat(messages, { signal });
  return normalizeResult(extractJson(content));
}

/** 截图模式的用户提示词 */
function hubPromptText(hint) {
  return [
    '这是一张电脑屏幕截图，里面可能有正在作答的题目。',
    hint ? `补充信息：${hint}` : '',
    '请按系统要求找出题目并作答，只输出 JSON。',
  ].filter(Boolean).join('\n');
}
