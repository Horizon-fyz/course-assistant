/**
 * ai-presets.js —— OpenAI 兼容厂商预设
 *
 * 所有厂商都走同一套协议：POST {baseUrl}/chat/completions + Authorization: Bearer <apiKey>。
 * 这里只维护「厂商名 / 兼容地址 / 常用模型 ID」，模型输入框仍可自由改写，
 * 因此不在列表里的厂商或模型也能用（选「自定义」即可）。
 */

export const CUSTOM_PROVIDER_ID = 'custom';

/**
 * @typedef {Object} AIProvider
 * @property {string} id
 * @property {string} name
 * @property {string} baseUrl
 * @property {boolean} vision           是否提供视觉（图片理解）模型
 * @property {string[]} visionModels
 * @property {boolean} reason           是否提供文本 / 推理模型
 * @property {string[]} reasonModels
 * @property {string} [note]
 */

/** @type {AIProvider[]} */
export const AI_PROVIDERS = [
  {
    id: 'dashscope',
    name: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    vision: true,
    visionModels: ['qwen3-vl-plus', 'qwen3-vl-flash', 'qwen-vl-max', 'qwen-vl-plus', 'qwen2.5-vl-72b-instruct'],
    reason: true,
    reasonModels: ['qwen3-max', 'qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen3-235b-a22b'],
    note: '使用 DashScope 的 OpenAI 兼容模式。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    vision: false,
    visionModels: [],
    reason: true,
    reasonModels: ['deepseek-reasoner', 'deepseek-chat'],
    note: 'deepseek-reasoner 先推理再作答，适合作为思考模型。',
  },
  {
    id: 'zhipu',
    name: '智谱 AI（GLM）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    vision: true,
    visionModels: ['glm-4.5v', 'glm-4v-plus', 'glm-4v-flash'],
    reason: true,
    reasonModels: ['glm-4.6', 'glm-4.5', 'glm-4-plus', 'glm-4-flash'],
  },
  {
    id: 'moonshot',
    name: '月之暗面（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    vision: true,
    visionModels: ['kimi-latest', 'moonshot-v1-8k-vision-preview', 'moonshot-v1-32k-vision-preview', 'moonshot-v1-128k-vision-preview'],
    reason: true,
    reasonModels: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'kimi-latest', 'moonshot-v1-32k'],
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    vision: true,
    visionModels: ['Qwen/Qwen2.5-VL-72B-Instruct', 'Qwen/Qwen2.5-VL-32B-Instruct', 'THUDM/GLM-4.1V-9B-Thinking'],
    reason: true,
    reasonModels: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'Qwen/Qwen3-235B-A22B'],
    note: '模型名需带组织前缀，例如 Qwen/Qwen2.5-VL-72B-Instruct。',
  },
  {
    id: 'volcengine',
    name: '火山方舟（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    vision: true,
    visionModels: ['doubao-seed-1-6-vision-250815', 'doubao-1-5-vision-pro-32k-250115'],
    reason: true,
    reasonModels: ['doubao-seed-1-6-250615', 'doubao-1-5-pro-32k-250115', 'deepseek-v3-250324'],
    note: '模型名可填官方模型 ID，或方舟控制台创建的推理接入点 ID（ep-...）。',
  },
  {
    id: 'hunyuan',
    name: '腾讯混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    vision: true,
    visionModels: ['hunyuan-vision'],
    reason: true,
    reasonModels: ['hunyuan-t1-latest', 'hunyuan-turbos-latest', 'hunyuan-pro', 'hunyuan-standard'],
  },
  {
    id: 'qianfan',
    name: '百度千帆（文心一言）',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    vision: true,
    visionModels: ['ernie-4.5-turbo-vl-32k', 'ernie-4.5-turbo-vl'],
    reason: true,
    reasonModels: ['ernie-4.5-turbo-128k', 'ernie-4.5-8k-preview', 'ernie-x1-turbo-32k'],
    note: '千帆 v2 接口使用 Bearer 鉴权；模型需先在千帆控制台开通。',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    vision: true,
    visionModels: ['MiniMax-VL-01'],
    reason: true,
    reasonModels: ['MiniMax-M1', 'MiniMax-Text-01'],
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    vision: true,
    visionModels: ['step-1o-turbo-vision', 'step-1v-8k', 'step-1v-32k'],
    reason: true,
    reasonModels: ['step-2-16k', 'step-1o-turbo'],
  },
  {
    id: 'lingyiwanwu',
    name: '零一万物（Yi）',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    vision: true,
    visionModels: ['yi-vision-v2', 'yi-vision'],
    reason: true,
    reasonModels: ['yi-lightning', 'yi-large', 'yi-medium'],
  },
  {
    id: 'spark',
    name: '讯飞星火',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    vision: false,
    visionModels: [],
    reason: true,
    reasonModels: ['4.0Ultra', 'generalv3.5', 'max-32k', 'lite'],
    note: '星火 OpenAI 兼容接口仅用于文本模型。',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    vision: true,
    visionModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    reason: true,
    reasonModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini', 'o3-mini'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    vision: true,
    visionModels: ['openai/gpt-4o', 'google/gemini-2.5-flash', 'anthropic/claude-sonnet-4', 'qwen/qwen2.5-vl-72b-instruct'],
    reason: true,
    reasonModels: ['openai/gpt-4.1', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-pro', 'deepseek/deepseek-r1'],
    note: '聚合平台，模型名需带厂商前缀；部分模型需先在控制台开通。',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    vision: true,
    visionModels: ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.2-11b-vision-preview'],
    reason: true,
    reasonModels: ['llama-3.3-70b-versatile', 'deepseek-r1-distill-llama-70b', 'qwen/qwen3-32b'],
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    vision: true,
    visionModels: ['qwen2.5vl:7b', 'qwen2.5vl:32b', 'llama3.2-vision:11b', 'llava:latest'],
    reason: true,
    reasonModels: ['qwen3:8b', 'deepseek-r1:8b', 'llama3.1:8b'],
    note: '本机需先 ollama pull 模型，模型名要与本地一致。',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    vision: true,
    visionModels: [],
    reason: true,
    reasonModels: [],
    note: '模型名填 LM Studio 中已加载模型的标识。',
  },
  {
    id: 'vllm',
    name: 'vLLM / 其它本地服务',
    baseUrl: 'http://127.0.0.1:8000/v1',
    vision: true,
    visionModels: [],
    reason: true,
    reasonModels: [],
    note: '模型名填服务端 --served-model-name 指定的名称。',
  },
];

/** 取某个通道（vision / reason）可用的厂商 */
export function providersFor(channel) {
  return AI_PROVIDERS.filter((p) => (channel === 'vision' ? p.vision : p.reason));
}

/** 去掉末尾斜杠与误粘贴的 /chat/completions，便于比较与调用 */
export function normalizeBaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
}

/** 按已保存的 baseUrl 反查厂商；找不到返回 null（视为自定义） */
export function findProviderByBaseUrl(url, channel) {
  const target = normalizeBaseUrl(url).toLowerCase();
  if (!target) return null;
  return providersFor(channel).find((p) => normalizeBaseUrl(p.baseUrl).toLowerCase() === target) || null;
}
