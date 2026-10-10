// content.js —— 页面注入脚本
// 职责：读取题目 DOM、调用 AI、渲染悬浮窗、模拟人类点击回填

// ---------- 与 answer-engine 共享的纯逻辑（内联，因为插件无法直接 import Node 模块） ----------

const TRUE_WORDS = ['正确', '对', '对的', '是', '是的', 'true', 't', '√', '✓', 'v'];
const FALSE_WORDS = ['错误', '错', '错的', '不对', '否', '不是', 'false', 'f', '×', '✗', 'x'];
const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TYPE_LABELS = { single: '单选题', multiple: '多选题', judge: '判断题', blank: '填空题', essay: '简答题' };

function normalize(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function judgeValue(text) {
  const t = String(text ?? '').replace(/<[^>]*>/g, ' ').replace(/[\s\u3000.。、，,；;：:]/g, '').toLowerCase();
  if (!t) return null;
  if (TRUE_WORDS.includes(t)) return 'true';
  if (FALSE_WORDS.includes(t)) return 'false';
  if (TRUE_WORDS.some((w) => w.length > 1 && t.includes(w))) return 'true';
  if (FALSE_WORDS.some((w) => w.length > 1 && t.includes(w))) return 'false';
  return null;
}

function lettersToIndexes(letters, count) {
  const out = [];
  for (const ch of String(letters || '').toUpperCase()) {
    const i = LABELS.indexOf(ch);
    if (i >= 0 && i < count && !out.includes(i)) out.push(i);
  }
  return out;
}

// ---------- 页面题目读取 ----------

function readQuestions() {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const subs = [...document.querySelectorAll('.examPaper_subject')].filter((s) => s.querySelector('.nodeLab'));

  // 视频弹题
  const topicDialog = document.querySelector('#playTopic-dialog');
  if (topicDialog) {
    const topic = topicDialog.querySelector('.topic');
    if (topic) {
      const typeSpan = topic.querySelector('.title-tit');
      const typeName = clean(typeSpan?.innerText || '');
      const stemSpan = topic.querySelector('.topic-title span:not(.title-tit)');
      const stem = clean(stemSpan?.innerText || '');
      const options = [...topic.querySelectorAll('.topic-item')].map((item, i) => ({
        index: i,
        letter: clean(item.querySelector('.topic-option-item')?.innerText || '').replace(/[.\s]/g, '') || LABELS[i],
        text: clean(item.querySelector('.item-topic')?.innerText || ''),
      }));
      const type = /多选/.test(typeName) ? 'multiple' : /判断/.test(typeName) ? 'judge' : 'single';
      return { source: 'popup', questions: [{ index: 0, type, stem, options, element: topicDialog }] };
    }
  }

  // 作业/考试页
  const questions = subs.map((s, qi) => {
    const stemEl = s.querySelector('.subject_describe');
    const headEl = s.querySelector('.subject_stem');
    const headText = clean(headEl?.innerText || '');
    const typeName = (headText.match(/【(.+?)】/) || [])[1] || '';
    const type = /多选|不定项/.test(typeName) ? 'multiple'
      : /判断/.test(typeName) ? 'judge'
        : /填空/.test(typeName) ? 'blank'
          : /简答|问答|论述/.test(typeName) ? 'essay' : 'single';
    const options = [...s.querySelectorAll('.nodeLab')].map((lab, i) => {
      const inp = lab.querySelector('input');
      const detail = lab.querySelector('.node_detail, .examquestions-answer');
      const letterSpan = lab.querySelector('.label span');
      return {
        index: i,
        letter: clean(letterSpan?.innerText || '').replace(/[.\s]/g, ''),
        id: inp?.value || null,
        checked: inp?.checked || null,
        text: clean(detail?.innerText || lab.innerText || ''),
      };
    });
    const anchor = s.querySelector('.subject_num span[id^=anchor_]');
    const eid = anchor?.id.replace(/^anchor_/, '') || null;
    return { index: qi, eid, type, stem: clean(stemEl?.innerText || ''), options, element: s };
  });

  return { source: 'exam', questions };
}

// ---------- AI 调用 ----------

async function callAI(prompt, config) {
  const { baseUrl, apiKey, model } = config;
  if (!baseUrl || !apiKey) throw new Error('请先在插件配置里填 AI 接口地址和 Key');

  const res = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
    },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `你是答题助手。严格只输出 JSON：{"answer":"答案字母","reason":"简要解析"}。单选填一个字母，多选填字母升序（如"ABD"），判断填"A"或"B"。`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
    }),
  });

  if (!res.ok) throw new Error('AI 接口返回 ' + res.status);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 无返回');

  // 解析 JSON
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI 返回格式异常');
  return JSON.parse(match[0]);
}

function buildPrompt(q) {
  const typeLabel = TYPE_LABELS[q.type] || '题目';
  const opts = q.options.map((o, i) => `${o.letter || LABELS[i]}. ${o.text}`).join('\n');
  return `[#1] (${typeLabel})\n${q.stem}\n${opts}`;
}

// ---------- 悬浮窗 ----------

let floatEl = null;

function createFloat() {
  if (floatEl) return floatEl;

  floatEl = document.createElement('div');
  floatEl.id = 'zhs-assistant-float';
  floatEl.style.cssText = `
    position: fixed; top: 80px; right: 20px; width: 300px; max-height: 400px;
    background: #1e1e2e; color: #cdd6f4; border-radius: 12px; padding: 16px;
    font: 13px/1.6 "Microsoft YaHei", sans-serif; z-index: 999999;
    box-shadow: 0 8px 32px rgba(0,0,0,.4); overflow-y: auto;
    border: 1px solid #45475a;
  `;

  floatEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong style="color:#89b4fa;">答题助手</strong>
      <button id="zhs-close" style="background:none;border:none;color:#a6adc8;cursor:pointer;font-size:18px;">×</button>
    </div>
    <div id="zhs-content" style="font-size:12px;color:#a6adc8;">
      点击「扫描」识别当前页面题目
    </div>
    <div style="display:flex;gap:6px;margin-top:10px;">
      <button id="zhs-scan" style="flex:1;padding:6px;background:#89b4fa;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;">扫描</button>
      <button id="zhs-answer" style="flex:1;padding:6px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;">答案</button>
      <button id="zhs-apply" style="flex:1;padding:6px;background:#f38ba8;color:#1e1e2e;border:none;border-radius:4px;cursor:pointer;">回填</button>
    </div>
  `;

  document.body.appendChild(floatEl);

  // 拖拽
  let isDown = false, startX, startY, startLeft, startTop;
  floatEl.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;
    isDown = true;
    startX = e.clientX; startY = e.clientY;
    startLeft = floatEl.offsetLeft; startTop = floatEl.offsetTop;
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    floatEl.style.left = startLeft + (e.clientX - startX) + 'px';
    floatEl.style.top = startTop + (e.clientY - startY) + 'px';
    floatEl.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => isDown = false);

  floatEl.querySelector('#zhs-close').addEventListener('click', () => {
    floatEl.remove();
    floatEl = null;
  });

  return floatEl;
}

function updateFloat(html) {
  const el = createFloat();
  el.querySelector('#zhs-content').innerHTML = html;
}

function toggleFloat() {
  if (floatEl) { floatEl.remove(); floatEl = null; }
  else createFloat();
}

// ---------- 状态 ----------

let scannedQuestions = [];
let answers = [];

// ---------- 消息处理 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'SCAN': {
        const { questions } = readQuestions();
        scannedQuestions = questions;
        if (!questions.length) {
          sendResponse({ ok: false, note: '未找到题目（请在作业或视频弹题页面使用）' });
          return;
        }
        updateFloat(`<p>已扫描 ${questions.length} 道题</p>` +
          questions.slice(0, 3).map((q, i) =>
            `<p>${i + 1}. ${q.stem.slice(0, 30)}${q.stem.length > 30 ? '…' : ''}</p>`
          ).join(''));
        sendResponse({ ok: true, count: questions.length });
        return;
      }

      case 'ANSWER': {
        if (!scannedQuestions.length) {
          sendResponse({ ok: false, note: '请先扫描题目' });
          return;
        }
        const cfg = msg.config || {};
        answers = [];
        try {
          for (const q of scannedQuestions) {
            const prompt = buildPrompt(q);
            const res = await callAI(prompt, cfg);
            answers.push({ question: q, answer: res.answer || '', reason: res.reason || '' });
          }
          const first = answers[0];
          updateFloat(
            `<p style="color:#a6e3a1;font-size:14px;">答案：${first.answer}</p>` +
            `<p style="color:#a6adc8;">${first.reason}</p>` +
            (answers.length > 1 ? `<p>…共 ${answers.length} 题</p>` : '')
          );
          sendResponse({ ok: true, count: answers.length, preview: first.answer });
        } catch (e) {
          sendResponse({ ok: false, note: e.message });
        }
        return;
      }

      case 'APPLY': {
        if (!answers.length) {
          sendResponse({ ok: false, note: '请先获取答案' });
          return;
        }
        let applied = 0;
        for (const { question: q, answer } of answers) {
          if (!answer) continue;
          const indexes = q.type === 'judge'
            ? q.options.map((o, i) => judgeValue(o.text) === (answer === 'A' ? 'true' : 'false') ? i : -1).filter(i => i >= 0)
            : lettersToIndexes(answer, q.options.length);

          // 模拟人类点击
          for (const idx of indexes) {
            const opt = q.options[idx];
            if (!opt) continue;
            const lab = q.element.querySelectorAll('.nodeLab')[idx] ||
                        q.element.querySelectorAll('.topic-item')[idx];
            if (!lab) continue;
            const label = lab.querySelector('.label') || lab;
            label.click();
            await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
            applied++;
          }
        }
        updateFloat(`<p style="color:#a6e3a1;">已回填 ${applied} 个选项</p><p>请检查页面，确认无误后手动提交</p>`);
        sendResponse({ ok: true, count: applied });
        return;
      }

      case 'TOGGLE_FLOAT':
        toggleFloat();
        sendResponse({ ok: true });
        return;

      case 'GET_STATE':
        sendResponse({ scanned: scannedQuestions.length > 0 });
        return;
    }
  })();
  return true; // 异步响应
});

// 自动扫描（如果配置开启）
(async () => {
  const cfg = await chrome.storage.sync.get('zhs-assistant-config');
  if (cfg['zhs-assistant-config']?.autoScan) {
    const { questions } = readQuestions();
    if (questions.length) {
      scannedQuestions = questions;
      updateFloat(`<p>自动扫描：发现 ${questions.length} 道题</p>`);
    }
  }
})();
