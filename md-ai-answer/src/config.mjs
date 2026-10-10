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
 * @property {string} baseUrl       AI 接口根地址
 * @property {string} apiKey        AI 接口密钥
 * @property {string} model         模型名
 * @property {number} temperature   采样温度
 * @property {number} timeoutMs     单请求超时(ms)
 * @property {number} maxRetries    失败重试次数
 * @property {number} concurrency   并发请求数
 * @property {number} batchSize     每批题目数
 * @property {string} systemPrompt  系统提示词
 */

/** 默认配置。所有字段都可被更高优先级的来源覆盖。 */
export const DEFAULT_CONFIG = Object.freeze({
  baseUrl: '',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  timeoutMs: 60000,
  maxRetries: 3,
  concurrency: 3,
  batchSize: 5,
  systemPrompt: '你是一名严谨的答题助手。仅依据题目本身与常识给出正确答案，不要编造。',
});

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
 * @returns {string[]} 缺失项说明；为空表示通过
 */
export function validateConfig(config) {
  const missing = [];
  if (!config.baseUrl) missing.push('baseUrl（AI 接口地址）');
  if (!config.apiKey) missing.push('apiKey（AI 接口密钥）');
  if (!config.model) missing.push('model（模型名）');
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
 * 从环境变量读取覆盖项（AI_BASE_URL / AI_API_KEY / AI_MODEL）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Partial<Config>}
 */
export function configFromEnv(env = process.env) {
  /** @type {Partial<Config>} */
  const out = {};
  if (env.AI_BASE_URL) out.baseUrl = env.AI_BASE_URL;
  if (env.AI_API_KEY) out.apiKey = env.AI_API_KEY;
  if (env.AI_MODEL) out.model = env.AI_MODEL;
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
  if (args['base-url']) out.baseUrl = args['base-url'];
  if (args['api-key']) out.apiKey = args['api-key'];
  if (args.model) out.model = args.model;
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
