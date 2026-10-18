/**
 * config.mjs —— 配置层
 *
 * 拆成两部分，兼顾「可移植」与「开箱即用」：
 *   - 纯函数部分（DEFAULT_CONFIG / mergeConfig）：无环境依赖，浏览器/安卓可复用；
 *   - Node 便捷部分（readConfigFile / applyEnv / resolveConfig）：读取本地文件与环境变量，
 *     仅命令行外壳使用，宿主程序可不用。
 *
 * @module config
 */

/**
 * @typedef {Object} Config
 * @property {string} visionBaseUrl 识别模型接口根地址（通义千问 VL）
 * @property {string} visionApiKey  识别模型密钥
 * @property {string} visionModel   识别模型名
 * @property {string} reasonBaseUrl 思考模型接口根地址（DeepSeek）
 * @property {string} reasonApiKey  思考模型密钥
 * @property {string} reasonModel   思考模型名
 * @property {number} temperature   采样温度
 * @property {number} timeoutMs     单请求超时(ms)
 * @property {number} maxRetries    失败重试次数
 * @property {number} concurrency   并发请求数
 * @property {number} batchSize     每批题目数
 * @property {string} systemPrompt  系统提示词（思考阶段使用）
 */

/**
 * 默认配置。所有字段都可被更高优先级的来源覆盖。
 * 两套模型分工：识别模型（通义千问 VL）只看图、识别题干与选项；思考模型（DeepSeek）只依据文本推理答案。
 */
export const DEFAULT_CONFIG = Object.freeze({
  visionBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  visionApiKey: '',
  visionModel: 'qwen3-vl-plus',
  reasonBaseUrl: 'https://api.deepseek.com/v1',
  reasonApiKey: '',
  reasonModel: 'deepseek-reasoner',
  temperature: 0.2,
  timeoutMs: 60000,
  maxRetries: 3,
  concurrency: 3,
  batchSize: 5,
  systemPrompt: '你是一名严谨的答题助手。仅依据题目本身与常识给出正确答案，不要编造。',
});

/**
 * 取出「识别模型（通义千问）」的调用参数，兼容旧版扁平配置（baseUrl/apiKey/model）。
 * @param {Partial<Config>} config
 * @returns {{baseUrl:string, apiKey:string, model:string}}
 */
export function pickVision(config) {
  const c = config || {};
  return {
    baseUrl: c.visionBaseUrl || c.baseUrl || '',
    apiKey: c.visionApiKey || c.apiKey || '',
    model: c.visionModel || c.model || 'qwen3-vl-plus',
  };
}

/**
 * 取出「思考模型（DeepSeek）」的调用参数。
 * @param {Partial<Config>} config
 * @returns {{baseUrl:string, apiKey:string, model:string}}
 */
export function pickReason(config) {
  const c = config || {};
  return {
    baseUrl: c.reasonBaseUrl || '',
    apiKey: c.reasonApiKey || '',
    model: c.reasonModel || 'deepseek-reasoner',
  };
}

/**
 * 合并多份配置，后者覆盖前者；忽略 undefined，保留 0 / '' 等有效值。
 * @param {...(Partial<Config>|undefined|null)} sources
 * @returns {Config}
 */
export function mergeConfig(...sources) {
  const out = { ...DEFAULT_CONFIG };
  for (const src of sources) {
    if (!src) continue;
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
  }
  return out;
}

/**
 * 校验配置是否可用于真实调用（mock 模式下无需调用）。
 * @param {Config} config
 * @param {{needVision?:boolean, needReason?:boolean}} [opts] 默认两者都校验；
 *        离线批量作答（/api/answer）只需思考模型，可传 { needVision:false }。
 * @returns {string[]} 缺失项说明；为空表示通过
 */
export function validateConfig(config, opts = {}) {
  const needVision = opts.needVision !== false;
  const needReason = opts.needReason !== false;
  const missing = [];
  if (needVision) {
    const v = pickVision(config);
    if (!v.baseUrl) missing.push('识别模型 baseUrl（通义千问）');
    if (!v.apiKey) missing.push('识别模型 apiKey（通义千问）');
    if (!v.model) missing.push('识别模型 model（通义千问）');
  }
  if (needReason) {
    const r = pickReason(config);
    if (!r.baseUrl) missing.push('思考模型 baseUrl（DeepSeek）');
    if (!r.apiKey) missing.push('思考模型 apiKey（DeepSeek）');
    if (!r.model) missing.push('思考模型 model（DeepSeek）');
  }
  return missing;
}

/* ------------------------------------------------------------------ *
 * 以下为 Node 环境专用便捷函数。宿主若在浏览器/安卓运行，可忽略。
 * ------------------------------------------------------------------ */

/**
 * 读取 JSON 配置文件；文件不存在返回 null。
 * @param {string} filePath
 * @returns {Promise<Partial<Config>|null>}
 */
export async function readConfigFile(filePath) {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  if (!existsSync(filePath)) return null;
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/**
 * 从环境变量读取覆盖项。
 * 识别模型：AI_VISION_BASE_URL / AI_VISION_API_KEY / AI_VISION_MODEL（旧名 AI_BASE_URL 等作为兼容）；
 * 思考模型：AI_REASON_BASE_URL / AI_REASON_API_KEY / AI_REASON_MODEL。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Partial<Config>}
 */
export function configFromEnv(env = process.env) {
  /** @type {Partial<Config>} */
  const out = {};
  if (env.AI_VISION_BASE_URL || env.AI_BASE_URL) out.visionBaseUrl = env.AI_VISION_BASE_URL || env.AI_BASE_URL;
  if (env.AI_VISION_API_KEY || env.AI_API_KEY) out.visionApiKey = env.AI_VISION_API_KEY || env.AI_API_KEY;
  if (env.AI_VISION_MODEL || env.AI_MODEL) out.visionModel = env.AI_VISION_MODEL || env.AI_MODEL;
  if (env.AI_REASON_BASE_URL) out.reasonBaseUrl = env.AI_REASON_BASE_URL;
  if (env.AI_REASON_API_KEY) out.reasonApiKey = env.AI_REASON_API_KEY;
  if (env.AI_REASON_MODEL) out.reasonModel = env.AI_REASON_MODEL;
  return out;
}

/**
 * 解析命令行参数 → 配置覆盖对象。
 * @param {Record<string, any>} args cli.mjs 解析出的参数对象
 * @returns {Partial<Config>}
 */
export function configFromArgs(args = {}) {
  /** @type {Partial<Config>} */
  const out = {};
  if (args['vision-base-url'] || args['base-url']) out.visionBaseUrl = args['vision-base-url'] || args['base-url'];
  if (args['vision-api-key'] || args['api-key']) out.visionApiKey = args['vision-api-key'] || args['api-key'];
  if (args['vision-model'] || args.model) out.visionModel = args['vision-model'] || args.model;
  if (args['reason-base-url']) out.reasonBaseUrl = args['reason-base-url'];
  if (args['reason-api-key']) out.reasonApiKey = args['reason-api-key'];
  if (args['reason-model']) out.reasonModel = args['reason-model'];
  if (args.concurrency) out.concurrency = Number(args.concurrency);
  if (args['batch-size']) out.batchSize = Number(args['batch-size']);
  return out;
}

/**
 * 按「默认 < 配置文件 < 环境变量 < 命令行」的优先级合成最终配置。
 * @param {{configFile?:string, args?:Record<string,any>, env?:NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<Config>}
 */
export async function resolveConfig({ configFile = 'config.json', args = {}, env = process.env } = {}) {
  const fileCfg = await readConfigFile(configFile);
  return mergeConfig(fileCfg || undefined, configFromEnv(env), configFromArgs(args));
}
