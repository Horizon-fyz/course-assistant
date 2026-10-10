/**
 * index.mjs —— 公共 API 聚合出口
 *
 * 宿主程序推荐只从这里 import：
 *   import { parseQuestionBank, answerQuestions, createClient, renderAnswerMarkdown } from 'md-ai-answer';
 *
 * 各子模块也可单独按需引入（见 package.json 的 exports 映射），以获得更小的打包体积。
 *
 * 典型数据流：
 *   Markdown 文本
 *     ──parseQuestionBank──▶ Question[]
 *     ──answerQuestions───▶ Map<id, Answer>   (内部经 createClient 调 AI)
 *     ──renderAnswerMarkdown / renderFilledMarkdown──▶ Markdown 文本
 *
 * @module md-ai-answer
 */

// —— 解析层 ——
export {
  parseQuestionBank,
  formatQuestionForPrompt,
  detectQuestionType,
  TYPE_LABELS,
} from './parser.mjs';

// —— AI 调用层 ——
export { createClient, extractJson, AIRequestError } from './ai.mjs';

// —— 编排层 ——
export {
  answerQuestions,
  buildMessages,
  normalizeAnswerItem,
  mockAnswer,
  chunk,
  mapPool,
} from './answer.mjs';

// —— 渲染层 ——
export { renderAnswerMarkdown, renderFilledMarkdown } from './render.mjs';

// —— 配置层 ——
export {
  DEFAULT_CONFIG,
  mergeConfig,
  validateConfig,
  readConfigFile,
  configFromEnv,
  configFromArgs,
  resolveConfig,
} from './config.mjs';
