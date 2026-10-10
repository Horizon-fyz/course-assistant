/**
 * app.js —— 前端（客户端）
 *
 * 前端不再直接调用 AI，也不持有密钥：解析 / 答题 / 渲染 全部通过后端 `/api/*` 完成。
 * 后端由 server/index.mjs 提供；桌面版（Electron）内嵌该服务，浏览器版单独启动服务。
 *
 * 本文件只做两件事：
 *   1. 与后端 HTTP API 交互（同源，无需处理 CORS）；
 *   2. 交互与展示；文件读写优先走 Electron 原生对话框（window.mdai），否则用 Web 能力。
 */

/* ------------------------------ 后端 API 封装 ------------------------------ */

/** 同源调用后端；失败时抛出带后端错误信息的异常 */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `接口错误 HTTP ${res.status}`);
  return data;
}

/**
 * 逐题作答（SSE 流式进度）。返回 answers 对象（键为字符串 id）。
 * @param {object} payload { questions, config, mock }
 * @param {{onProgress?:(l:number,t:number)=>void, onBatchError?:(info:object)=>void}} hooks
 * @param {AbortSignal} [signal] 用于「停止」按钮中断请求
 */
async function apiAnswerStream(payload, hooks = {}, signal) {
  const res = await fetch('/api/answer?stream=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });

  // 出错时后端返回的是普通 JSON，而非事件流
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `接口错误 HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answers = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // 按 SSE 的空行分隔逐个事件解析
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let event = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      const payloadData = data ? JSON.parse(data) : {};
      if (event === 'progress') hooks.onProgress?.(payloadData.loaded, payloadData.total);
      else if (event === 'error') hooks.onBatchError?.(payloadData);
      else if (event === 'done') answers = payloadData.answers;
    }
  }
  return answers || {};
}

/* ------------------------------ 运行时环境 ------------------------------ */

/** Electron 暴露的安全桥；浏览器下为 null（仅用于原生文件对话框） */
const bridge = window.mdai || null;

/* ------------------------------ 状态 ------------------------------ */

let questions = [];
/** @type {Map<number, {answer:string, reason?:string, confidence?:number|null}>} */
let answers = new Map();
let sourceText = '';
let sourceName = '';
let controller = null;

/* ------------------------------ 元素引用 ------------------------------ */

const $ = (id) => document.getElementById(id);
const els = {
  runtimeBadge: $('runtime-badge'),
  backendBadge: $('backend-badge'),
  btnOpen: $('btn-open'),
  fileName: $('file-name'),
  btnParse: $('btn-parse'),
  drop: $('drop'),
  bankText: $('bank-text'),
  parseSummary: $('parse-summary'),
  btnAnswer: $('btn-answer'),
  btnMock: $('btn-mock'),
  btnStop: $('btn-stop'),
  progress: $('progress'),
  status: $('status'),
  results: $('results'),
  btnExportMd: $('btn-export-md'),
  btnExportFilled: $('btn-export-filled'),
  showReason: $('show-reason'),
  saveKey: $('save-key'),
};
const cfgInputs = {
  baseUrl: $('cfg-baseUrl'),
  apiKey: $('cfg-apiKey'),
  model: $('cfg-model'),
  concurrency: $('cfg-concurrency'),
  batchSize: $('cfg-batchSize'),
};

/* ------------------------------ 配置 ------------------------------ */

const LS_KEY = 'mdai.config';

function loadLocalConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    cfgInputs.model.value = saved.model || '';
    cfgInputs.concurrency.value = saved.concurrency || 3;
    cfgInputs.batchSize.value = saved.batchSize || 5;
    els.saveKey.checked = Boolean(saved.rememberKey);
    if (saved.rememberKey && saved.apiKey) cfgInputs.apiKey.value = saved.apiKey;
  } catch {
    /* 忽略损坏的本地配置 */
  }
}

/** 用后端配置预填表单（密钥不回传，只提示是否已配置） */
async function loadServerConfig() {
  try {
    const { config } = await api('/api/config');
    if (config.baseUrl) cfgInputs.baseUrl.value = config.baseUrl;
    if (config.model) cfgInputs.model.value = config.model;
    if (config.concurrency) cfgInputs.concurrency.value = config.concurrency;
    if (config.batchSize) cfgInputs.batchSize.value = config.batchSize;
    els.backendBadge.textContent = config.hasApiKey ? '后端已配置密钥' : '后端未配置密钥';
    els.backendBadge.hidden = false;
  } catch {
    els.backendBadge.textContent = '后端未连接';
    els.backendBadge.hidden = false;
  }
}

/** 组装前端要传给后端的 config（留空字段不传，由后端兜底） */
function readConfig() {
  const cfg = {};
  const put = (k, v) => {
    if (v !== '' && v !== undefined && v !== null) cfg[k] = v;
  };
  put('baseUrl', cfgInputs.baseUrl.value.trim());
  put('apiKey', cfgInputs.apiKey.value.trim());
  put('model', cfgInputs.model.value.trim());
  put('concurrency', Number(cfgInputs.concurrency.value) || undefined);
  put('batchSize', Number(cfgInputs.batchSize.value) || undefined);
  return cfg;
}

function persistConfig() {
  const remember = els.saveKey.checked;
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({
      model: cfgInputs.model.value.trim(),
      concurrency: Number(cfgInputs.concurrency.value) || 3,
      batchSize: Number(cfgInputs.batchSize.value) || 5,
      rememberKey: remember,
      apiKey: remember ? cfgInputs.apiKey.value.trim() : '',
    }),
  );
}

/* ------------------------------ 题库载入 ------------------------------ */

function setSource({ name, text, path = '' }) {
  sourceText = text || '';
  sourceName = name || '';
  els.fileName.textContent = name ? `${name}${path ? `　(${path})` : ''}` : '未选择文件';
  els.bankText.value = text || '';
}

async function openFile() {
  if (bridge) {
    const r = await bridge.openBank();
    if (r) setSource({ name: r.name, text: r.text, path: r.path });
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.md,.markdown,.txt';
  input.onchange = () => input.files[0] && readFileAsText(input.files[0]);
  input.click();
}

function readFileAsText(file) {
  const reader = new FileReader();
  reader.onload = () => setSource({ name: file.name, text: String(reader.result) });
  reader.readAsText(file, 'utf-8');
}

/* ------------------------------ 解析（走后端） ------------------------------ */

async function parse() {
  const text = els.bankText.value.trim() ? els.bankText.value : sourceText;
  if (!text.trim()) {
    setStatus('请先选择文件或粘贴题库内容。', 'error');
    return;
  }
  sourceText = text;
  try {
    const { questions: qs } = await api('/api/parse', { method: 'POST', body: { markdown: text } });
    questions = qs;
    answers = new Map();
  } catch (e) {
    setStatus(`解析失败：${e.message}`, 'error');
    return;
  }

  if (questions.length === 0) {
    els.parseSummary.textContent = '未解析出题目，请检查格式（见 README 第 8 节）。';
    setStatus('解析失败。', 'error');
    return;
  }
  const byType = {};
  for (const q of questions) byType[q.type] = (byType[q.type] || 0) + 1;
  els.parseSummary.textContent = `已解析 ${questions.length} 题：${Object.entries(byType)
    .map(([t, n]) => `${TYPE_LABELS[t] || t} ${n}`)
    .join('　')}`;
  setStatus('解析完成，可以开始答题。');

  els.btnExportMd.disabled = true;
  els.btnExportFilled.disabled = true;
  els.results.innerHTML = '<p class="muted">已解析，尚未作答。</p>';
}

/* ------------------------------ 答题（走后端，SSE 进度） ------------------------------ */

function setStatus(msg, kind = '') {
  els.status.textContent = msg;
  els.status.className = kind === 'error' ? 'error' : 'muted';
}

function setBusy(busy) {
  els.btnAnswer.disabled = busy;
  els.btnMock.disabled = busy;
  els.btnStop.disabled = !busy;
  els.btnParse.disabled = busy;
  els.btnOpen.disabled = busy;
}

async function run(mock) {
  if (questions.length === 0) {
    setStatus('请先解析题目。', 'error');
    return;
  }
  const cfg = readConfig();
  persistConfig();
  setBusy(true);
  controller = new AbortController();
  els.progress.value = 0;
  setStatus(mock ? '离线演示中…' : '正在调用 AI（后端）…');

  try {
    const result = await apiAnswerStream(
      { questions, config: cfg, mock },
      {
        onProgress: (loaded, total) => {
          els.progress.value = Math.round((loaded / total) * 100);
          setStatus(`已作答 ${loaded}/${total}`);
        },
        onBatchError: (info) => console.warn('批次失败：', info),
      },
      controller.signal,
    );
    answers = new Map(Object.entries(result).map(([k, v]) => [Number(k), v]));
    renderResults();
    els.btnExportMd.disabled = false;
    els.btnExportFilled.disabled = false;
    setStatus(mock ? '离线演示完成。' : '答题完成。');
  } catch (e) {
    if (e.name === 'AbortError') setStatus('已停止。');
    else setStatus(`失败：${e.message}`, 'error');
  } finally {
    setBusy(false);
    controller = null;
  }
}

/* ------------------------------ 结果渲染 ------------------------------ */

const TYPE_LABELS = { single: '单选题', multiple: '多选题', judge: '判断题', blank: '填空题', essay: '简答题' };

function renderResults() {
  const showReason = els.showReason.checked;
  els.results.innerHTML = '';

  for (const q of questions) {
    const a = answers.get(q.id) || {};
    const div = document.createElement('div');
    div.className = `q${!a.answer ? ' failed' : ''}`;

    const opts = q.options.map((o) => `${o.key}. ${escapeHtml(o.text)}`).join('<br>');
    div.innerHTML = `
      <div class="qhead">
        <span class="no">${escapeHtml(q.number)}.</span>
        <span class="tag">${TYPE_LABELS[q.type] || q.type}</span>
      </div>
      <div class="stem">${escapeHtml(q.stem)}</div>
      ${opts ? `<div class="opts">${opts}</div>` : ''}
      <div class="ans">答案：${escapeHtml(a.answer || '（未作答）')}</div>
      ${a.reason && showReason ? `<div class="reason">解析：${escapeHtml(a.reason)}</div>` : ''}
      ${q.given ? `<div class="given">原卷标注：${escapeHtml(q.given)}</div>` : ''}
    `;
    els.results.appendChild(div);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------ 导出（渲染走后端，保存走本地） ------------------------------ */

function baseName() {
  return (sourceName || '题库').replace(/\.(md|markdown|txt)$/i, '');
}

function answersObject() {
  const o = {};
  for (const [id, a] of answers) o[String(id)] = a;
  return o;
}

async function exportAnswers() {
  const { markdown } = await api('/api/render', {
    method: 'POST',
    body: { questions, answers: answersObject(), format: 'answers', meta: { source: sourceName || '-', model: cfgInputs.model.value.trim() } },
  });
  await saveText(`${baseName()}.answers.md`, markdown);
}

async function exportFilled() {
  const { markdown } = await api('/api/render', {
    method: 'POST',
    body: { questions, answers: answersObject(), format: 'filled', sourceText },
  });
  await saveText(`${baseName()}.answered.md`, markdown);
}

/** 保存：Electron 走原生对话框；浏览器走 Blob 下载 */
async function saveText(name, content) {
  if (bridge) {
    const p = await bridge.saveText({ defaultPath: name, content });
    setStatus(p ? `已保存：${p}` : '已取消保存。');
    return;
  }
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`已下载：${name}`);
}

/* ------------------------------ 事件绑定与启动 ------------------------------ */

function bindEvents() {
  els.btnOpen.addEventListener('click', openFile);
  els.btnParse.addEventListener('click', parse);
  els.btnAnswer.addEventListener('click', () => run(false));
  els.btnMock.addEventListener('click', () => run(true));
  els.btnStop.addEventListener('click', () => {
    controller?.abort();
    setStatus('已请求停止。');
  });
  els.btnExportMd.addEventListener('click', exportAnswers);
  els.btnExportFilled.addEventListener('click', exportFilled);
  els.showReason.addEventListener('change', renderResults);

  els.drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.drop.classList.add('over');
  });
  els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
  els.drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    els.drop.classList.remove('over');
    const file = e.dataTransfer.files?.[0];
    if (file) setSource({ name: file.name, text: await file.text() });
  });
}

els.runtimeBadge.textContent = bridge ? '桌面版' : '浏览器';
loadLocalConfig();
bindEvents();
loadServerConfig();
