// watch-course.mjs —— 全自动看课（视频 + 弹题）
//
// 实测要点：
//   · 视频页 https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId={secret}
//   · 平台有脚本风控：JS 调 play() / 设 playbackRate 会立刻弹「检测到异常脚本」并踢回首页，
//     所以播放和倍速只能用真实鼠标点 UI；仅 muted 是安全的
//   · 播放：真实点击 .video-js 中央；倍速：.speedBox → .speedTab15 / .speedTab10 / .speedTab05
//     （平台最高 1.5x，控制条 3 秒后自动隐藏，必须快速坐标点击）
//   · 课节目录：li.video（.hour 编号 / .catalogue_title 标题 / .time 时长）
//   · 切换课节会调 learning/prelearningNote，data.studiedLessonDto.studyTotalTime 是平台进度，
//     watchState=1 表示已看完（实测 1.1 为 575s/593s, watchState=1）
//   · 弹题由 popupAnswer/lessonPopupExam 返回，questionOptions[].result==="1" 即正确项
//   · 远距离向前拖拽会触发页面导航（实测 currentTime=1374 直接把上下文干掉），
//     所以这里只做自然播放，不 seek
//
// 用法：
//   node src\flows\watch-course.mjs                      # 三门课全部，自动播完
//   node src\flows\watch-course.mjs --dry                # 只列课节，不播放
//   node src\flows\watch-course.mjs --course 国家安全教育  # 只刷一门课
//   node src\flows\watch-course.mjs --lesson 1.3         # 只播编号/标题包含 1.3 的课节
//   node src\flows\watch-course.mjs --from 2.1 --max 3   # 从 2.1 起播 3 节
//   node src\flows\watch-course.mjs --rate 1.25          # 倍速（默认 1.5，上限 1.5）
//   node src\flows\watch-course.mjs --minutes 90         # 最多跑 90 分钟后收手
//   node src\flows\watch-course.mjs --face-wait 15       # 人脸识别最多等待的分钟数（默认 15）
//   node src\flows\watch-course.mjs --no-ai              # 弹题不用 AI 兜底
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect, tidy } from '../core/browser.mjs';
import { DATA_DIR, writeJson } from '../core/store.mjs';
import { humanClick } from '../core/login-flow.mjs';
import { normalize, judgeValue, buildLivePrompt, parseAiAnswer } from './answer-engine.mjs';
import { mergeConfig, configFromEnv, pickReason } from '../../md-ai-answer/src/config.mjs';
import { createClient } from '../../md-ai-answer/src/ai.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const EXPORT = DATA_DIR;
const OUT = join(ROOT, 'recon', 'apply');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const getArg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const has = (n) => argv.includes(n);

const DRY = has('--dry');
const USE_AI = !has('--no-ai');
const KEEP_TABS = has('--no-tidy');
const COURSE = getArg('--course');
const LESSON = getArg('--lesson');
const FROM = getArg('--from');
const MAX = Number(getArg('--max', '0')) || 0;
const MAX_MINUTES = Number(getArg('--minutes', '0')) || 0;
const RATE = Math.min(1.5, Math.max(1, Number(getArg('--rate', '1.5')) || 1.5));
const FACE_WAIT_MS = Math.max(1, Number(getArg('--face-wait', '15')) || 15) * 60_000;

const log = (m = '') => process.stdout.write(m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const stamp = (m) => log(`[${now()}] ${m}`);
const clean = (s) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
  .replace(/\s+/g, ' ').trim();
const hms = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:` : '') + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
};

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/* ═══════════════════════ 题库 / AI 兜底 ═══════════════════════ */

function loadAnswerBank() {
  const preferred = join(EXPORT, '智慧树作业题库_打印版.answers.json');
  const file = existsSync(preferred) ? preferred : null;
  const map = new Map();
  if (!file) return map;
  const json = readJson(file, { questions: [] });
  for (const q of json.questions || []) {
    const stem = String(q.stem || '').replace(/［[^］]*］\s*$/, '').replace(/\[[^\]]*\]\s*$/, '');
    const k = normalize(stem);
    if (k && !map.has(k)) map.set(k, q);
  }
  return map;
}

function makeAi() {
  if (!USE_AI) return null;
  try {
    const cfg = mergeConfig(readJson(join(ROOT, 'md-ai-answer', 'config.json'), {}), configFromEnv(process.env));
    const r = pickReason(cfg);
    if (!r.baseUrl || !r.apiKey) return null;
    return {
      client: createClient({ baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, timeoutMs: cfg.timeoutMs, maxRetries: cfg.maxRetries }),
      model: r.model,
    };
  } catch { return null; }
}

/* ═══════════════════════ 页面读取 ═══════════════════════ */

const READ_LESSONS = () => {
  const c = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('li.video')].map((li, i) => ({
    i,
    no: c(li.querySelector('.hour')?.innerText || ''),
    title: c(li.querySelector('.catalogue_title')?.getAttribute('title') || li.querySelector('.catalogue_title')?.innerText || ''),
    time: c(li.querySelector('.time')?.innerText || ''),
    current: li.classList.contains('current_play'),
  }));
};

const READ_CURRENT = () => {
  const list = [...document.querySelectorAll('li.video')];
  return list.findIndex((li) => li.classList.contains('current_play'));
};

const READ_VIDEO = () => {
  const v = document.querySelector('video.vjs-tech') || document.querySelector('video');
  if (!v) return null;
  return {
    t: Number(v.currentTime) || 0,
    d: Number.isFinite(v.duration) ? v.duration : 0,
    paused: !!v.paused,
    ended: !!v.ended,
    rate: Number(v.playbackRate) || 1,
    muted: !!v.muted,
    rs: v.readyState,
    src: String(v.currentSrc || v.src || '').split('/').pop().slice(0, 80),
  };
};

const READ_POPUP_TIPS = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const pick = (sel) => [...document.querySelectorAll(sel)].some(vis);
  const msgBox = [...document.querySelectorAll('.el-message-box__wrapper')].find(vis);
  const msg = msgBox ? (msgBox.innerText || '').replace(/\s+/g, ' ').trim() : '';
  const faceRe = /人脸识别|请完成人脸|人脸验证/;
  const faceBox = [...document.querySelectorAll('.el-dialog__wrapper, .el-dialog, .el-message-box, .face-recognition, .face-box, .face-wrap, .face-dialog, .face-verify')]
    .some((el) => vis(el) && faceRe.test(el.innerText || ''));
  const v = [...document.querySelectorAll('video')].find(vis);
  return {
    exploreTip: pick('.exploreTip'),
    dialogRead: pick('.dialog-read'),
    ai: pick('.ai-close-icon'),
    scriptWarn: /异常脚本|关闭插件/.test(msg) ? msg.slice(0, 120) : '',
    // 只在「可见的人脸弹框」或「页面提到人脸且视频已暂停」时判定，避免页面说明文字误触发
    face: faceBox || (faceRe.test(document.body?.innerText || '') && !!v && v.paused),
    limit: /学习时间已达上限|今日学习时间已|学习时间已用完|学习时间已达今日/.test(document.body?.innerText || ''),
  };
};

const READ_QUIZ = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const dlg = [...document.querySelectorAll('.el-dialog__wrapper.dialog-test')].find(vis);
  if (!dlg) return null;
  const c = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const titleEl = dlg.querySelector('.topic-title');
  const title = c(titleEl?.innerText || '');
  const opts = [...dlg.querySelectorAll('.topic-list > li.topic-item')].map((li, i) => ({
    i,
    letter: c(li.querySelector('.topic-option-item')?.innerText || '').replace(/[.\s]/g, ''),
    text: c(li.querySelector('.item-topic')?.innerText || ''),
  }));
  const pager = [...dlg.querySelectorAll('.el-pager li.number')];
  const active = pager.findIndex((n) => /active/.test(n.className));
  const next = dlg.querySelector('.el-pagination .btn-next');
  const pagerVisible = pager.length > 1 && pager.some(vis);
  return {
    title,
    opts,
    pages: pager.length,
    page: active >= 0 ? active + 1 : 1,
    hasNext: pagerVisible && !!next && !next.disabled,
  };
};

/* ═══════════════════════ 小工具 ═══════════════════════ */

/** 按选择器找可见元素，用真实鼠标点它的中心（DOM .click() 会触发风控） */
async function clickSelector(page, sel) {
  const pt = await page.evaluate((s) => {
    const el = [...document.querySelectorAll(s)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, sel).catch(() => null);
  if (!pt) return false;
  await clickPoint(page, pt);
  return true;
}

async function dialogReadOpen(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.dialog-read');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).catch(() => false);
}

async function dismissTips(page) {
  let closed = 0;
  for (let i = 0; i < 6; i++) {
    const tips = await page.evaluate(READ_POPUP_TIPS).catch(() => null);
    if (!tips) break;
    let acted = false;
    if (tips.dialogRead) {
      // 「学前必读」是全屏遮罩，不关掉后面所有课节点击都会被拦截
      if (await clickSelector(page, '.dialog-read .iconguanbi')) { acted = true; closed++; }
      await sleep(400);
    }
    if (tips.exploreTip) {
      if (await clickSelector(page, '.exploreTip .hint_delete a, .exploreTip .hint_delete')) { acted = true; closed++; }
      await sleep(300);
    }
    if (tips.ai) {
      if (await clickSelector(page, '.ai-close-icon')) { acted = true; closed++; }
      await sleep(300);
    }
    if (!acted) break;
    await sleep(500);
  }
  return closed;
}

/** 点课节：先清遮罩/弹题 → 真实坐标点击标题 → 用 current_play 校验，最多重试 3 次 */
async function clickLesson(page, idx, clearBlockers = null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await page.evaluate(READ_CURRENT).catch(() => -1);
    if (cur === idx) return true;

    // 弹题对话框是全屏遮罩，会挡住所有课节点击
    if (clearBlockers) await clearBlockers().catch(() => {});
    await dismissTips(page);
    if (await dialogReadOpen(page)) {
      await sleep(600);
      await dismissTips(page);
    }

    const pt = await page.evaluate((i) => {
      const li = document.querySelectorAll('li.video')[i];
      if (!li) return null;
      const el = li.querySelector('.catalogue_title') || li;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.x + Math.min(r.width / 2, 160), y: r.y + r.height / 2 };
    }, idx).catch(() => null);
    if (!pt) return false;

    await clickPoint(page, pt);
    await sleep(1400);
    if (await page.evaluate(READ_CURRENT).catch(() => -1) === idx) return true;
    await sleep(800);
  }
  return (await page.evaluate(READ_CURRENT).catch(() => -1)) === idx;
}

async function waitVideoReady(page, timeout = 20000, lesson = null, clearBlockers = null) {
  const t0 = Date.now();
  let nudged = 0;
  while (Date.now() - t0 < timeout) {
    const v = await page.evaluate(READ_VIDEO).catch(() => null);
    if (v && v.d > 0 && v.rs >= 1) return v;
    if (lesson && nudged < 2 && Date.now() - t0 > 7000 * (nudged + 1)) {
      nudged++;
      await clickLesson(page, lesson.i, clearBlockers).catch(() => {});
      await dismissTips(page).catch(() => {});
    }
    await sleep(600);
  }
  return await page.evaluate(READ_VIDEO).catch(() => null);
}

/** 真实鼠标坐标点击（humanClick 在不可见元素上会等 30s，控制条 3s 就隐藏了） */
async function clickPoint(page, pt) {
  await page.mouse.move(pt.x, pt.y, { steps: 4 }).catch(() => {});
  await sleep(60);
  await page.mouse.down().catch(() => {});
  await sleep(90 + Math.random() * 80);
  await page.mouse.up().catch(() => {});
  await sleep(150);
}

/** 播放器可见区域中心点 */
async function playerPoint(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.video-js') || document.querySelector('video.vjs-tech');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }).catch(() => null);
}

/** 只做安全的静音（实测 JS 改 muted 不触发风控） */
async function muteVideo(page) {
  await page.evaluate(() => {
    document.querySelectorAll('video,audio').forEach((v) => {
      v.muted = true;
      try { v.volume = 0; } catch { /* 忽略 */ }
    });
  }).catch(() => {});
}

/**
 * 常驻静音守卫：切换课节会重建播放器、站点也可能自己取消静音，
 * 这里监听 play / volumechange 和新节点，统一压回 muted（默认静音看课）。
 */
function muteGuard() {
  if (window.__zhsMuteGuard) return;
  window.__zhsMuteGuard = true;
  const mute = (el) => {
    if (!el || !('muted' in el)) return;
    if (!el.muted) el.muted = true;
    if (el.volume !== 0) { try { el.volume = 0; } catch { /* 忽略 */ } }
  };
  const all = () => document.querySelectorAll('video,audio').forEach(mute);
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; all(); }, 150);
  };
  document.addEventListener('play', (e) => mute(e.target), true);
  document.addEventListener('volumechange', (e) => mute(e.target), true);
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  all();
}

async function installMuteGuard(page) {
  await page.evaluate(muteGuard).catch(() => {});
}

/** 用真实点击开始/恢复播放；禁止 JS play() */
async function ensurePlaying(page, tries = 3) {
  await installMuteGuard(page);
  let st = await page.evaluate(READ_VIDEO).catch(() => null);
  if (st && !st.paused && !st.ended) return st;
  await muteVideo(page);
  for (let i = 0; i < tries; i++) {
    const pt = await playerPoint(page);
    if (!pt) { await sleep(1200); continue; }
    await clickPoint(page, pt);
    await sleep(1300);
    st = await page.evaluate(READ_VIDEO).catch(() => null);
    if (st && !st.paused) return st;
  }
  return await page.evaluate(READ_VIDEO).catch(() => null);
}

/** 点 UI 切倍速：.speedBox → 对应 .speedTab；平台只有 1.5 / 1.0 / 0.5 三档 */
async function setSpeed(page, rate) {
  const want = rate >= 1.25 ? 1.5 : (rate >= 0.75 ? 1.0 : 0.5);
  let st = await page.evaluate(READ_VIDEO).catch(() => null);
  if (!st) return false;
  if (Math.abs(st.rate - want) < 0.05) return true;

  const tabSel = want === 1.5 ? '.speedTab.speedTab15' : (want === 1.0 ? '.speedTab.speedTab10' : '.speedTab.speedTab05');
  for (let i = 0; i < 3; i++) {
    // 让控制条显示出来
    const pp = await playerPoint(page);
    if (pp) await page.mouse.move(pp.x, pp.y, { steps: 5 }).catch(() => {});
    await sleep(300);

    const boxPt = await page.evaluate(() => {
      const el = document.querySelector('.speedBox');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }).catch(() => null);
    if (!boxPt) { await sleep(800); continue; }

    await clickPoint(page, boxPt);
    await sleep(250);

    const tabPt = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
    }, tabSel).catch(() => null);
    if (!tabPt) { await sleep(800); continue; }

    await clickPoint(page, tabPt);
    await sleep(900);

    st = await page.evaluate(READ_VIDEO).catch(() => null);
    if (st && Math.abs(st.rate - want) < 0.05) {
      stamp(`  ⏩ 倍速已切至 ${st.rate}x`);
      return true;
    }
  }
  return false;
}

/** 播放器短暂消失：等待重建 + 重新点课节 + 真实点击恢复播放 */
async function recoverPlayer(page, lesson, clearBlockers = null) {
  for (let i = 0; i < 8; i++) {
    const st = await page.evaluate(READ_VIDEO).catch(() => null);
    if (st) {
      if (st.paused) await ensurePlaying(page, 2);
      return await page.evaluate(READ_VIDEO).catch(() => st);
    }
    if (i === 2 || i === 5) {
      stamp('    ↻ 重新点击课节，等待播放器重建');
      await clickLesson(page, lesson.i, clearBlockers).catch(() => {});
      await dismissTips(page).catch(() => {});
    }
    await sleep(1500);
  }
  return null;
}

/* ═══════════════════════ 弹题 ═══════════════════════ */

/** 从接口返回里挑出与当前题面匹配的那道题 */
function matchPayloadQuestion(payload, title) {
  const stem = normalize(String(title || '').replace(/^\s*\d+\s*/, '').replace(/【[^】]*】/g, ''));
  if (!stem) return null;
  let best = null;
  for (const it of payload || []) {
    const q = it?.testQuestion;
    if (!q) continue;
    const n = normalize(q.name);
    if (!n) continue;
    if (n === stem) return q;
    if (n.includes(stem) || stem.includes(n)) {
      if (!best) best = q;
    }
  }
  return best;
}

/** 题库 / AI 兜底：返回应选的选项正文数组 */
async function fallbackAnswers(ai, bank, title, opts) {
  const stem = String(title || '').replace(/^\s*\d+\s*/, '').replace(/【[^】]*】/g, '').trim();
  const entry = bank.get(normalize(stem));
  if (entry?.answer) {
    const letters = String(entry.answer).toUpperCase().replace(/[^A-Z]/g, '');
    // 题库里 options 是 [{key,text}]；兼容早期的纯字符串数组
    const texts = [];
    for (const ch of letters) {
      const opt = (entry.options || []).find((o) => String(o?.key ?? '').toUpperCase() === ch)
        ?? (entry.options || [])[ch.charCodeAt(0) - 65];
      const text = typeof opt === 'string' ? opt : (opt?.text ?? '');
      if (text) texts.push(clean(text));
    }
    if (texts.length) return { texts, source: '题库' };
  }
  if (!ai) return { texts: [], source: '' };
  try {
    const type = /多选/.test(title) ? 'multiple' : (/判断/.test(title) ? 'judge' : 'single');
    const content = await ai.client.chat(buildLivePrompt({ stem, type, options: opts.map((o) => ({ text: o.text })) }));
    const parsed = parseAiAnswer(content, opts.length, opts);
    if (parsed?.ok) {
      return { texts: parsed.indexes.map((i) => opts[i]?.text).filter(Boolean), source: 'AI' };
    }
  } catch (e) {
    stamp(`    ⚠️ AI 兜底失败：${String(e).slice(0, 80)}`);
  }
  return { texts: [], source: '' };
}

async function answerOneQuizPage(page, payload, ai, bank) {
  const st = await page.evaluate(READ_QUIZ).catch(() => null);
  if (!st) return false;

  const q = matchPayloadQuestion(payload, st.title);
  let wanted = [];
  let source = '';
  if (q) {
    wanted = (q.questionOptions || [])
      .filter((o) => String(o.result) === '1')
      .map((o) => clean(o.content))
      .filter(Boolean);
    source = '接口';
  }
  if (!wanted.length) {
    const fb = await fallbackAnswers(ai, bank, st.title, st.opts);
    wanted = fb.texts;
    source = fb.source;
  }

  const idxs = [];
  for (const w of wanted) {
    const n = normalize(w);
    let i = st.opts.findIndex((o) => normalize(o.text) === n);
    // 判断题的「正确/对/√」写法不统一，正文没命中时按语义再匹配一次
    if (i < 0 && st.opts.length === 2) {
      const v = judgeValue(w);
      if (v) i = st.opts.findIndex((o) => judgeValue(o.text) === v);
    }
    if (i >= 0 && !idxs.includes(i)) idxs.push(i);
  }

  if (!idxs.length) {
    stamp(`    ⚠️ 弹题无答案：「${st.title.slice(0, 40)}」，直接关闭`);
    return false;
  }

  const items = page.locator('.el-dialog__wrapper.dialog-test:visible .topic-list > li.topic-item');
  for (const i of idxs) {
    await humanClick(page, items.nth(i)).catch(() => {});
    await sleep(450 + Math.random() * 350);
  }
  stamp(`    ✓ 弹题（${source}）：${st.title.slice(0, 34)} → ${idxs.map((i) => st.opts[i]?.letter || i + 1).join('')}`);
  return true;
}

async function closeQuiz(page) {
  for (let i = 0; i < 3; i++) {
    const still = await page.evaluate(READ_QUIZ).catch(() => null);
    if (!still) return true;
    const x = page.locator('.el-dialog__wrapper.dialog-test:visible .el-dialog__headerbtn').first();
    if (await x.count()) {
      await humanClick(page, x).catch(() => {});
      await sleep(800);
      if (!await page.evaluate(READ_QUIZ).catch(() => null)) return true;
    }
    const closeTxt = page.locator('.el-dialog__wrapper.dialog-test').getByText('关闭', { exact: true }).last();
    if (await closeTxt.count()) {
      await humanClick(page, closeTxt).catch(() => {});
      await sleep(800);
      if (!await page.evaluate(READ_QUIZ).catch(() => null)) return true;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(700);
    // 兜底：点对话框旁边的遮罩区域关闭（不碰页面左上角导航）
    const out = await page.evaluate(() => {
      const dlg = document.querySelector('.el-dialog__wrapper.dialog-test .el-dialog');
      if (!dlg) return null;
      const r = dlg.getBoundingClientRect();
      const x = r.right + 40 < innerWidth ? r.right + 40 : Math.max(10, r.left - 40);
      return { x, y: Math.min(innerHeight - 20, Math.max(20, r.top + 40)) };
    }).catch(() => null);
    if (out) await clickPoint(page, out);
    await sleep(700);
  }
  return !await page.evaluate(READ_QUIZ).catch(() => null);
}

/** 处理整个弹题对话框（可能有多题分页） */
async function handleQuiz(page, net, ai, bank) {
  const fresh = net.quiz && Date.now() - net.quizAt < 5 * 60 * 1000 ? net.quiz : null;
  for (let pageNo = 0; pageNo < 40; pageNo++) {
    const st = await page.evaluate(READ_QUIZ).catch(() => null);
    if (!st) break;
    await answerOneQuizPage(page, fresh, ai, bank);
    if (!st.hasNext) break;
    const next = page.locator('.el-dialog__wrapper.dialog-test:visible .el-pagination .btn-next').first();
    const before = st.page;
    await humanClick(page, next).catch(() => {});
    await sleep(900);
    const after = await page.evaluate(READ_QUIZ).catch(() => null);
    if (!after || after.page === before) break;
  }
  const closed = await closeQuiz(page);
  net.quiz = null;
  return closed;
}

/* ═══════════════════════ 单节课 ═══════════════════════ */

async function watchLesson(page, net, lesson, opts) {
  const { ai, bank, rate, deadline } = opts;
  const tag = `${lesson.no} ${lesson.title}`.trim();
  const res = {
    no: lesson.no, title: lesson.title, time: lesson.time,
    status: 'skipped', score: null, seconds: 0, duration: 0, quizzes: 0, note: '',
  };

  // 弹题对话框会挡住课节点击，切课前先答掉
  const clearBlockers = async () => {
    const q = await page.evaluate(READ_QUIZ).catch(() => null);
    if (!q) return;
    stamp(`  ❓ 弹题挡住课节，先作答（第 ${q.page}/${q.pages} 页）`);
    await handleQuiz(page, net, ai, bank);
    res.quizzes++;
  };

  stamp(`\n▶ ${tag}（${lesson.time || '?'}）`);
  const before = await page.evaluate(READ_VIDEO).catch(() => null);
  const prevCur = await page.evaluate(READ_CURRENT).catch(() => -1);
  const switched = await clickLesson(page, lesson.i, clearBlockers);
  if (!switched) {
    res.status = 'error';
    res.note = '课节未能切换（可能未解锁）';
    stamp(`  ⚠️ ${res.note}，跳过`);
    return res;
  }

  await dismissTips(page);
  await sleep(800);

  // 切换课节时平台会返回该课节的真实进度
  let studied = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (net.prelearning && Date.now() - net.prelearningAt < 10000) { studied = net.prelearning; break; }
    await sleep(400);
  }

  let v = await waitVideoReady(page, 25000, lesson, clearBlockers);
  if (!v) {
    // 兜底：整页重载后重试一次
    stamp('  ⚠️ 播放器未就绪，重载页面后重试');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 30; i++) {
      const n = await page.evaluate(() => document.querySelectorAll('li.video').length).catch(() => 0);
      if (n > 0) break;
      await sleep(1000);
    }
    await dismissTips(page);
    await clickLesson(page, lesson.i, clearBlockers).catch(() => {});
    v = await waitVideoReady(page, 25000, lesson, clearBlockers);
  }
  if (!v) {
    res.status = 'error';
    res.note = '播放器未就绪';
    stamp('  ⚠️ 播放器未就绪，跳过');
    return res;
  }

  // 刚切课节时可能还读到上一节的播放器状态，等真正换源/重置
  let stale = false;
  if (prevCur !== lesson.i && before?.src && v.src === before.src) {
    stale = true;
    for (let i = 0; i < 20; i++) {
      await sleep(600);
      const nv = await page.evaluate(READ_VIDEO).catch(() => null);
      if (!nv) continue;
      if ((nv.src && nv.src !== before.src) || (nv.t < nv.d - 5 && !nv.ended)) {
        v = nv;
        stale = false;
        break;
      }
    }
    if (stale) stamp('  ⚠️ 视频源未切换，忽略旧播放器状态');
  }
  res.duration = v.d;

  const total = Number(studied?.studyTotalTime) || 0;
  const watchState = studied?.watchState ?? null;
  const pct = v.d > 0 ? total / v.d : 0;
  stamp(`  平台进度 ${hms(total)} / ${hms(v.d)}（${(pct * 100).toFixed(1)}%） watchState=${watchState ?? '?'}`);

  const doneByApi = watchState === 1 || (v.d > 0 && total >= v.d - 5);
  const doneByVideo = !stale && v.d > 0 && v.t >= v.d - 1.5;
  if (doneByApi || doneByVideo) {
    res.status = 'done';
    res.seconds = total || v.t;
    res.score = v.d > 0 ? Number((Math.max(total, v.t) / v.d * 100).toFixed(1)) : null;
    stamp('  ✓ 已看完，跳过');
    return res;
  }

  // 从平台记录的位置继续（全部真实鼠标操作，禁止 JS play / playbackRate）
  await muteVideo(page);
  await ensurePlaying(page);
  await setSpeed(page, rate);
  await sleep(1200);

  let lastT = (await page.evaluate(READ_VIDEO).catch(() => null))?.t ?? v.t;
  let lastMove = Date.now();
  let stallRounds = 0;
  let lastLog = 0;
  let faceSince = 0;
  let faceLastLog = 0;
  let finished = false;
  let lastSeen = v;
  // 单节超时：按「剩余时长 / 实际倍速」估算，再加 4 分钟余量（留给弹题、人脸识别、播放器重建）
  const remains = Math.max(0, (Number.isFinite(v.d) ? v.d : 0) - (Number.isFinite(v.t) ? v.t : 0));
  const effRate = Math.max(0.5, Math.max(v.rate || 1, rate));
  let limitMs = Math.max(60_000, ((remains / effRate) + 240) * 1000);
  const loopStart = Date.now();

  while (true) {
    // 超时检查放在循环顶部：弹题/人脸分支的 continue 也要能命中
    if (Date.now() - loopStart > limitMs) {
      res.note = '单节超时';
      res.status = 'error';
      break;
    }
    if (deadline && Date.now() > deadline) {
      res.note = '达到 --minutes 时限';
      res.status = 'paused';
      break;
    }

    await sleep(2000);
    await dismissTips(page);

    const quiz = await page.evaluate(READ_QUIZ).catch(() => null);
    if (quiz) {
      stamp(`  ❓ 弹题出现（第 ${quiz.page}/${quiz.pages} 页）`);
      await handleQuiz(page, net, ai, bank);
      res.quizzes++;
      await ensurePlaying(page);
      lastMove = Date.now();
      continue;
    }

    const tips = await page.evaluate(READ_POPUP_TIPS).catch(() => null);
    if (tips?.scriptWarn) {
      res.status = 'blocked';
      res.note = `平台风控：${tips.scriptWarn.slice(0, 60)}`;
      stamp(`  ⛔ ${res.note}`);
      break;
    }
    if (tips?.face) {
      if (!faceSince) {
        faceSince = Date.now();
        faceLastLog = Date.now();
        stamp('  ⚠️ 平台要求人脸识别：请在浏览器窗口里完成，完成后会自动继续播放');
      } else if (Date.now() - faceSince > FACE_WAIT_MS) {
        res.status = 'blocked';
        res.note = '等待人脸识别超时';
        stamp('  ⛔ 等待人脸识别超时，停止');
        break;
      } else if (Date.now() - faceLastLog > 30_000) {
        faceLastLog = Date.now();
        stamp(`  … 仍在等待人脸识别（已等 ${Math.round((Date.now() - faceSince) / 1000)} 秒，完成后自动继续）`);
      }
      await sleep(3000);
      continue;
    }
    if (faceSince) {
      limitMs += Date.now() - faceSince;
      faceSince = 0;
      stamp('  ✓ 人脸识别已完成，继续播放');
      await ensurePlaying(page);
      await setSpeed(page, rate);
      lastMove = Date.now();
    }
    if (tips?.limit) { res.status = 'blocked'; res.note = '平台提示学习时间已达上限'; break; }
    if (!page.url().includes('studyvideoh5')) {
      res.status = 'blocked';
      res.note = '被平台踢回首页（风控）';
      stamp('  ⛔ 页面已跳转离开学习页，停止');
      break;
    }

    let st = await page.evaluate(READ_VIDEO).catch(() => null);
    if (!st) {
      // 播放器重建：等待并尝试恢复，而不是直接放弃
      stamp('  ⚠️ 播放器暂时消失，尝试恢复');
      st = await recoverPlayer(page, lesson, clearBlockers);
      if (!st) {
        res.note = '播放器消失且无法恢复';
        break;
      }
      stamp('  ✓ 播放器已恢复');
      await setSpeed(page, rate);
      lastMove = Date.now();
    }
    lastSeen = st;

    if (st.ended || (st.d > 0 && st.t >= st.d - 1.5)) {
      finished = true;
      // 播完瞬间平台常追加弹题，处理掉再走，否则会挡住下一节
      let quiet = 0;
      for (let k = 0; k < 10; k++) {
        await sleep(1200);
        const q = await page.evaluate(READ_QUIZ).catch(() => null);
        if (q) {
          stamp(`  ❓ 播完后弹题（第 ${q.page}/${q.pages} 页）`);
          await handleQuiz(page, net, ai, bank);
          res.quizzes++;
          quiet = 0;
        } else if (++quiet >= 2) break;
      }
      break;
    }

    if (st.paused) {
      await ensurePlaying(page);
    } else if (Math.abs(st.rate - rate) > 0.05) {
      await setSpeed(page, rate);
    }

    // 进度是否在走（重建后进度可能回退，视为新的起点）
    if (st.t < lastT - 5) {
      lastT = st.t;
      lastMove = Date.now();
      stallRounds = 0;
    } else if (st.t > lastT + 0.4) {
      lastT = st.t;
      lastMove = Date.now();
      stallRounds = 0;
    } else if (Date.now() - lastMove > 45_000) {
      stallRounds++;
      stamp(`  ⚠️ 播放卡住（第 ${stallRounds} 次），重试播放`);
      await clickLesson(page, lesson.i, clearBlockers).catch(() => {});
      await sleep(1200);
      await dismissTips(page);
      await ensurePlaying(page);
      await setSpeed(page, rate);
      lastMove = Date.now();
      if (stallRounds >= 3) { res.note = '多次重试仍无法播放'; res.status = 'error'; break; }
    }

    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      const p = st.d > 0 ? (st.t / st.d * 100).toFixed(1) : '?';
      stamp(`  … ${hms(st.t)} / ${hms(st.d)}（${p}%）${st.paused ? ' 暂停中' : ''} ${st.rate.toFixed(1)}x`);
    }
  }

  const end = await page.evaluate(READ_VIDEO).catch(() => null);
  const last = end || lastSeen;
  const completed = finished || (!!end && (end.ended || (end.d > 0 && end.t >= end.d - 2)));
  res.seconds = completed ? (finished ? res.duration : (last?.t ?? lastT)) : (last?.t ?? lastT);
  res.score = res.duration > 0
    ? Number((Math.min(res.seconds, res.duration) / res.duration * 100).toFixed(1))
    : null;
  if (res.status === 'skipped') res.status = completed ? 'done' : 'partial';
  stamp(`  ■ ${res.status} ${hms(res.seconds)} / ${hms(res.duration)}${res.note ? ' · ' + res.note : ''}`);

  // 等平台把最后一次心跳写进去
  await sleep(2500);
  return res;
}

/* ═══════════════════════ 主流程 ═══════════════════════ */

stamp('══════════ 全自动看课 ══════════');
const resolved = readJson(join(EXPORT, 'courses-resolved.json'), {});
/** 缓存可能以 courseId 或课程名为 key，统一取出「显示名 + 条目」 */
const courseList = Object.entries(resolved)
  .map(([key, v]) => ({ name: v?.courseName || key, entry: v || {} }))
  .filter((c) => !COURSE || c.name.includes(COURSE));
const courses = courseList.map((c) => c.name);
if (!courses.length) {
  stamp('没有匹配的课程，检查 --course / export\\courses-resolved.json');
  process.exit(1);
}

const bank = loadAnswerBank();
const ai = DRY ? null : makeAi();

stamp(`课程: ${courses.join('、')}`);
stamp(`模式: ${DRY ? '演练（只列课节）' : `自然播放 · ${RATE}x · 自动弹题`}`);
if (ai) stamp(`AI 兜底: ${ai.model}`);

const report = { at: new Date().toISOString(), rate: RATE, courses: [], finished: false };

if (DRY) {
  const { ctx, describe, close } = await connect({
    prefer: getArg('--browser', 'chromium') === 'firefox' ? 'firefox' : 'chromium',
    exe: getArg('--browser-exe'),
  });
  stamp('浏览器: ' + describe);
  const page = ctx.pages().find((p) => p.url().includes('studyvideoh5')) ?? await ctx.newPage();
  for (const { name: course, entry } of courseList) {
    const secret = entry.secret;
    if (!secret) continue;
    const url = `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${secret}`;
    stamp(`\n── ${course}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 30; i++) {
      const n = await page.evaluate(() => document.querySelectorAll('li.video').length).catch(() => 0);
      if (n > 0) break;
      await sleep(1000);
    }
    await dismissTips(page);
    const lessons = await page.evaluate(READ_LESSONS).catch(() => []);
    stamp(`课节 ${lessons.length} 个`);
    for (const l of lessons) {
      stamp(`  ${l.current ? '▶' : ' '} ${l.no.padEnd(5)} ${l.time.padEnd(9)} ${l.title}`);
    }
  }
  await tidy(ctx).catch(() => {});
  await close();
  process.exit(0);
}

const { ctx, describe, close } = await connect({
  prefer: getArg('--browser', 'chromium') === 'firefox' ? 'firefox' : 'chromium',
  exe: getArg('--browser-exe'),
});
stamp('浏览器: ' + describe);

const page = ctx.pages().find((p) => p.url().includes('studyvideoh5')) ?? await ctx.newPage();
// 只确认预期内的提示/确认框，危险文案或 prompt 一律取消
const DIALOG_DENY_RE = /删除|清空|退出登录|注销|放弃|作废/;
page.on('dialog', (d) => {
  const msg = d.message() || '';
  const type = d.type();
  if ((type === 'alert' || type === 'confirm' || type === 'beforeunload') && !DIALOG_DENY_RE.test(msg)) d.accept().catch(() => {});
  else d.dismiss().catch(() => {});
});

// 网络旁听：切换课节的进度 + 弹题接口
const net = { prelearning: null, prelearningAt: 0, quiz: null, quizAt: 0 };
page.on('response', async (res) => {
  const u = res.url();
  if (!/prelearningNote|lessonPopupExam/.test(u)) return;
  const at = Date.now();   // 以响应到达顺序为准，避免慢响应覆盖新数据
  try {
    const j = await res.json();
    if (u.includes('prelearningNote')) {
      if (at < net.prelearningAt) return;
      net.prelearning = j?.data?.studiedLessonDto ?? null;
      net.prelearningAt = at;
    } else {
      if (at < net.quizAt) return;
      net.quiz = j?.data?.lessonTestQuestionUseInterfaceDtos ?? null;
      net.quizAt = at;
    }
  } catch { /* 非 JSON 忽略 */ }
});

const deadline = MAX_MINUTES ? Date.now() + MAX_MINUTES * 60_000 : 0;

for (const { name: course, entry } of courseList) {
  const secret = entry.secret;
  if (!secret) {
    stamp(`\n📚 ${course}`);
    stamp('  ✗ 缺少 secret，无法进入课程；请先重新抓取课程数据（zhs.mjs fetch）');
    report.courses.push({ course, url: '', error: '缺少 secret（courses-resolved.json）', lessons: [] });
    writeJson(join(OUT, 'watch-report.json'), report);
    continue;
  }

  const url = `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${secret}`;
  stamp(`\n━━━━━━━━━━━━━━━━━━━━━━`);
  stamp(`📚 ${course}`);
  stamp(`   ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await installMuteGuard(page);
  let lessons = [];
  for (let i = 0; i < 40; i++) {
    lessons = await page.evaluate(READ_LESSONS).catch(() => []);
    if (lessons.length) break;
    await sleep(1000);
  }
  if (!lessons.length) {
    stamp('  ✗ 课节列表未加载（可能未登录）');
    report.courses.push({ course, url, error: '课节列表未加载', lessons: [] });
    continue;
  }
  await page.bringToFront().catch(() => {});
  await dismissTips(page);
  stamp(`  课节 ${lessons.length} 个`);

  // 编号精确匹配优先（如 1.3），否则回退「序号 + 标题」包含匹配
  const matchLesson = (l, q) => (l.no === q ? true : `${l.no} ${l.title}`.includes(q));
  const lessonExact = LESSON && lessons.some((l) => l.no === LESSON);

  let fromIdx = -1;
  if (FROM) {
    fromIdx = lessons.findIndex((x) => x.no === FROM);
    if (fromIdx < 0) fromIdx = lessons.findIndex((x) => `${x.no} ${x.title}`.includes(FROM));
    if (fromIdx < 0) stamp(`  ⚠️ --from ${FROM} 未匹配到任何课节，按全部课节处理`);
  }
  const filtered = lessons.filter((l) => {
    if (LESSON) {
      const hit = lessonExact ? l.no === LESSON : matchLesson(l, LESSON);
      if (!hit) return false;
    }
    if (FROM && fromIdx >= 0 && l.i < fromIdx) return false;
    return true;
  });
  if (LESSON && !filtered.length) stamp(`  ⚠️ --lesson ${LESSON} 未匹配到任何课节`);
  const queue = MAX > 0 ? filtered.slice(0, MAX) : filtered;
  stamp(`  本次处理 ${queue.length} 节`);

  const courseReport = { course, url, at: new Date().toISOString(), lessons: [] };
  for (const lesson of queue) {
    if (deadline && Date.now() > deadline) {
      stamp('\n⏱ 达到 --minutes 时限，收手');
      break;
    }
    try {
      net.prelearning = null;
      const r = await watchLesson(page, net, lesson, { ai, bank, rate: RATE, deadline });
      courseReport.lessons.push(r);
    } catch (e) {
      const msg = String(e).slice(0, 200);
      stamp(`  ✗ 异常：${msg}`);
      courseReport.lessons.push({ no: lesson.no, title: lesson.title, status: 'error', note: msg });
    }
    writeJson(join(OUT, 'watch-report.json'), { ...report, courses: [...report.courses, courseReport] });
  }
  report.courses.push(courseReport);

  const done = courseReport.lessons.filter((x) => x.status === 'done').length;
  const partial = courseReport.lessons.filter((x) => /partial|paused/.test(x.status)).length;
  const err = courseReport.lessons.filter((x) => /error|blocked/.test(x.status)).length;
  stamp(`\n📊 ${course}：完成 ${done} · 未播完 ${partial} · 异常 ${err}`);
  writeJson(join(OUT, 'watch-report.json'), report);
}

report.finished = true;
writeJson(join(OUT, 'watch-report.json'), report);
stamp('\n══════════ 完成 ══════════');
stamp('报告: recon\\apply\\watch-report.json');
const badLessons = report.courses.flatMap((c) => c.lessons || [])
  .filter((l) => /^(blocked|error|partial)$/.test(l.status)).length;   // paused 是 --minutes 主动收手，不算失败
const courseErrors = report.courses.filter((c) => c.error).length;
if (!KEEP_TABS) await tidy(ctx).catch(() => {});
await close();
if (badLessons || courseErrors) {
  stamp(`⚠️ 有 ${badLessons} 节未完成${courseErrors ? `，${courseErrors} 门课程异常` : ''}`);
  process.exit(1);
}
process.exit(0);
