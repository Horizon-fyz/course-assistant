/**
 * server/index.mjs —— 本机后端服务（HTTP API + 静态托管）
 *
 * 定位：把「解析 / AI 调用 / 渲染 / 密钥」全部收进后端，前端（桌面 UI、浏览器插件、
 * 安卓）只当客户端调用 `/api/*`。核心逻辑直接复用 ../src 下的模块，不重复实现。
 *
 * 为什么同时托管静态页面：让页面与 API 同源，浏览器无需处理 CORS；
 * 桌面端（Electron）内嵌本服务后也直接加载这里的页面。
 *
 * 密钥策略：后端优先——`config.json` / 环境变量里的 apiKey 只在后端使用，绝不下发；
 * 前端仍可在请求体里带 config 覆盖（临时换模型/换key），满足“两者都支持”。
 *
 * 启动：
 *   node server/index.mjs                 # 默认 http://127.0.0.1:8787/
 *   $env:PORT=9000; node server/index.mjs
 *   $env:HOST=0.0.0.0; node server/index.mjs   # 局域网模式（谨慎）
 *
 * API：
 *   GET  /api/health                     健康检查
 *   GET  /api/config                     返回非敏感配置（不含 apiKey）
 *   POST /api/parse   { markdown }       解析题库 → questions
 *   POST /api/answer  { questions|markdown, config? }   作答 → answers（支持 SSE 进度）
 *   POST /api/render  { questions, answers, sourceText?, format?, meta? } → markdown
 */

import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseQuestionBank } from '../src/parser.mjs';
import { answerQuestions } from '../src/answer.mjs';
import { renderAnswerMarkdown, renderFilledMarkdown } from '../src/render.mjs';
import { resolveConfig, mergeConfig, validateConfig } from '../src/config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录（src/ app/ server/ 的父目录），静态资源以它为根 */
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 请求体大小上限（题库文本可能较大） */
const MAX_BODY = 32 * 1024 * 1024;

/* ------------------------------ 工具 ------------------------------ */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** 读取并解析 JSON 请求体 */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Map<id,Answer> → 可序列化对象（键为字符串 id） */
function answersToObject(map) {
  const out = {};
  for (const [id, a] of map) out[String(id)] = a;
  return out;
}

/**
 * 判断跨源请求是否可放行。仅允许「与本机后端同源」（含局域网访问的自身地址）、
 * 本机回环地址，以及将来的浏览器扩展（chrome-extension:// / moz-extension://）。
 * 目的是挡住任意网站借本机后端盗用已配置的 apiKey。
 * @param {string|undefined} origin
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function isAllowedOrigin(origin, req) {
  if (!origin) return true; // 非浏览器客户端（curl / 命令行）不带 Origin
  if (/^(chrome|moz)-extension:\/\//i.test(origin)) return true; // 将来的插件
  try {
    const o = new URL(origin);
    if ((req.headers.host || '') === o.host) return true; // 与后端同源
    if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(o.hostname)) return true;
  } catch {
    /* 非法 Origin */
  }
  return false;
}

/** 可序列化对象 → Map<id,Answer> */
function objectToAnswers(obj) {
  return new Map(Object.entries(obj || {}).map(([k, v]) => [Number(k), v]));
}

/* ------------------------------ 业务处理 ------------------------------ */

/** GET /api/health */
function handleHealth(res, ctx) {
  sendJson(res, 200, { ok: true, hasApiKey: Boolean(ctx.serverConfig.apiKey), model: ctx.serverConfig.model });
}

/** GET /api/config —— 只返回非敏感字段，供前端预填 */
function handleGetConfig(res, ctx) {
  const c = ctx.serverConfig;
  sendJson(res, 200, {
    ok: true,
    config: {
      baseUrl: c.baseUrl,
      model: c.model,
      concurrency: c.concurrency,
      batchSize: c.batchSize,
      hasApiKey: Boolean(c.apiKey), // 只告知“是否已配置”，不下发密钥
    },
  });
}

/** POST /api/parse */
async function handleParse(req, res) {
  const body = await readJsonBody(req);
  const markdown = String(body.markdown || '');
  if (!markdown.trim()) return sendJson(res, 400, { ok: false, error: '缺少 markdown' });
  const questions = parseQuestionBank(markdown);
  sendJson(res, 200, { ok: true, questions });
}

/**
 * POST /api/answer
 * body: { questions? , markdown? , config? , mock? }
 * 当请求头 Accept 含 text/event-stream（或 ?stream=1）时，用 SSE 推送进度。
 */
async function handleAnswer(req, res, ctx, url) {
  const body = await readJsonBody(req);

  let questions = body.questions;
  if (!questions && body.markdown) questions = parseQuestionBank(String(body.markdown));
  if (!Array.isArray(questions) || questions.length === 0) {
    return sendJson(res, 400, { ok: false, error: '缺少 questions 或 markdown' });
  }

  // 后端配置为底，前端传入的 config 覆盖（含可选的 apiKey）
  const config = mergeConfig(ctx.serverConfig, body.config);
  const mock = Boolean(body.mock);

  if (!mock) {
    const missing = validateConfig(config);
    if (missing.length) {
      return sendJson(res, 400, { ok: false, error: `配置不完整，缺少：${missing.join('、')}` });
    }
  }

  const wantsSSE =
    url.searchParams.get('stream') === '1' || String(req.headers.accept || '').includes('text/event-stream');

  // 客户端断开连接时真正取消后端的 AI 请求（避免后台继续跑、继续计费）
  const ac = new AbortController();
  req.on('close', () => ac.abort());

  // —— 普通 JSON 模式 ——
  if (!wantsSSE) {
    const answers = await answerQuestions({ questions, config, mock, signal: ac.signal });
    return sendJson(res, 200, { ok: true, answers: answersToObject(answers) });
  }

  // —— SSE 模式：实时推送进度 ——
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  try {
    const answers = await answerQuestions({
      questions,
      config,
      mock,
      signal: ac.signal,
      hooks: {
        onProgress: (loaded, total) => !closed && send('progress', { loaded, total }),
        onError: (err, batch) =>
          !closed && send('error', { message: err.message, numbers: batch.map((q) => q.number) }),
      },
    });
    if (!closed) send('done', { answers: answersToObject(answers) });
  } catch (e) {
    if (!closed) send('error', { message: e.message });
  } finally {
    if (!closed && !res.writableEnded) res.end();
  }
}

/** POST /api/render */
async function handleRender(req, res) {
  const body = await readJsonBody(req);
  const questions = body.questions;
  if (!Array.isArray(questions)) return sendJson(res, 400, { ok: false, error: '缺少 questions' });

  const answers = objectToAnswers(body.answers);
  const markdown =
    body.format === 'filled'
      ? renderFilledMarkdown({ sourceText: String(body.sourceText || ''), questions, answers })
      : renderAnswerMarkdown({ questions, answers, meta: body.meta || {} });

  sendJson(res, 200, { ok: true, markdown });
}

/* ------------------------------ 静态资源 ------------------------------ */

async function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad Request');
    return;
  }
  if (rel === '/') rel = '/app/index.html';
  if (rel.endsWith('/')) rel += 'index.html';

  const filePath = path.normalize(path.join(ROOT, rel));
  // 必须严格落在项目根目录内：用分隔符判定，避免 “md-ai-answer-x” 之类同前缀目录绕过
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: `${rel.replace(/\/?$/, '/')}index.html` }).end();
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

/* ------------------------------ 服务器 ------------------------------ */

/**
 * 创建（但不启动）后端服务。
 * @param {{host?:string, port?:number, configFile?:string}} [opts]
 * @returns {{ start:()=>Promise<{port:number,host:string}>, stop:()=>Promise<void>, config:object }}
 */
export function createServer(opts = {}) {
  const host = opts.host || process.env.HOST || '127.0.0.1';
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const configFile = opts.configFile || process.env.MDAI_CONFIG || path.join(ROOT, 'config.json');

  /** 启动时解析一次后端配置（含 apiKey），此后只在后端使用 */
  let serverConfig = null;

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // CORS/来源校验：仅放行同源、本机回环与浏览器扩展来源，
    // 挡住任意网站借本机后端盗用已配置的 apiKey（不改动同源页面的正常使用）。
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden origin');
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    try {
      if (url.pathname === '/api/health' && req.method === 'GET') return handleHealth(res, { serverConfig });
      if (url.pathname === '/api/config' && req.method === 'GET') return handleGetConfig(res, { serverConfig });
      if (url.pathname === '/api/parse' && req.method === 'POST') return await handleParse(req, res);
      if (url.pathname === '/api/answer' && req.method === 'POST')
        return await handleAnswer(req, res, { serverConfig }, url);
      if (url.pathname === '/api/render' && req.method === 'POST') return await handleRender(req, res);

      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: '未知接口' });
      return await serveStatic(req, res, url);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
      else res.end();
    }
  };

  const server = http.createServer(handler);

  return {
    async start() {
      serverConfig = await resolveConfig({ configFile });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      const addr = server.address();
      return { port: addr.port, host: addr.address };
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
    get config() {
      return serverConfig;
    },
  };
}

/* 直接运行时启动服务（被 import 时无副作用） */
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const app = createServer();
  app.start().then(({ host, port }) => {
    console.log(`后端服务已启动: http://${host === '::' ? '127.0.0.1' : host}:${port}/app/`);
    console.log(`接口示例: GET /api/health  POST /api/parse  POST /api/answer  POST /api/render`);
  });
}
