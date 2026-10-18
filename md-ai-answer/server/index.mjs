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
 *   POST /api/vision  { image, config? } 截图 → 千问识别题干 + DeepSeek 推理答案（题库命中优先，未命中写回题库）
 *   POST /api/vision/extract { image, config? }        仅千问提取题干/题型/选项（不作答）
 *   POST /api/vision/reason  { questions, config? }    题库命中优先 + DeepSeek 推理答案并写回题库
 *   GET  /api/capture/last              最近一次截屏的原始 JPG
 *   GET  /api/bank                       题库统计
 *   POST /api/bank    { clear:true }     清空题库
 *   POST /api/render  { questions, answers, sourceText?, format?, meta? } → markdown
 */

import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseQuestionBank } from '../src/parser.mjs';
import { answerQuestions } from '../src/answer.mjs';
import { recognizeImage, recognizeQuestions, reasonAnswers } from '../src/vision.mjs';
import { createClient } from '../src/ai.mjs';
import { loadBank, saveBank, updateBank, matchBank, upsertBank, bankCount, emptyBank, isCompleteQuestion } from '../src/bank.mjs';
import { renderAnswerMarkdown, renderFilledMarkdown } from '../src/render.mjs';
import { resolveConfig, mergeConfig, validateConfig, pickVision, pickReason } from '../src/config.mjs';

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

/** Host 头（可带端口）是否指向本机回环地址 */
function isLoopbackHost(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return false;
  const hostname = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || h === '::1';
}

/**
 * 判断跨源请求是否可放行。仅允许「与本机后端同源」（含局域网访问的自身地址）、
 * 本机回环地址，以及将来的浏览器扩展（chrome-extension:// / moz-extension://）。
 * 目的是挡住任意网站借本机后端盗用已配置的 apiKey。
 *
 * 注意 Host 头校验：攻击者把自己的域名解析到 127.0.0.1（DNS rebinding）时，
 * 浏览器发出的 Host 仍是 evil.com，只校验 Origin 会被绕过，因此这里先要求
 * Host 本身是回环地址（局域网模式除外）。
 * @param {string|undefined} origin
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} [allowLan] 是否允许非回环 Host（需显式开启）
 * @returns {boolean}
 */
function isAllowedOrigin(origin, req, allowLan = false) {
  const host = String(req.headers.host || '');
  const hostIsLoopback = isLoopbackHost(host);
  if (!hostIsLoopback && !allowLan) return false;
  if (!origin) return true; // 非浏览器客户端（curl / 命令行）不带 Origin
  if (/^(chrome|moz)-extension:\/\//i.test(origin)) return true; // 将来的插件
  try {
    const o = new URL(origin);
    if (host && o.host.toLowerCase() === host.toLowerCase()) return true; // 与后端同源
    if (hostIsLoopback && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(o.hostname)) return true;
  } catch {
    /* 非法 Origin */
  }
  return false;
}

/** 去掉 URL 中的 userinfo（https://user:pass@host/v1 → https://host/v1），避免把凭据下发给前端 */
function stripUserinfo(value) {
  if (!value) return value;
  try {
    const u = new URL(value);
    if (!u.username && !u.password) return value;
    return `${u.origin}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  } catch {
    return value;
  }
}

/**
 * 合并服务端配置与前端请求体的覆盖项。
 * 安全约束：请求体若换掉 baseUrl 却没带对应的 apiKey，服务端已保存的密钥就会被
 * 发往请求体指定的地址。这种「只换地址不换密钥」的覆盖一律丢弃。
 */
function mergeRequestConfig(serverConfig, bodyConfig) {
  const base = serverConfig || {};
  if (!bodyConfig || typeof bodyConfig !== 'object') return mergeConfig(base);
  const override = { ...bodyConfig };
  const has = (k) => typeof override[k] === 'string' && override[k].trim() !== '';
  if (has('visionBaseUrl') && !has('visionApiKey')) delete override.visionBaseUrl;
  if (has('reasonBaseUrl') && !has('reasonApiKey')) delete override.reasonBaseUrl;
  // 旧版扁平键同时作用于两个模型，必须自带 apiKey 才允许覆盖地址
  if (has('baseUrl') && !has('apiKey') && !has('visionApiKey') && !has('reasonApiKey')) delete override.baseUrl;
  return mergeConfig(base, override);
}

/** 非回环地址需要显式开启，防止 HOST=0.0.0.0 把后端连同密钥暴露到局域网 */
function resolveBindHost(host) {
  const h = host || '127.0.0.1';
  if (isLoopbackHost(h)) return h;
  if (process.env.MDAI_ALLOW_LAN === '1') return h;
  console.warn(`[安全] 拒绝绑定非回环地址 ${h}；如确需局域网访问，请设置 MDAI_ALLOW_LAN=1`);
  return '127.0.0.1';
}

/** 可序列化对象 → Map<id,Answer> */
function objectToAnswers(obj) {
  return new Map(Object.entries(obj || {}).map(([k, v]) => [Number(k), v]));
}

/* ------------------------------ 业务处理 ------------------------------ */

/** GET /api/health */
function handleHealth(res, ctx) {
  const c = ctx.serverConfig || {};
  sendJson(res, 200, {
    ok: true,
    hasVisionApiKey: Boolean(pickVision(c).apiKey),
    hasReasonApiKey: Boolean(pickReason(c).apiKey),
    visionModel: pickVision(c).model,
    reasonModel: pickReason(c).model,
  });
}

/** GET /api/config —— 只返回非敏感字段，供前端预填 */
function handleGetConfig(res, ctx) {
  const c = ctx.serverConfig;
  const v = pickVision(c);
  const r = pickReason(c);
  sendJson(res, 200, {
    ok: true,
    config: {
      visionBaseUrl: stripUserinfo(v.baseUrl),
      visionModel: v.model,
      reasonBaseUrl: stripUserinfo(r.baseUrl),
      reasonModel: r.model,
      concurrency: c.concurrency,
      batchSize: c.batchSize,
      hasVisionApiKey: Boolean(v.apiKey), // 只告知“是否已配置”，不下发密钥
      hasReasonApiKey: Boolean(r.apiKey),
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
  const config = mergeRequestConfig(ctx.serverConfig, body.config);
  const mock = Boolean(body.mock);

  if (!mock) {
    // 离线批量作答只走思考模型（DeepSeek），无需校验识别模型
    const missing = validateConfig(config, { needVision: false });
    if (missing.length) {
      return sendJson(res, 400, { ok: false, error: `配置不完整，缺少：${missing.join('、')}` });
    }
  }

  const wantsSSE =
    url.searchParams.get('stream') === '1' || String(req.headers.accept || '').includes('text/event-stream');

  // 客户端断开连接时真正取消后端的 AI 请求（避免后台继续跑、继续计费）。
  // 必须挂在 res 上：req 的 'close' 在请求体读完后就会触发（Node 语义），
  // 挂 req 会导致 AI 请求刚发出就被取消。
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

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
  res.on('close', () => {
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

/**
 * POST /api/vision
 * body: { image: "data:image/jpeg;base64,...", config? }
 * 用视觉模型识别截图里的题目并作答；命中本地题库的直接复用答案（source=bank），
 * 未命中的用 AI 的答案并写回题库（source=ai）。
 */
async function handleVision(req, res, ctx) {
  const body = await readJsonBody(req);
  const image = String(body.image || '');
  if (!image.startsWith('data:image/')) {
    return sendJson(res, 400, { ok: false, error: '缺少截图数据（image 需为 data:image/... 的 base64）' });
  }

  const config = mergeRequestConfig(ctx.serverConfig, body.config);
  const missing = validateConfig(config);
  if (missing.length) {
    return sendJson(res, 400, { ok: false, error: `配置不完整，缺少：${missing.join('、')}` });
  }

  // 客户端断开时取消 AI 请求（挂 res，原因见 handleAnswer）
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const questions = await recognizeImage({ imageDataUrl: image, config, signal: ac.signal });

  // 题库的「读 → 改 → 写」放在 updateBank 的串行队列里，
  // 三个接口并发命中时不会互相覆盖（后写覆盖先写会丢更新）
  const out = [];
  let count = 0;
  try {
    await updateBank(ctx.bankFile, (bank) => {
      for (const q of questions) {
        const hit = matchBank(bank, q.stem, q);
        if (hit) {
          // 题库命中：直接用题库答案，AI 的答案只作为兜底
          out.push({
            ...q,
            answer: String(hit.entry.answer || '').trim() || q.answer,
            reason: String(hit.entry.reason || '').trim() || q.reason,
            source: 'bank',
          });
          hit.entry.hits = (hit.entry.hits || 0) + 1;
          hit.entry.updatedAt = Date.now();
        } else {
          out.push({ ...q, source: 'ai' });
          // 只在「AI 给出答案」且识别结果完整时才写回题库，
          // 避免把残缺识别（题干过短 / 选项不全）固化成脏记录
          if (q.answer && isCompleteQuestion(q)) upsertBank(bank, q);
        }
      }
      count = bankCount(bank);
    });
  } catch {
    // 题库写失败不影响本次作答
    if (!out.length) for (const q of questions) out.push({ ...q, source: 'ai' });
  }

  sendJson(res, 200, { ok: true, questions: out, bankCount: count });
}

/**
 * POST /api/vision/extract
 * body: { image: "data:image/jpeg;base64,...", config? }
 * 只做「提取」：把截图交给识别模型（通义千问 VL），提取题干/题型/选项，**不作答**。
 * 这是「截屏 → 提取 → 输出」流水线的第二步，供悬浮窗逐步展示。
 */
async function handleVisionExtract(req, res, ctx) {
  const body = await readJsonBody(req);
  const image = String(body.image || '');
  if (!image.startsWith('data:image/')) {
    return sendJson(res, 400, { ok: false, error: '缺少截图数据（image 需为 data:image/... 的 base64）' });
  }

  const config = mergeRequestConfig(ctx.serverConfig, body.config);
  const missing = validateConfig(config, { needReason: false }); // 提取阶段只需识别模型
  if (missing.length) {
    return sendJson(res, 400, { ok: false, error: `配置不完整，缺少：${missing.join('、')}` });
  }

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const client = createClient(pickVision(config));
  const questions = await recognizeQuestions({ imageDataUrl: image, client, signal: ac.signal });
  sendJson(res, 200, { ok: true, questions });
}

/**
 * POST /api/vision/reason
 * body: { questions: [{stem,type,options}...], config? }
 * 只做「输出」：先命中本地题库（source=bank），未命中的交给思考模型（DeepSeek）推理答案
 * 并写回题库（source=ai）。这是「截屏 → 提取 → 输出」流水线的第三步。
 */
async function handleVisionReason(req, res, ctx) {
  const body = await readJsonBody(req);
  const questions = Array.isArray(body.questions) ? body.questions : null;
  if (!questions) return sendJson(res, 400, { ok: false, error: '缺少 questions（应为提取阶段返回的题目数组）' });

  const config = mergeRequestConfig(ctx.serverConfig, body.config);
  const missing = validateConfig(config, { needVision: false }); // 思考阶段只走思考模型
  if (missing.length) {
    return sendJson(res, 400, { ok: false, error: `配置不完整，缺少：${missing.join('、')}` });
  }

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const bank = await loadBank(ctx.bankFile);
  const out = new Array(questions.length);
  const pending = []; // 未命中题库、需要 DeepSeek 推理的题目
  const hits = []; // 命中题库的题目，稍后在事务里累加 hits
  const aiWrites = []; // AI 推理出的完整题目，稍后在事务里写回题库

  // 题库命中优先：命中的直接复用题库答案，不再调用 AI
  questions.forEach((q, i) => {
    const hit = q && q.stem ? matchBank(bank, q.stem, q) : null;
    if (hit) {
      out[i] = {
        ...q,
        answer: String(hit.entry.answer || '').trim() || q.answer || '',
        reason: String(hit.entry.reason || '').trim() || q.reason || '',
        source: 'bank',
      };
      hits.push(q);
    } else {
      pending.push({ idx: i, q });
    }
  });

  if (pending.length) {
    const client = createClient(pickReason(config));
    const reasoned = await reasonAnswers({
      questions: pending.map((p) => p.q),
      config,
      client,
      signal: ac.signal,
    });
    pending.forEach((p, j) => {
      const r = reasoned[j] || {};
      const item = { ...p.q, answer: r.answer || '', reason: r.reason || '', source: 'ai' };
      out[p.idx] = item;
      // 只在「AI 给出答案」且识别结果完整时才写回题库，避免固化残缺记录
      if (item.answer && isCompleteQuestion(item)) aiWrites.push(item);
    });
  }

  let count = bankCount(bank);
  if (hits.length || aiWrites.length) {
    // 题库的「读 → 改 → 写」放在 updateBank 的串行队列里，避免并发请求互相覆盖
    try {
      await updateBank(ctx.bankFile, (latest) => {
        for (const q of hits) {
          const hit = matchBank(latest, q.stem, q);
          if (!hit) continue;
          hit.entry.hits = (hit.entry.hits || 0) + 1;
          hit.entry.updatedAt = Date.now();
        }
        for (const item of aiWrites) upsertBank(latest, item);
        count = bankCount(latest);
      });
    } catch { /* 题库写失败不影响本次作答 */ }
  }

  sendJson(res, 200, { ok: true, questions: out, bankCount: count });
}

/** GET /api/capture/last —— 返回最近一次截屏的原始 JPG，供悬浮窗步骤面板展示 */
async function handleCaptureLast(res, ctx) {
  const file = path.join(ctx.dataDir, 'last-capture.jpg');
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'cache-control': 'no-store',
      'content-length': data.length,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

/** GET /api/bank —— 题库统计；POST /api/bank { clear:true } —— 清空题库 */
async function handleBank(req, res, ctx) {
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body && body.clear) {
      await saveBank(ctx.bankFile, emptyBank());
      return sendJson(res, 200, { ok: true, count: 0, bankFile: ctx.bankFile });
    }
  }
  const bank = await loadBank(ctx.bankFile);
  sendJson(res, 200, { ok: true, count: bankCount(bank), bankFile: ctx.bankFile });
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

/**
 * 静态托管拒绝清单。staticRoot 默认指向组件根目录，若不加限制，
 * 浏览器可直接下载 config.json（内含 apiKey）、源码与依赖。
 */
const STATIC_DENY_FILES = new Set([
  'config.json',
  'config.example.json',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const STATIC_DENY_DIRS = new Set([
  'src',
  'server',
  'electron',
  'node_modules',
  '.git',
  'data',
  'recon',
  'tools',
]);

/** 路径是否落在拒绝清单内（命中目录名、敏感文件名或以点开头的隐藏项） */
function isDeniedStaticPath(relPath) {
  const segments = relPath.split(/[\\/]+/).filter(Boolean).map((s) => s.toLowerCase());
  return segments.some(
    (s) => s.startsWith('.') || STATIC_DENY_DIRS.has(s) || STATIC_DENY_FILES.has(s),
  );
}

async function serveStatic(req, res, url, staticRoot = ROOT) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad Request');
    return;
  }
  if (rel === '/') rel = '/app/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  if (isDeniedStaticPath(rel)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }

  const filePath = path.normalize(path.join(staticRoot, rel));
  // 必须严格落在静态根目录内：用分隔符判定，避免 “md-ai-answer-x” 之类同前缀目录绕过
  if (filePath !== staticRoot && !filePath.startsWith(staticRoot + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      res.writeHead(302, { Location: `${rel.replace(/\/?$/, '/')}index.html` }).end();
      return;
    }
    // 协商缓存：ETag 用「大小 + 修改时间」生成，不需要读文件内容；
    // 命中 304 时直接返回，省掉一次磁盘读取（重复打开面板/刷新页面时收益明显）。
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // no-cache 不是不缓存，而是每次先协商：本地文件随时可能被更新，避免了强缓存导致的旧页面
      'cache-control': 'no-cache',
      etag,
      'last-modified': info.mtime.toUTCString(),
    };
    const inm = req.headers['if-none-match'];
    if (inm) {
      if (String(inm).split(',').some((v) => v.trim() === etag)) {
        res.writeHead(304, headers).end();
        return;
      }
    } else {
      const ims = req.headers['if-modified-since'];
      const since = ims ? Date.parse(ims) : NaN;
      if (Number.isFinite(since) && Math.floor(info.mtimeMs / 1000) * 1000 <= since) {
        res.writeHead(304, headers).end();
        return;
      }
    }
    const data = await readFile(filePath);
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
  }
}

/* ------------------------------ 服务器 ------------------------------ */

/**
 * 创建（但不启动）后端服务。
 * @param {{host?:string, port?:number, configFile?:string, staticRoot?:string, dataDir?:string}} [opts]
 * @returns {{ start:()=>Promise<{port:number,host:string}>, stop:()=>Promise<void>, config:object }}
 */
export function createServer(opts = {}) {
  const host = resolveBindHost(opts.host || process.env.HOST);
  /** 局域网模式：非回环地址绑定必须显式开启，同时对 Origin 校验放宽到「同源」 */
  const allowLan = !isLoopbackHost(host);
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const configFile = opts.configFile || process.env.MDAI_CONFIG || path.join(ROOT, 'config.json');
  /** 静态资源根目录：默认是组件自身；桌面版可指向应用根以托管自己的界面 */
  const staticRoot = path.resolve(opts.staticRoot || ROOT);
  /** 数据目录：存放本地题库等运行数据；默认与配置文件同级的 data/ */
  const dataDir = path.resolve(opts.dataDir || process.env.ZHS_DATA_DIR || path.join(path.dirname(configFile), 'data'));
  const bankFile = path.join(dataDir, 'bank.json');

  /** 启动时解析一次后端配置（含 apiKey），此后只在后端使用 */
  let serverConfig = null;

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // CORS/来源校验：仅放行同源、本机回环与浏览器扩展来源，
    // 挡住任意网站借本机后端盗用已配置的 apiKey（不改动同源页面的正常使用）。
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin, req, allowLan)) {
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
      if (url.pathname === '/api/vision' && req.method === 'POST')
        return await handleVision(req, res, { serverConfig, bankFile });
      if (url.pathname === '/api/vision/extract' && req.method === 'POST')
        return await handleVisionExtract(req, res, { serverConfig });
      if (url.pathname === '/api/vision/reason' && req.method === 'POST')
        return await handleVisionReason(req, res, { serverConfig, bankFile });
      if (url.pathname === '/api/capture/last' && req.method === 'GET')
        return await handleCaptureLast(res, { dataDir });
      if (url.pathname === '/api/bank' && (req.method === 'GET' || req.method === 'POST'))
        return await handleBank(req, res, { bankFile });
      if (url.pathname === '/api/render' && req.method === 'POST') return await handleRender(req, res);

      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: '未知接口' });
      return await serveStatic(req, res, url, staticRoot);
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
