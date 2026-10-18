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
   * @param {boolean|null} [retryable] 显式指定是否可重试；null 表示按状态码判断
   */
  constructor(message, status = 0, retryable = null) {
    super(message);
    this.name = 'AIRequestError';
    this.status = status;
    this.retryable = retryable;
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
 * @property {string} baseUrl      接口根地址（如 https://api.deepseek.com/v1），不含 /chat/completions；
 *                                 误粘贴完整端点也会自动剥离
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
  const baseUrl = String(config.baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/, '');
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
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

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
      if (!content) throw new AIRequestError('AI 接口返回内容为空', 0, false);
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
        // fetch 的网络层错误（ECONNRESET / 断网 / DNS 失败）是 TypeError，没有 status，
        // 旧逻辑只认 status===0，导致这类错误一次都不重试。
        const retriable = e.retryable === false ? false : (
          e.name === 'AbortError' ||
          e.status === 429 ||
          (e.status >= 500 && e.status < 600) ||
          e.status == null ||
          e.status === 0
        );
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
 * 从 start 处的 `[` / `{` 开始，按括号配对截出完整的 JSON 文本。
 * 必须跳过字符串内部与转义字符，否则题干里的 `]` / `}` 会提前截断；
 * 也不能用 lastIndexOf —— 回复末尾的其它括号会把范围拉出第一个 JSON 值。
 * @param {string} text
 * @param {number} start
 * @returns {string|null}
 */
function sliceBalanced(text, start) {
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 依次尝试文本里每个 `[` / `{` 起点，返回第一个能解析成功的值 */
function parseFirstJsonValue(text) {
  const re = /[[{]/g;
  let m;
  while ((m = re.exec(text))) {
    const slice = sliceBalanced(text, m.index);
    if (!slice) continue;
    try {
      return { found: true, value: JSON.parse(slice) };
    } catch {
      /* 这个起点不是合法 JSON，继续找下一个 */
    }
  }
  return { found: false, value: undefined };
}

/**
 * 从模型回复中稳健地提取 JSON。
 * 容忍四种常见情况：纯 JSON、被 ```json 代码块包裹、JSON 前后夹带说明文字、
 * 回复里有多段代码块（只取第一个能解析出 JSON 的）。
 *
 * @param {string} text
 * @returns {any}
 * @throws {Error} 无法解析时抛出
 */
export function extractJson(text) {
  const raw = String(text).trim();

  // 1) 代码块可能有多个，逐个尝试；纯文本作为最后的兜底
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());

  for (const candidate of [...fences, raw]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* 继续找 JSON 片段 */
    }
    const parsed = parseFirstJsonValue(candidate);
    if (parsed.found) return parsed.value;
  }

  throw new Error(`无法从模型回复中解析 JSON：${raw.slice(0, 300)}`);
}
