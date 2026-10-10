// popup.js —— 插件弹出窗逻辑
// 负责：配置管理、与 content script 通信、触发扫描/作答/回填

const $ = (id) => document.getElementById(id);
const status = $('status');

// ---------- 配置持久化 ----------
const CFG_KEY = 'zhs-assistant-config';

async function loadConfig() {
  const cfg = await chrome.storage.sync.get(CFG_KEY);
  const c = cfg[CFG_KEY] || {};
  $('cfg-baseUrl').value = c.baseUrl || '';
  $('cfg-apiKey').value = c.apiKey || '';
  $('cfg-model').value = c.model || '';
  $('cfg-auto').checked = c.autoScan || false;
}

async function saveConfig() {
  const c = {
    baseUrl: $('cfg-baseUrl').value.trim(),
    apiKey: $('cfg-apiKey').value.trim(),
    model: $('cfg-model').value.trim(),
    autoScan: $('cfg-auto').checked,
  };
  await chrome.storage.sync.set({ [CFG_KEY]: c });
  return c;
}

// ---------- 与 content script 通信 ----------
async function sendToContent(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('没有活动标签页');
  return chrome.tabs.sendMessage(tab.id, msg);
}

// ---------- 状态 ----------
function setStatus(text, isError = false) {
  status.textContent = text;
  status.style.color = isError ? '#f38ba8' : '#a6adc8';
}

function setButtons({ scanned }) {
  $('btn-answer').disabled = !scanned;
  $('btn-apply').disabled = !scanned;
}

// ---------- 事件 ----------
$('btn-scan').addEventListener('click', async () => {
  try {
    setStatus('正在扫描题目…');
    await saveConfig();
    const res = await sendToContent({ type: 'SCAN' });
    if (res.ok) {
      setStatus(`发现 ${res.count} 道题`);
      setButtons({ scanned: true });
    } else {
      setStatus(res.note || '未找到题目', true);
      setButtons({ scanned: false });
    }
  } catch (e) {
    setStatus('错误：' + e.message, true);
  }
});

$('btn-answer').addEventListener('click', async () => {
  try {
    setStatus('正在获取答案…');
    const cfg = await saveConfig();
    const res = await sendToContent({ type: 'ANSWER', config: cfg });
    if (res.ok) {
      setStatus(`已获取 ${res.count} 题答案`);
      // 显示第一题答案作为预览
      if (res.preview) setStatus(`答案预览：${res.preview}`);
    } else {
      setStatus(res.note || '获取失败', true);
    }
  } catch (e) {
    setStatus('错误：' + e.message, true);
  }
});

$('btn-apply').addEventListener('click', async () => {
  try {
    setStatus('正在回填（模拟人类点击）…');
    const res = await sendToContent({ type: 'APPLY' });
    if (res.ok) {
      setStatus(`已回填 ${res.count} 题，请检查页面`);
    } else {
      setStatus(res.note || '回填失败', true);
    }
  } catch (e) {
    setStatus('错误：' + e.message, true);
  }
});

$('btn-float').addEventListener('click', async () => {
  try {
    await sendToContent({ type: 'TOGGLE_FLOAT' });
    setStatus('悬浮窗已切换');
  } catch (e) {
    setStatus('错误：' + e.message, true);
  }
});

// 初始化
loadConfig();
sendToContent({ type: 'GET_STATE' }).then((res) => {
  if (res?.scanned) setButtons({ scanned: true });
}).catch(() => {});
