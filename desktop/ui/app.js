/**
 * desktop/ui/app.js —— 主窗口逻辑
 *
 * 现行工作方式：独立悬浮窗 + 定时截屏 + 通义千问 qwen-vl 视觉识题，
 * 只显示答案，由人工点击作答。本页负责：
 *   1) 驱动悬浮窗 / 识题开关 / 题库管理；
 *   2) 「本地题库」页：导入 Markdown 离线批量作答（保留的独立功能）。
 *
 * 说明：旧的内置浏览器自动化（扫描本页 / 回填本页 / 自动登录）源码仍在宿主里，
 * 但已不再使用，本页也不再调用。
 */
const $ = (id) => document.getElementById(id);
const bridge = window.zhs;

const TYPE_LABELS = { single: '单选题', multiple: '多选题', judge: '判断题', blank: '填空题', essay: '简答题' };

/* ------------------------------ 状态 ------------------------------ */
let questions = [];
let answers = new Map();
let sourceText = '';
let sourceName = '';
let controller = null;

/* ------------------------------ 后端调用 ------------------------------ */

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

/** SSE 流式作答 */
async function apiAnswerStream(payload, hooks, signal) {
  const res = await fetch('/api/answer?stream=1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.error || `接口错误 HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let result = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
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
      let payloadData = {};
      try { payloadData = data ? JSON.parse(data) : {}; } catch { /* 忽略坏块 */ }
      if (event === 'progress') hooks.onProgress?.(payloadData.loaded, payloadData.total);
      else if (event === 'done') result = payloadData.answers;
    }
  }
  return result || {};
}

/* ------------------------------ 题库（Markdown 离线作答） ------------------------------ */

function setSource({ name, text }) {
  sourceText = text || '';
  sourceName = name || '';
  $('file-name').textContent = name || '未选择文件';
  $('bank-text').value = text || '';
}

async function pickFile() {
  const r = await bridge?.pickBank();
  if (r) setSource({ name: r.name, text: r.text });
}

async function parse() {
  const text = $('bank-text').value.trim() || sourceText;
  if (!text.trim()) { setStatus('请先选择文件或粘贴题库内容。', true); return; }

  sourceText = text;
  try {
    const { questions: qs } = await api('/api/parse', { method: 'POST', body: { markdown: text } });
    questions = qs;
    answers = new Map();
  } catch (e) {
    setStatus('解析失败：' + e.message, true);
    return;
  }

  if (!questions.length) {
    $('parse-summary').textContent = '未解析出题目，请检查格式。';
    setStatus('解析失败。', true);
    return;
  }
  const byType = {};
  for (const q of questions) byType[q.type] = (byType[q.type] || 0) + 1;
  $('parse-summary').textContent = `已解析 ${questions.length} 题：` +
    Object.entries(byType).map(([t, n]) => `${TYPE_LABELS[t] || t} ${n}`).join('　');

  setStatus('解析完成，可以开始作答。');
  $('btn-answer').disabled = false;
  $('btn-mock').disabled = false;
  $('btn-export-md').disabled = true;
  $('btn-export-json').disabled = true;
  $('results').innerHTML = '<p class="muted">已解析，尚未作答。</p>';
}

/* ------------------------------ 作答 ------------------------------ */

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.style.color = isError ? 'var(--error-fg)' : '';
}

function setBusy(busy) {
  $('btn-answer').disabled = busy;
  $('btn-mock').disabled = busy;
  $('btn-parse').disabled = busy;
  $('btn-pick').disabled = busy;
  $('btn-stop').disabled = !busy;
}

async function run(mock) {
  if (!questions.length) { setStatus('请先解析题目。', true); return; }

  const cfg = await bridge.getConfig();
  setBusy(true);
  controller = new AbortController();
  $('progress').value = 0;
  setStatus(mock ? '离线演示中…' : '正在调用 AI…');

  try {
    const result = await apiAnswerStream(
      { questions, config: { baseUrl: cfg.reasonBaseUrl, model: cfg.reasonModel, concurrency: cfg.concurrency, batchSize: cfg.batchSize }, mock },
      {
        onProgress: (loaded, total) => {
          $('progress').value = Math.round((loaded / total) * 100);
          setStatus(`已作答 ${loaded}/${total}`);
        },
      },
      controller.signal,
    );
    answers = new Map(Object.entries(result).map(([k, v]) => [Number(k), v]));
    renderResults();
    $('btn-export-md').disabled = false;
    $('btn-export-json').disabled = false;
    setStatus(mock ? '离线演示完成。' : '作答完成。');
  } catch (e) {
    if (e.name === 'AbortError') setStatus('已停止。');
    else setStatus('失败：' + e.message, true);
  } finally {
    setBusy(false);
    controller = null;
  }
}

/* ------------------------------ 渲染 ------------------------------ */

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderResults() {
  const showReason = $('show-reason').checked;
  const box = $('results');
  box.innerHTML = '';
  for (const q of questions) {
    const a = answers.get(q.id) || {};
    const div = document.createElement('div');
    div.className = 'q';
    const opts = q.options.map((o) => `${o.key}. ${escapeHtml(o.text)}`).join('<br>');
    div.innerHTML = `
      <div><span class="no">${escapeHtml(q.number)}.</span><span class="tag">${TYPE_LABELS[q.type] || q.type}</span></div>
      <div class="stem">${escapeHtml(q.stem)}</div>
      ${opts ? `<div class="opts">${opts}</div>` : ''}
      <div class="ans">答案：${escapeHtml(a.answer || '（未作答）')}</div>
      ${a.reason && showReason ? `<div class="reason">解析：${escapeHtml(a.reason)}</div>` : ''}
    `;
    box.appendChild(div);
  }
}

/* ------------------------------ 导出 ------------------------------ */

const baseName = () => (sourceName || '题库').replace(/\.(md|markdown|txt)$/i, '');

async function exportMd() {
  const { markdown } = await api('/api/render', {
    method: 'POST',
    body: {
      questions,
      answers: Object.fromEntries([...answers].map(([k, v]) => [String(k), v])),
      format: 'answers',
      meta: { source: sourceName || '-', model: $('cfg-reason-model').value.trim() },
    },
  });
  const p = await bridge.saveText({ defaultPath: `${baseName()}.answers.md`, content: markdown });
  setStatus(p ? `已保存：${p}` : '已取消保存。');
}

/** 导出结构化 JSON */
async function exportJson() {
  const packed = {
    meta: { source: sourceName || '-', model: $('cfg-reason-model').value.trim(), generatedAt: new Date().toISOString(), count: questions.length },
    questions: questions.map((q) => {
      const a = answers.get(q.id) || {};
      return {
        id: q.id, number: q.number, section: q.section, type: q.type, stem: q.stem,
        options: q.options.map((o) => ({ key: o.key, text: o.text })),
        answer: a.answer || '', reason: a.reason || '',
        confidence: typeof a.confidence === 'number' ? a.confidence : null,
      };
    }),
  };
  const p = await bridge.saveText({ defaultPath: `${baseName()}.answers.json`, content: JSON.stringify(packed, null, 2) });
  setStatus(p ? `已保存：${p}` : '已取消保存。');
}

/* ------------------------------ 截屏识题 / 悬浮窗 ------------------------------ */

async function toggleFloat() {
  const on = await bridge.toggleFloat();
  $('btn-float').textContent = on ? '隐藏悬浮窗' : '显示悬浮窗';
}

async function openFloat() {
  await bridge.openFloat();
  $('btn-float').textContent = '隐藏悬浮窗';
  $('vision-status').textContent = '悬浮窗已打开，点「开始识题」后开始定时截屏。';
}

async function toggleVision() {
  await bridge.toggleVision();
  const running = $('btn-vision-toggle').textContent === '开始识题';
  $('btn-vision-toggle').textContent = running ? '停止识题' : '开始识题';
  $('vision-status').textContent = running ? '正在定时截屏识题…' : '已停止识题。';
}

async function visionOnce() {
  $('vision-status').textContent = '正在截屏识别…';
  try {
    await bridge.visionOnce();
    $('vision-status').textContent = '已截屏识别，结果见悬浮窗。';
  } catch (e) {
    $('vision-status').textContent = '识别失败：' + e.message;
  }
}

/* ------------------------------ 本地题库 ------------------------------ */

async function refreshBank() {
  try {
    const r = await bridge.getBankCount();
    const n = (r && r.count) || 0;
    $('bank-count').textContent = n;
    $('bank-count-2').textContent = n;
  } catch { /* 忽略 */ }
}

async function clearBank() {
  await bridge.clearBank();
  await refreshBank();
  $('vision-status').textContent = '本地题库已清空。';
}

/* ------------------------------ 设置 ------------------------------ */

async function loadConfigForm() {
  const cfg = await bridge.getConfig();
  $('cfg-vision-baseUrl').value = cfg.visionBaseUrl || '';
  $('cfg-vision-model').value = cfg.visionModel || '';
  $('cfg-vision-apiKey').value = cfg.visionApiKey || '';
  $('cfg-reason-baseUrl').value = cfg.reasonBaseUrl || '';
  $('cfg-reason-model').value = cfg.reasonModel || '';
  $('cfg-reason-apiKey').value = cfg.reasonApiKey || '';
  $('cfg-concurrency').value = cfg.concurrency || 3;
  $('cfg-batchSize').value = cfg.batchSize || 5;
  const ready = !!(cfg.visionApiKey && cfg.reasonApiKey);
  $('ai-badge').textContent = ready ? 'AI 已配置' : 'AI 未配置';
  $('ai-badge').className = ready ? 'badge ok' : 'badge';
}

async function saveConfigForm() {
  await bridge.setConfig({
    visionBaseUrl: $('cfg-vision-baseUrl').value.trim(),
    visionModel: $('cfg-vision-model').value.trim(),
    visionApiKey: $('cfg-vision-apiKey').value.trim(),
    reasonBaseUrl: $('cfg-reason-baseUrl').value.trim(),
    reasonModel: $('cfg-reason-model').value.trim(),
    reasonApiKey: $('cfg-reason-apiKey').value.trim(),
    concurrency: Number($('cfg-concurrency').value) || 3,
    batchSize: Number($('cfg-batchSize').value) || 5,
  });
  await loadConfigForm();
  $('cfg-status').textContent = '已保存';
  setTimeout(() => { $('cfg-status').textContent = ''; }, 2000);
}

/* ------------------------------ 界面 ------------------------------ */

/** 切到指定页签（宿主可用 #settings 直接定位过来） */
function activateTab(pane) {
  if (!pane) return;
  const tab = document.querySelector(`.tab[data-pane="${pane}"]`);
  if (!tab) return;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
  for (const p of document.querySelectorAll('.pane')) p.classList.toggle('active', p.id === `pane-${pane}`);
  if (pane === 'bank' || pane === 'settings') refreshBank();
}

function bindTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => activateTab(tab.dataset.pane));
  }
  // 宿主通过 #settings 之类直接定位
  const fromHash = () => activateTab((location.hash || '').replace(/^#/, ''));
  window.addEventListener('hashchange', fromHash);
  fromHash();
}

function bindTheme() {
  const saved = localStorage.getItem('zhs-theme') || 'light';
  document.documentElement.dataset.theme = saved;
  $('btn-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('zhs-theme', next);
  });
}

function bindEvents() {
  // 悬浮窗 / 识题
  $('btn-float').addEventListener('click', toggleFloat);
  $('btn-open-float').addEventListener('click', openFloat);
  $('btn-vision-toggle').addEventListener('click', toggleVision);
  $('btn-vision-once').addEventListener('click', visionOnce);

  // 本地题库（Markdown 离线作答）
  $('btn-pick').addEventListener('click', pickFile);
  $('btn-parse').addEventListener('click', parse);
  $('btn-answer').addEventListener('click', () => run(false));
  $('btn-mock').addEventListener('click', () => run(true));
  $('btn-stop').addEventListener('click', () => { controller?.abort(); setStatus('已请求停止。'); });
  $('btn-export-md').addEventListener('click', exportMd);
  $('btn-export-json').addEventListener('click', exportJson);
  $('show-reason').addEventListener('change', renderResults);

  // 题库管理
  $('btn-clear-bank').addEventListener('click', clearBank);
  $('btn-clear-bank-2').addEventListener('click', clearBank);

  // 设置
  $('btn-save-cfg').addEventListener('click', saveConfigForm);
  $('btn-reload-cfg').addEventListener('click', loadConfigForm);

  // 关于
  $('btn-open-dir').addEventListener('click', async () => {
    const info = await bridge.appInfo();
    bridge.openExternal('file:///' + info.portableDir.replace(/\\/g, '/'));
  });
}

async function init() {
  bindTheme();
  bindTabs();
  bindEvents();
  await loadConfigForm();
  await refreshBank();

  const info = await bridge.appInfo();
  $('about-info').textContent =
    `版本 ${info.version} · ${info.electron} · ${info.packaged ? '打包版' : '开发版'}`;
  $('about-info').textContent += `\n配置：${info.configPath}\n数据：${info.dataDir}`;
  $('about-info').style.whiteSpace = 'pre-wrap';
}

init();
