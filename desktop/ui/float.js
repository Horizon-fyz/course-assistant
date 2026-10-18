/**
 * desktop/ui/float.js —— 悬浮窗（截屏视觉识题）
 *
 * 订阅宿主广播的共享状态（题目 / 答案 / 题库命中），显示当前题的答案。
 * 只读展示，不做任何自动点击。
 */
const $ = (id) => document.getElementById(id);
const bridge = window.zhs;

const TYPE_LABELS = { single: '单选题', multiple: '多选题', judge: '判断题', blank: '填空题', essay: '简答题' };
const STEP_STATUS = { pending: '待运行', running: '进行中…', done: '完成', error: '失败' };

let state = { questions: [], answers: {}, cursor: 0, running: false, busy: false, bankCount: 0, status: '就绪' };
let lastStepsSig = '';

/* ------------------------------ 渲染 ------------------------------ */

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 步骤面板：截屏 → 提取 → 输出，逐步点亮（内容不变则跳过重绘，避免缩略图反复请求） */
function renderSteps() {
  const box = $('steps');
  if (!box) return;
  const steps = Array.isArray(state.steps) ? state.steps : [];
  const sig = JSON.stringify(steps) + '|' + (state.captureAt || 0);
  if (sig === lastStepsSig) return;
  lastStepsSig = sig;

  if (!steps.length) { box.innerHTML = ''; return; }
  const num = ['①', '②', '③', '④', '⑤'];
  box.innerHTML = steps.map((s, i) => {
    const st = s.status || 'pending';
    const shot = s.key === 'capture' && (st === 'done' || st === 'error')
      ? `<img class="shot" src="/api/capture/last?t=${encodeURIComponent(state.captureAt || 0)}" alt="最近截屏" />`
      : '';
    return `<div class="step ${st}">
      <span class="sdot"></span>
      <div class="sinfo">
        <div class="sname">${num[i] || ''} ${escapeHtml(s.title || s.key || '')}</div>
        <div class="sdesc">${escapeHtml(s.detail || STEP_STATUS[st] || st)}</div>
        ${shot}
      </div>
    </div>`;
  }).join('');
}

function renderStatus() {
  $('status').textContent = state.status || '就绪';
  $('bank').textContent = '题库 ' + (state.bankCount || 0);
  $('dot').classList.toggle('on', !!state.running);

  const btn = $('btn-toggle');
  btn.textContent = state.running ? '停止识题' : '开始识题';
  btn.classList.toggle('warn', !!state.running);
  btn.classList.toggle('primary', !state.running);
}

function render() {
  renderStatus();
  renderSteps();

  const qs = state.questions || [];
  const total = qs.length;
  $('idx').textContent = total ? `${(state.cursor || 0) + 1} / ${total}` : '— / —';

  if (!total) {
    $('body').innerHTML = `<div class="empty">还没有识别到题目。<br />用你自己的浏览器打开智慧树作业页，<br />然后点下面的 <b>「开始识题」</b>。</div>`;
    return;
  }

  const i = Math.max(0, Math.min(state.cursor || 0, total - 1));
  const q = qs[i];
  const a = (state.answers || {})[String(q.id)] || {};

  const ansText = String(a.answer || '');
  const opts = (q.options || []).map((o) => {
    const hit = ansText.toUpperCase().includes(String(o.key).toUpperCase()) && String(o.key).length === 1;
    return `<div>${hit ? '<b>' : ''}${escapeHtml(o.key)}. ${escapeHtml(o.text)}${hit ? '</b>' : ''}</div>`;
  }).join('');

  const srcTag = a.source === 'bank'
    ? '<span class="tag src-bank">题库</span>'
    : (a.source === 'ai' ? '<span class="tag src-ai">AI</span>' : '');

  $('body').innerHTML = `
    <div class="qt"><span class="tag">${TYPE_LABELS[q.type] || q.type || '题目'}</span>${srcTag}</div>
    <div class="stem">${escapeHtml(q.stem)}</div>
    ${opts ? `<div class="opts">${opts}</div>` : ''}
    <div class="ansbox">
      <div class="anslabel">答案</div>
      <div class="answer">${escapeHtml(ansText || '（未识别到答案）')}</div>
      ${a.reason ? `<div class="reason">${escapeHtml(a.reason)}</div>` : ''}
    </div>
  `;
}

/* ------------------------------ 交互 ------------------------------ */

function move(delta) {
  const total = (state.questions || []).length;
  if (!total) return;
  const next = Math.max(0, Math.min((state.cursor || 0) + delta, total - 1));
  if (next === state.cursor) return;
  state.cursor = next;
  bridge.setState({ cursor: next });
  render();
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

$('btn-close').addEventListener('click', () => bridge.closeFloat());
$('btn-min').addEventListener('click', () => bridge.minimizeFloat());
$('btn-settings').addEventListener('click', () => bridge.openSettings('settings'));
$('btn-prev').addEventListener('click', () => move(-1));
$('btn-next').addEventListener('click', () => move(1));

$('btn-toggle').addEventListener('click', async () => {
  try { await bridge.toggleVision(); } catch (e) { alert('操作失败：' + e.message); }
});

$('btn-once').addEventListener('click', async () => {
  const btn = $('btn-once');
  btn.disabled = true;
  try { await bridge.visionOnce(); } catch (e) { alert('截屏失败：' + e.message); }
  finally { btn.disabled = false; }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') move(-1);
  if (e.key === 'ArrowRight') move(1);
});

/* ------------------------------ 拖拽（WebView2 不支持 -webkit-app-region，需自行实现） ------------------------------ */

(function bindDrag() {
  if (!bridge || !bridge.post) return;
  const bar = document.querySelector('.bar');
  if (!bar) return;

  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    // 只发一次：由宿主呼叫 Windows 原生的窗口移动循环来跟踪鼠标。
    // 之前逐帧回传 screenX/screenY 要经 WebView2 IPC 往返，并会被浏览器节流，窗口总是追不上鼠标。
    bridge.post('float:dragStart', {});
  });
})();

/* ------------------------------ 四角 / 四边拉伸缩放（WebView2 子窗口吞掉命中测试，只能在前端侦测边缘） ------------------------------ */

(function bindResize() {
  if (!bridge || !bridge.post) return;
  const EDGE = 6;   // 边缘命中厚度（CSS px）

  /** 根据鼠标在窗口内的位置判断落点方向：n/s/e/w 及四角组合 */
  function hitZone(e) {
    const w = window.innerWidth, h = window.innerHeight;
    const x = e.clientX, y = e.clientY;
    const left = x <= EDGE, right = x >= w - EDGE, top = y <= EDGE, bottom = y >= h - EDGE;
    if (top && left) return 'nw';
    if (top && right) return 'ne';
    if (bottom && left) return 'sw';
    if (bottom && right) return 'se';
    if (top) return 'n';
    if (bottom) return 's';
    if (left) return 'w';
    if (right) return 'e';
    return '';
  }

  /** 在 <html> 上挂方向类，配合注入的 CSS 让整窗（含 cursor:move 的标题栏）都显示对应缩放光标 */
  function setZone(z) {
    const el = document.documentElement;
    el.classList.remove('rz-n', 'rz-s', 'rz-e', 'rz-w', 'rz-ne', 'rz-nw', 'rz-se', 'rz-sw');
    if (z) el.classList.add('rz-' + z);
  }

  const style = document.createElement('style');
  style.textContent = ['.rz-n,.rz-n *', '.rz-s,.rz-s *'].map((s) => `${s}{cursor:ns-resize!important}`)
    .concat(['.rz-e,.rz-e *', '.rz-w,.rz-w *'].map((s) => `${s}{cursor:ew-resize!important}`))
    .concat(['.rz-ne,.rz-ne *', '.rz-sw,.rz-sw *'].map((s) => `${s}{cursor:nesw-resize!important}`))
    .concat(['.rz-nw,.rz-nw *', '.rz-se,.rz-se *'].map((s) => `${s}{cursor:nwse-resize!important}`))
    .join('');
  document.head.appendChild(style);

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const z = hitZone(e);
    if (!z) return;
    e.stopPropagation();   // 阻止 .bar 的拖拽逻辑
    e.preventDefault();
    // 只发一次方向：由宿主把方向映射成 HT* 命中码，交给系统原生「缩放窗口」循环跟踪鼠标。
    // 之后鼠标被该循环独占，前端收不到 mouseup，故不再回传坐标/结束事件。
    bridge.post('float:resizeStart', { dir: z });
  }, true);   // 捕获阶段抢在拖拽之前处理

  window.addEventListener('mousemove', (e) => {
    setZone(hitZone(e));
  });
})();

/* ------------------------------ 启动 ------------------------------ */

bindTheme();
bridge.onState((s) => { state = s || state; render(); });
bridge.getState().then((s) => { state = s || state; render(); });
bridge.getBankCount().then((r) => { state.bankCount = (r && r.count) || 0; renderStatus(); }).catch(() => {});
