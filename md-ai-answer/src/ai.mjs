/**
 * ai.mjs —— AI 调用层
 *
 * 职责单一：封装「OpenAI 兼容的 Chat Completions」调用细节（鉴权、超时、重试、
 * 回复解析），对外只暴露一个稳定的 `AIClient` 接口，方便宿主程序替换/注入。
 *
 * 兼容服务：DeepSeek、通义千问(兼容模式)、硅基流动、OpenAI、本地 Ollama 等，
 * 只要提供 `POST {baseUrl}/chat/completions` 即可。
 *
 * 可合并性设计：
 *   - `createClient` 是工厂函数，无模块级状态；
 *   - 允许注入自定义 `fetch`（例如宿主用自己的网络层、需要走代理、或做单元测试）；
 *   - 只依赖标准 `fetch` / `AbortController`，浏览器与 Node18+ 均可用。
 *
 * @module ai
 */

/** 简易延迟工具 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * AI 调用错误，携带 HTTP 状态码，便于宿主区分可重试与不可重试。
 */
export class AIRequestError extends Error {
  /**
   * @param {string} message
   * @param {number} [status] HTTP 状态码；网络层错误时为 0
   */
  constructor(message, status = 0) {
    super(message);
    this.name = 'AIRequestError';
    this.status = status;
  }
}

/**
 * @typedef {Object} AIClient
 * @property {(messages: Array<{role:string,content:string}>, opts?: object) => Promise<string>} chat
 *   发送消息，返回模型回复的原始文本。
 * @property {(messages: Array<{role:string,content:string}>, opts?: object) => Promise<any>} chatJson
 *   发送消息并把回复解析为 JSON。
 * @property {string} model 当前模型名（只读）。
 */

/**
 * @typedef {Object} AIConfig
 * @property {string} baseUrl      接口根地址，需以 /v1 结尾（不含 /chat/completions）
 * @property {string} apiKey       接口密钥
 * @property {string} [model]      模型名，默认 gpt-4o-mini
 * @property {number} [temperature] 采样温度，默认 0.2
 * @property {number} [timeoutMs]  单次请求超时，默认 60000
 * @property {number} [maxRetries] 失败重试次数，默认 3
 */

/**
 * 创建 AI 客户端。
 *
 * @param {AIConfig} config
 * @param {{ fetch?: typeof globalThis.fetch }} [deps] 依赖注入；不传则用全局 fetch
 * @returns {AIClient}
 *
 * @example
 * const client = createClient({ baseUrl, apiKey, model });
 * const text = await client.chat([{ role: 'user', content: '你好' }]);
 */
export function createClient(config, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const apiKey = config.apiKey || '';
  const model = config.model || 'gpt-4o-mini';
  const timeoutMs = config.timeoutMs ?? 60000;
  const maxRetries = config.maxRetries ?? 3;

  if (!baseUrl) throw new Error('缺少 baseUrl（AI 接口地址）');
  if (!apiKey) throw new Error('缺少 apiKey（AI 接口密钥）');
  if (typeof fetchImpl !== 'function') throw new Error('运行环境缺少 fetch，请通过 deps.fetch 注入');

  /**
   * 单次请求（不含重试）。
   * @param {Array<{role:string,content:string}>} messages
   * @param {{temperature?:number, signal?:AbortSignal}} [opts]
   * @returns {Promise<string>}
   */
  async function chatOnce(messages, opts = {}) {
    // 组合「超时」与「外部取消」两个信号
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? config.temperature ?? 0.2,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new AIRequestError(`AI 接口返回 ${res.status}: ${body.slice(0, 500)}`, res.status);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new AIRequestError('AI 接口返回内容为空');
      return content;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * 带指数退避重试的请求。仅对「超时 / 429 / 5xx / 网络错误」重试。
   * @param {Array<{role:string,content:string}>} messages
   * @param {{temperature?:number, signal?:AbortSignal}} [opts]
   * @returns {Promise<string>}
   */
  async function chat(messages, opts = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await chatOnce(messages, opts);
      } catch (e) {
        lastErr = e;
        const retriable =
          e.name === 'AbortError' ||
          e.status === 429 ||
          (e.status >= 500 && e.status < 600) ||
          e.status === 0;
        if (opts.signal?.aborted || !retriable || attempt === maxRetries) break;
        await sleep(Math.min(1000 * 2 ** attempt, 15000));
      }
    }
    throw lastErr;
  }

  /**
   * 请求并解析 JSON。
   * @param {Array<{role:string,content:string}>} messages
   * @param {object} [opts]
   * @returns {Promise<any>}
   */
  async function chatJson(messages, opts = {}) {
    return extractJson(await chat(messages, opts));
  }

  return { chat, chatJson, model };
}

/**
 * 从模型回复中稳健地提取 JSON。
 * 容忍三种常见情况：纯 JSON、被 ```json 代码块包裹、JSON 前后夹带说明文字。
 *
 * @param {string} text
 * @returns {any}
 * @throws {Error} 无法解析时抛出
 */
export function extractJson(text) {
  let t = String(text).trim();

  // 1) 优先取代码块内容
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  // 2) 直接尝试
  try {
    return JSON.parse(t);
  } catch {
    /* 继续尝试截取 */
  }

  // 3) 截取第一段花括号/方括号内容
  const start = t.search(/[[{]/);
  if (start >= 0) {
    const open = t[start];
    const close = open === '[' ? ']' : '}';
    const end = t.lastIndexOf(close);
    if (end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        /* 忽略 */
      }
    }
  }
  throw new Error(`无法从模型回复中解析 JSON：${t.slice(0, 300)}`);
}
