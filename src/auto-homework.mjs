// auto-homework.mjs —— 全自动作业答题（打开页面 → 作答 → 提交）
//
// 关键事实（实测）：
//   · 作业页一次只显示一题，但所有题的 DOM 都在；题号锚点 anchor_<eid> 与
//     papers.json 的 eid 对应（eid 去掉 + / = 等非字母数字字符）。
//   · .subject_describe 的文本节点为空（动态字体），所以不读页面题干，
//     直接用 eid 反查题库题干，再用 papers.json 的选项正文匹配页面随机选项。
//   · 「下一题」会保存当前题；最后一题先「暂存作业」再「提交作业」。
//
// 用法：
//   node src\auto-homework.mjs                      # 全部未提交作业，自动作答并提交
//   node src\auto-homework.mjs --dry                # 只列出计划，不动页面
//   node src\auto-homework.mjs --course 国家安全教育  # 只做一门课
//   node src\auto-homework.mjs --exam 第三章         # 只做名称包含「第三章」的作业
//   node src\auto-homework.mjs --limit 1            # 只做 1 份
//   node src\auto-homework.mjs --no-submit          # 作答但不提交
//   node src\auto-homework.mjs --delay 400          # 操作间隔基数(ms)
//   node src\auto-homework.mjs --force              # 有未解析题也提交
//   node src\auto-homework.mjs --no-rethink         # 提交后不回顾错题
//   node src\auto-homework.mjs --no-redo            # 错题只重新思考，不申请重做
//   node src\auto-homework.mjs --attempts 2         # 最多作答轮数（含首次，默认 2）
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect, tidy } from './browser.mjs';
import { humanClick } from './login-flow.mjs';
import { normalize, judgeValue, buildLivePrompt, parseAiAnswer } from './answer-engine.mjs';
import { mergeConfig, configFromEnv, pickReason } from '../md-ai-answer/src/config.mjs';
import { createClient } from '../md-ai-answer/src/ai.mjs';

const ROOT = join(import.meta.dirname, '..');
const EXPORT = process.env.ZHS_DATA_DIR ? resolve(process.env.ZHS_DATA_DIR) : join(ROOT, 'export');
const OUT = join(ROOT, 'recon', 'apply');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const getArg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const DRY = has('--dry');
const SUBMIT = !has('--no-submit');
const FORCE = has('--force');
const USE_AI = !has('--no-ai');
const DELAY = Math.max(120, Number(getArg('--delay', '500')) || 500);
const COURSE = getArg('--course');
const EXAM = getArg('--exam');
const LIMIT = Number(getArg('--limit', '0')) || 0;
const RETHINK = !has('--no-rethink');
const REDO = !has('--no-redo');
const REDO_WAIT = Math.max(0, Number(getArg('--redo-wait', '90')) || 0) * 1000;
const MAX_ATTEMPTS = Math.max(1, Number(getArg('--attempts', '2')) || 2);

const log = (m = '') => process.stdout.write(m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanDelay = (base = DELAY) => sleep(base + Math.floor(Math.random() * 450));

/** 本地「已真实提交」台账：再次双击一键脚本时直接跳过，避免重复打开已交作业 */
const SUBMITTED_FILE = join(OUT, 'submitted.json');
const submittedLedger = readJson(SUBMITTED_FILE, {}) || {};
/** 「错题重新思考」沉淀下来的答案，优先级高于题库 */
const OVERRIDES_FILE = join(EXPORT, 'answer-overrides.json');
const paperKey = (course, it) => `${course}|${it.id}|${it.examId}`;

/* ═══════════════════════ 数据准备 ═══════════════════════ */

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { log(`⚠️  解析失败 ${file}: ${e.message}`); return fallback; }
}

/** 页面锚点规则：eid 去掉所有非字母数字 */
const anchorKey = (s) => String(s || '').replace(/[^A-Za-z0-9]/g, '');

/** 答案题库里的题干带「［单选题 · 2 分］」后缀 */
const stripStem = (s) => String(s || '').replace(/［[^］]*］\s*$/, '').replace(/\[[^\]]*\]\s*$/, '');

function cleanText(s) {
  return String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

function loadAnswers() {
  const explicit = process.env.ZHS_ANSWERS_JSON;
  const preferred = join(EXPORT, '智慧树作业题库_打印版.answers.json');
  let file = explicit && existsSync(explicit) ? explicit : (existsSync(preferred) ? preferred : null);
  if (!file && existsSync(EXPORT)) {
    file = readdirSync(EXPORT).filter((f) => /(\.answers\.json|^answers\.json)$/i.test(f))
      .map((f) => join(EXPORT, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || null;
  }
  const map = new Map();
  let count = 0;
  if (file) {
    const json = readJson(file, { questions: [] });
    for (const q of json.questions || []) {
      const key = normalize(stripStem(q.stem));
      if (key && !map.has(key)) map.set(key, q);
      count++;
    }
  }

  // 错题回顾沉淀的答案覆盖题库（只覆盖已知题干）
  const overrides = readJson(OVERRIDES_FILE, {}) || {};
  let overrideCount = 0;
  for (const [key, o] of Object.entries(overrides)) {
    if (!key || !o || (!o.answer && !o.correctTexts?.length)) continue;
    map.set(key, {
      stem: o.stem || '',
      answer: o.answer || '',
      correctTexts: o.correctTexts || [],
      fromOverride: true,
    });
    overrideCount++;
  }
  return { map, count, file, overrideCount };
}

function buildTargets(papers, resolved, courseFilter, examFilter) {
  const out = [];
  for (const [course, items] of Object.entries(papers || {})) {
    if (courseFilter && !course.includes(courseFilter)) continue;
    const rec = resolved?.[course];
    if (!rec) continue;
    for (const it of items) {
      if (examFilter && !String(it.examName).includes(examFilter)) continue;
      const qs = (it.paper?.rt?.examBase?.workExamParts ?? []).flatMap((p) => p.questionDtos ?? []);
      if (!qs.length) continue;
      const url = 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/'
        + `${rec.recruitId}/${it.id}/${it.examId}/${it.courseId}/5371/${it.meetCourseType ?? 0}`;
      if (it.state === 1 && it.score === null) {             // 未提交：正常作答
        out.push({ course, item: it, questions: qs, recruitId: rec.recruitId, listRid: rec.listRid, url });
        continue;
      }
      // 已提交但上次复盘未完成：补一次复盘（不重交原作业）
      const ledger = submittedLedger[paperKey(course, it)];
      if (!DRY && RETHINK && ledger && ledger.reviewed === false) {
        out.push({
          course, item: it, questions: qs, recruitId: rec.recruitId, listRid: rec.listRid, url,
          reviewOnly: true, ledgerScore: ledger.score ?? it.score ?? null,
        });
      }
    }
  }
  return out;
}

/* ═══════════════════════ AI 兜底 ═══════════════════════ */

function makeAi() {
  if (!USE_AI) return null;
  try {
    const cfgFile = join(ROOT, 'md-ai-answer', 'config.json');
    const cfg = mergeConfig(readJson(cfgFile, {}), configFromEnv(process.env));
    const r = pickReason(cfg);
    if (!r.baseUrl || !r.apiKey) return null;
    return { client: createClient({ baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, timeoutMs: cfg.timeoutMs, maxRetries: cfg.maxRetries }), model: r.model };
  } catch { return null; }
}

/** 题库没有可用答案时，用题干 + 页面选项问 AI */
async function askAi(ai, stem, type, liveOptions) {
  if (!ai) return null;
  try {
    const content = await ai.client.chat(buildLivePrompt({ stem, type, options: liveOptions }));
    return parseAiAnswer(content, liveOptions.length);
  } catch (e) {
    log(`    ⚠️ AI 兜底失败：${String(e).slice(0, 100)}`);
    return null;
  }
}

/* ═══════════════════════ 页面读取（页面内执行） ═══════════════════════ */

const READ_VISIBLE = () => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const subs = [...document.querySelectorAll('.examPaper_subject')].filter((s) => s.querySelector('.nodeLab'));
  const cur = subs.find(vis);
  if (!cur) return null;
  const anchor = cur.querySelector('.subject_num span[id^=anchor_]');
  const headText = clean(cur.querySelector('.subject_stem')?.innerText || '');
  const typeName = (headText.match(/【(.+?)】/) || [])[1] || '';
  // 选中态：input 是 display:none 且 checked 恒为 false，
  // 真实状态体现在 span.ABCase / div.node_detail 的 onChecked 类上（实测）。
  const isChecked = (lab, inp) => {
    if (inp?.checked) return true;
    const span = lab.querySelector('.label span');
    const detail = lab.querySelector('.node_detail, .examquestions-answer');
    return /(^|\s)onChecked(\s|$)/.test(span?.className || '')
      || /(^|\s)onChecked(\s|$)/.test(detail?.className || '');
  };
  const options = [...cur.querySelectorAll('.nodeLab')].map((lab, i) => {
    const inp = lab.querySelector('input');
    const detail = lab.querySelector('.node_detail, .examquestions-answer');
    return {
      i,
      letter: clean(lab.querySelector('.label span')?.innerText || '').replace(/[.\s]/g, ''),
      text: clean(detail?.innerText || lab.innerText || ''),
      checked: isChecked(lab, inp),
      disabled: inp ? !!inp.disabled : false,
    };
  });
  const btns = [...document.querySelectorAll('button')];
  const btn = (t) => btns.find((b) => clean(b.innerText) === t);
  const next = btn('下一题');
  const prev = btn('上一题');
  const submit = btns.find((b) => /提交作业/.test(clean(b.innerText)));
  const num = clean(cur.querySelector('.subject_num')?.innerText || '').replace(/[^\d]/g, '');
  return {
    eid: anchor ? anchor.id.replace(/^anchor_/, '') : null,
    num: Number(num) || null,
    typeName,
    headText,
    options,
    hasNext: !!next,
    nextDisabled: next ? (next.disabled || /is-disabled/.test(next.className)) : true,
    hasPrev: !!prev,
    prevDisabled: prev ? (prev.disabled || /is-disabled/.test(prev.className)) : true,
    hasSubmit: !!submit,
    qCount: subs.length,
  };
};

const READ_ALL = () => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('.examPaper_subject')].filter((s) => s.querySelector('.nodeLab')).map((s) => {
    const a = s.querySelector('.subject_num span[id^=anchor_]');
    return {
      eid: a ? a.id.replace(/^anchor_/, '') : null,
      num: Number(clean(s.querySelector('.subject_num')?.textContent || '').replace(/[^\d]/g, '')) || null,
      options: [...s.querySelectorAll('.nodeLab')].map((lab) => clean(lab.querySelector('.node_detail')?.textContent || '')),
    };
  });
};

const PAGE_TEXT = () => String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 500);

/* ═══════════════════════ 页面操作 ═══════════════════════ */

async function openPaper(page, target) {
  await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await sleep(3000);
  const ok = await page.evaluate((name) => String(document.body?.innerText || '').includes(name), target.item.examName).catch(() => false);
  if (!ok) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(3500);
  }
  // 等题目渲染出来
  for (let i = 0; i < 20; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('.examPaper_subject .nodeLab').length).catch(() => 0);
    if (n > 0) return true;
    await sleep(1000);
  }
  return false;
}

function judgeQ(typeName) {
  return /判断/.test(typeName);
}

/**
 * 把题库答案换算成页面选项下标。
 * @returns {{indexes:number[], unmatched:string[], letters:string, note:string}}
 */
function resolveTargets(q, entry, live) {
  const opts = q.questionOptions || [];
  const letters = String(entry?.answer || '').toUpperCase().replace(/[^A-Z]/g, '');
  const correctTexts = (entry?.correctTexts || []).map((t) => cleanText(t)).filter(Boolean);
  if (!letters && !correctTexts.length) return { indexes: [], unmatched: ['题库无答案'], letters: '', note: '题库无答案' };

  const isJudge = judgeQ(q.questionType?.name) || judgeQ(live.typeName);
  const wanted = [];
  if (correctTexts.length) {
    // 错题回顾得到的答案直接存了「正确选项正文」，优先按正文匹配
    for (const text of correctTexts) wanted.push({ text, value: judgeValue(text) });
  } else {
    for (const ch of letters) {
      const i = ch.charCodeAt(0) - 65;
      if (i < 0 || i >= opts.length) continue;
      const text = cleanText(opts[i].content);
      wanted.push({ text, value: judgeValue(text) });
    }
  }

  const indexes = [];
  const unmatched = [];
  for (const w of wanted) {
    let idx = -1;
    if (isJudge && w.value) {
      idx = live.options.findIndex((o) => judgeValue(o.text) === w.value);
    }
    if (idx < 0) {
      const n = normalize(w.text);
      idx = live.options.findIndex((o) => normalize(o.text) === n);
    }
    if (idx < 0) unmatched.push(w.text.slice(0, 40));
    else if (!indexes.includes(idx)) indexes.push(idx);
  }
  const pageLetters = indexes.map((i) => live.options[i]?.letter || String.fromCharCode(65 + i)).join('');
  return {
    indexes: indexes.sort((a, b) => a - b),
    unmatched,
    letters: pageLetters,
    note: unmatched.length ? `未匹配选项 ${unmatched.length} 个` : '选项正文匹配',
  };
}

/** 如果锚点对不上，用题号顺序 + 选项文本相似度兜底 */
function fallbackQuestion(target, live, index) {
  const q = target.questions[index];
  if (!q) return null;
  const paperTexts = new Set((q.questionOptions || []).map((o) => normalize(cleanText(o.content))));
  const hit = live.options.filter((o) => paperTexts.has(normalize(o.text))).length;
  return hit >= Math.max(1, Math.floor(live.options.length / 2)) ? q : null;
}

async function clickOption(page, optionIndex) {
  const lab = page.locator('.examPaper_subject:visible .nodeLab').nth(optionIndex);
  if (await lab.count() === 0) throw new Error('选项不存在: ' + optionIndex);
  await humanClick(page, lab);
}

/** 点击并校验选中状态；不成功时最多重试 2 次 */
async function setOptions(page, indexes) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await page.evaluate(READ_VISIBLE);
    if (!before) throw new Error('页面题目消失');
    for (const i of indexes) {
      if (before.options[i]?.checked) continue;
      await clickOption(page, i);
      await sleep(180 + Math.random() * 220);
    }
    const after = await page.evaluate(READ_VISIBLE);
    if (!after) throw new Error('页面题目消失');
    const ok = indexes.every((i) => after.options[i]?.checked)
      && after.options.every((o, i) => (indexes.includes(i) ? true : !o.checked));
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

async function clickButton(page, text) {
  const btn = page.locator('button').filter({ hasText: new RegExp('^\\s*' + text + '\\s*$') }).first();
  if (await btn.count() === 0) return false;
  await humanClick(page, btn);
  return true;
}

/** 页面会恢复上次停留的题号；先回到第 1 题，保证每题都被作答 */
async function rewindToFirst(page) {
  for (let i = 0; i < 80; i++) {
    const st = await page.evaluate(READ_VISIBLE).catch(() => null);
    if (!st || st.prevDisabled) return st;
    const prev = st.eid;
    if (!await clickButton(page, '上一题')) return st;
    const moved = await waitEid(page, prev, 6000);
    if (!moved) return st;
    await humanDelay(120);
  }
  return await page.evaluate(READ_VISIBLE).catch(() => null);
}

async function waitEid(page, prev, timeout = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await page.evaluate(READ_VISIBLE).catch(() => null);
    if (st && st.eid !== prev) return st;
    await sleep(350);
  }
  return null;
}

/* ── 提交 ── */

const DIALOGS = () => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('.el-message-box, .el-dialog, .el-dialog__wrapper')]
    .filter(vis)
    .map((b) => ({
      cls: String(b.className),
      text: clean(b.innerText).slice(0, 260),
      buttons: [...b.querySelectorAll('button')].filter(vis)
        .map((n) => ({ text: clean(n.innerText), disabled: n.disabled || /is-disabled/.test(n.className) })),
    }))
    .filter((d) => d.buttons.length || /提交|确认|确定|暂存/.test(d.text));
};

/** 等一个「文案匹配」的对话框出现 */
async function waitDialog(page, textRe, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ds = await page.evaluate(DIALOGS).catch(() => []);
    const hit = [...ds].reverse().find((d) => textRe.test(d.text));
    if (hit) return hit;
    await sleep(300);
  }
  return null;
}

async function waitNoDialog(page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const ds = await page.evaluate(DIALOGS).catch(() => []);
    if (!ds.length) return true;
    await sleep(250);
  }
  return false;
}

/** 开卷时可能弹出的「继续作答 / 提示」框，先清掉，避免遮挡题目 */
async function dismissStartDialog(page) {
  const ds = await page.evaluate(DIALOGS).catch(() => []);
  if (!ds.length) return false;
  const d = ds[ds.length - 1];
  if (/提交|交卷|暂存/.test(d.text)) return false;
  const scope = page.locator('.el-message-box:visible, .el-dialog:visible').last();
  const btn = scope.locator('button').filter({ hasText: /(继续作答|继续|确定|关闭|我知道了)/ });
  if (await btn.count() === 0) return false;
  await humanClick(page, btn.last());
  await waitNoDialog(page, 6000);
  log(`   · 已关闭弹窗：${d.text.slice(0, 40)}`);
  return true;
}

/**
 * 只在「文案匹配的那个对话框」里点按钮。
 * 这是本次修复的核心：暂存确认框与提交确认框必须分开处理，
 * 否则会像之前那样只暂存、没提交，却误报成功。
 */
async function clickDialogButton(page, textRe, buttonRe) {
  const scope = page.locator('.el-message-box:visible, .el-dialog:visible').filter({ hasText: textRe }).last();
  if (await scope.count() === 0) return false;
  const btn = scope.locator('button').filter({ hasText: buttonRe });
  if (await btn.count() === 0) return false;
  const target = btn.last();
  const cls = await target.getAttribute('class').catch(() => '');
  if (/is-disabled/.test(cls || '')) return false;
  await humanClick(page, target);
  return true;
}

// 按钮文本可能带换行/缩进，不能用 ^...$ 完全匹配
const CONFIRM_BTN = /(确定|确认|提交|继续提交|确认提交|是)/;

/** 最后一题先暂存：只确认「暂存」那个框，并等它彻底消失 */
async function saveDraft(page) {
  if (!await clickButton(page, '暂存作业')) return false;
  const dlg = await waitDialog(page, /暂存|保存/, 8000) ?? await waitDialog(page, /./, 3000);
  if (!dlg) return false;
  const re = /暂存|保存/.test(dlg.text) ? /暂存|保存/ : /./;
  if (!await clickDialogButton(page, re, CONFIRM_BTN)) return false;
  await waitNoDialog(page, 10000);
  const t = await page.evaluate(PAGE_TEXT).catch(() => '');
  return /保存成功|暂存成功/.test(t);
}

/** 页面上的飘字/弹窗文案（提交结果通常在这里） */
const RESULT_TEXT = () => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('.el-message, .el-notification, .el-message-box, .el-dialog')]
    .filter(vis).map((e) => clean(e.innerText)).join('  ').slice(0, 600);
};

const SUCCESS_RE = /提交成功|交卷成功|提交作业成功|作业已提交|已提交成功|本次获得的成绩|返回作业考试|查看解析/;
const SCORE_RE = /成绩是\s*(\d+(?:\.\d+)?)\s*分/;

/** 等真正的提交结果：成功提示 / 离开答题页 */
async function waitSubmitResult(page, timeout = 30000) {
  const t0 = Date.now();
  let text = '';
  let url = page.url();
  while (Date.now() - t0 < timeout) {
    url = page.url();
    text = await page.evaluate(PAGE_TEXT).catch(() => '');
    const res = await page.evaluate(RESULT_TEXT).catch(() => '');
    if (SUCCESS_RE.test(text + ' ' + res)) {
      const m = SCORE_RE.exec(res || text);
      return { ok: true, text: res || text, url, score: m ? Number(m[1]) : null };
    }
    if (!/dohomework/i.test(url)) {
      // 登录失效也会跳走，不能算提交成功
      if (/login|passport|captcha/i.test(url)) {
        const body = await page.evaluate(PAGE_TEXT).catch(() => '');
        if (/登录|扫码|密码/.test(body)) return { ok: false, text: '登录已失效', url };
      }
      return { ok: true, text: '已离开答题页', url };
    }
    await sleep(1000);
  }
  return { ok: false, text, url };
}

async function submitPaper(page) {
  const dialogs = [];
  const note = (t) => { const s = String(t || '').replace(/\s+/g, ' ').trim(); if (s) dialogs.push(s); };

  // 1) 暂存最后一题（不能把这步的确认框当成提交确认）
  const drafted = await saveDraft(page);
  if (drafted) log('    ✓ 已暂存最后一题');

  // 2) 点「提交作业」，只确认带「提交/交卷」字样的那个框
  if (!await clickButton(page, '提交作业')) {
    return { ok: false, err: '找不到「提交作业」按钮', dialogs, text: '', url: page.url() };
  }
  const first = await waitDialog(page, /提交|交卷/, 15000);
  if (!first) {
    // 可能是原生 confirm（已被自动接受），直接看结果
    const r = await waitSubmitResult(page, 15000);
    if (r.ok) return { ok: true, dialogs, text: r.text, url: r.url };
    return { ok: false, err: '点击「提交作业」后没有出现确认框，也没看到成功提示', dialogs, text: r.text, url: r.url };
  }
  note(first.text);
  await clickDialogButton(page, /提交|交卷/, CONFIRM_BTN);

  // 3) 可能还有「还有题目未作答，是否继续提交」的二次确认
  for (let i = 0; i < 3; i++) {
    const d = await waitDialog(page, /未答|未完成|继续提交/, 4000);
    if (!d) break;
    note(d.text);
    await clickDialogButton(page, /未答|未完成|继续提交/, CONFIRM_BTN);
    await sleep(1000);
  }

  // 4) 等真正的结果
  const r = await waitSubmitResult(page, 30000);
  if (r.ok) return { ok: true, dialogs, text: r.text, url: r.url };
  const remaining = await page.evaluate(RESULT_TEXT).catch(() => '');
  return { ok: false, err: '没有等到提交成功的反馈', dialogs, text: r.text, url: r.url, remaining };
}

/* ═══════════════════════ 错题回顾 + 重新思考 ═══════════════════════ */

const REVIEW_APIS = {
  homework: /student\/lookHomework/i,
  answerInfo: /answer\/getStuAnswerInfo/i,
  analysis: /exam\/getAllQuesitonAnalysis/i,
  sheet: /answer\/checkAnswerSheetInfo/i,
};

const REVIEW_URL = (target) => 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/checkHomework/'
  + `${target.recruitId}/${target.item.id}/${target.item.examId}/${target.item.courseId}/5371`
  + `?meetCourseType=${target.item.meetCourseType ?? 0}&state=4`;

const LIST_URL = (target) => 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList'
  + `?recruitId=${target.listRid}`;

const READ_REVIEW_BLOCKS = () => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  return [...document.querySelectorAll('.reviewList, .examPaper_subject, .subject_item, .questionItem, .anaKey_detail, .answerKey_detail')]
    .filter(vis).map((el) => clean(el.innerText)).filter((t) => t.length > 8).slice(0, 400);
};

/** 打开复习页，顺带截获平台自己发出的四个接口响应 */
async function captureReview(page, target, timeout = 30000) {
  const got = {};
  const handler = async (resp) => {
    const u = resp.url();
    const key = Object.keys(REVIEW_APIS).find((k) => REVIEW_APIS[k].test(u));
    if (!key || got[key]) return;
    try {
      const j = await resp.json();
      got[key] = j?.rt ?? j?.data ?? j;
    } catch {}
  };
  const out = { raw: got, blocks: [] };
  page.on('response', handler);
  try {
    await page.goto(REVIEW_URL(target), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (got.homework && (got.answerInfo || got.sheet)) break;
      if (/login|passport|captcha/i.test(page.url())) break;
      await sleep(600);
    }
    // 解析可能要点「查看解析」才请求
    if (!got.analysis) {
      await page.evaluate(() => {
        const re = /查看解析|展开解析/;
        [...document.querySelectorAll('a,button,span,div')]
          .filter((el) => re.test((el.innerText || '').trim()) && el.getBoundingClientRect().width > 0)
          .slice(0, 2).forEach((el) => el.click());
      }).catch(() => {});
      const t1 = Date.now();
      while (Date.now() - t1 < 8000 && !got.analysis) await sleep(500);
    }
    out.blocks = await page.evaluate(READ_REVIEW_BLOCKS).catch(() => []);
  } finally {
    page.off('response', handler);
  }
  return out;
}

function reviewQuestions(homework) {
  const direct = (homework?.examBase?.workExamParts || []).flatMap((p) => p?.questionDtos || []);
  if (direct.length) return direct;
  const out = [];
  const seen = new Set();
  const walk = (o, d) => {
    if (!o || d > 6 || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const x of o) walk(x, d + 1); return; }
    if (Array.isArray(o.questionOptions) && (o.name || o.questionName) && !seen.has(o)) { seen.add(o); out.push(o); }
    for (const v of Object.values(o)) walk(v, d + 1);
  };
  walk(homework, 0);
  return out;
}

function indexByQid(node) {
  const map = new Map();
  if (!node) return map;
  if (Array.isArray(node)) {
    for (const it of node) {
      const id = it?.id ?? it?.questionId;
      if (id != null) map.set(String(id), it);
    }
    return map;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') map.set(String(k), v);
  }
  return map;
}

const ANSWER_KEY_RE = /answer|right|correct|key|result|daan/i;

/** 在答案/解析对象里递归找「可能是正确答案」的字符串 */
function answerCandidates(node, depth = 0, out = []) {
  if (!node || depth > 5) return out;
  if (Array.isArray(node)) { for (const x of node) answerCandidates(x, depth + 1, out); return out; }
  if (typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && ANSWER_KEY_RE.test(k)) out.push(v);
    else if (Array.isArray(v) && ANSWER_KEY_RE.test(k)) {
      for (const x of v) if (typeof x === 'string' || typeof x === 'number') out.push(String(x));
    } else if (v && typeof v === 'object') answerCandidates(v, depth + 1, out);
  }
  return out;
}

/** 把「A / AB / 选项正文」候选值换算成选项正文数组 */
function candidateToTexts(value, options) {
  const v = cleanText(value);
  if (!v) return [];
  const opts = options.map((o) => cleanText(o.content)).filter(Boolean);
  if (/^[A-H](?:[\s,，、]*[A-H]){0,7}$/i.test(v)) {
    const idxs = [...v.toUpperCase()].filter((c) => /[A-H]/.test(c)).map((c) => c.charCodeAt(0) - 65);
    const picked = [...new Set(idxs)].filter((i) => i < opts.length).map((i) => opts[i]);
    if (picked.length) return picked;
  }
  const hits = opts.filter((t) => t.length >= 2 && (v.includes(t) || t.includes(v)));
  if (hits.length && hits.length <= opts.length) return hits;
  const jv = judgeValue(v);
  if (jv) { const hit = opts.find((t) => judgeValue(t) === jv); if (hit) return [hit]; }
  return [];
}

function platformAnswerTexts(q, analysisEntry) {
  const cands = analysisEntry ? answerCandidates(analysisEntry) : [];
  for (const c of cands) {
    const texts = candidateToTexts(c, q.questionOptions || []);
    if (texts.length) return { texts, evidence: cleanText(c).slice(0, 400) };
  }
  return { texts: [], evidence: '' };
}

function findReviewBlock(blocks, stem) {
  const key = normalize(stem).slice(0, 12);
  if (!key) return '';
  return blocks.find((t) => normalize(t).includes(key)) || '';
}

function extractAnswerFromBlock(block, q) {
  const text = cleanText(block);
  const m = /正确答案[：:]\s*([^。；;]{1,200})/.exec(text) || /答案[：:]\s*([A-H][A-H\s,，、]{0,10})/.exec(text);
  const texts = m ? candidateToTexts(m[1], q.questionOptions || []) : [];
  const am = /解析[：:]\s*([\s\S]{1,400})/.exec(text);
  return { texts, analysis: am ? am[1].slice(0, 400) : '' };
}

function entryIsWrong(entry, typeName) {
  if (!entry) return null;
  const cur = entry.isCurrent ?? entry.isRight ?? entry.right;
  if (cur != null) {
    if (typeof cur === 'boolean') return !cur;
    if (typeof cur === 'number' || /^\d+$/.test(String(cur))) return Number(cur) !== 1;
  }
  const score = entry.score ?? entry.questionScore;
  if (score != null && Number(score) === 0 && !/简答|论述|填空|名词|计算|分析/.test(typeName)) return true;
  return null;
}

function studentAnswerText(entry, q) {
  const raw = entry?.answer ?? entry?.studentAnswer ?? entry?.myAnswer ?? '';
  const opts = q.questionOptions || [];
  const tokens = Array.isArray(raw)
    ? raw.map(String)
    : String(raw ?? '').split(/[,，;；|]/).map((s) => s.trim()).filter(Boolean);
  return tokens.map((t) => {
    const byId = opts.find((o) => String(o.id) === String(t));
    return byId ? cleanText(byId.content) : cleanText(t);
  }).filter(Boolean).join(' / ');
}

async function recheckWithAi(ai, q, chosen, platformTexts, analysisText) {
  if (!ai) return null;
  const opts = (q.questionOptions || [])
    .map((o, i) => `${String.fromCharCode(65 + i)}. ${cleanText(o.content)}`).join('\n');
  const typeName = q.questionType?.name || '';
  const system = [
    '你是一名严谨的答题助手。',
    '下面这道题上一次答错了，请重新独立思考，不要迷信上次答案。',
    '先逐项复核题干与每个选项，再给出最终答案。',
    '严格只输出一个 JSON 数组，不要输出任何解释性文字。',
    '数组只含一个元素，形如 {"answer":"答案","reason":"简要理由(<=40字)","confidence":0-1}。',
    '规则：单选题 answer 为一个字母；多选题 answer 为按字母升序拼接的字符串（如 "ABD"）；判断题 answer 为 "A" 或 "B"。',
  ].join('\n');
  const lines = [`[#1] (${typeName || '题目'})`, cleanText(q.name), '', '选项：', opts, '', `上次作答：${chosen || '（未知）'}`];
  if (platformTexts.length) lines.push(`平台参考答案：${platformTexts.join('；')}`);
  if (analysisText) lines.push(`平台解析：${analysisText.slice(0, 500)}`);
  lines.push('', '请重新作答。');
  try {
    const content = await ai.client.chat([
      { role: 'system', content: system },
      { role: 'user', content: lines.join('\n') },
    ]);
    const a = parseAiAnswer(content, (q.questionOptions || []).length);
    if (!a.ok) return null;
    const texts = a.indexes.map((i) => cleanText(q.questionOptions[i]?.content || '')).filter(Boolean);
    const letters = a.indexes.map((i) => String.fromCharCode(65 + i)).join('');
    return { letters, texts, raw: a.raw };
  } catch (e) {
    log(`      ⚠️ AI 复核失败：${String(e).slice(0, 80)}`);
    return null;
  }
}

/** 标记该作业复盘已处理，避免下次启动重复进入复习页 */
function markReviewed(target, extra = {}) {
  const key = paperKey(target.course, target.item);
  const cur = submittedLedger[key];
  if (!cur) return;
  submittedLedger[key] = { ...cur, reviewed: true, reviewedAt: new Date().toISOString(), ...extra };
  try { writeFileSync(SUBMITTED_FILE, JSON.stringify(submittedLedger, null, 2), 'utf8'); } catch { /* 台账写失败不阻塞主流程 */ }
}

/** 提交后：看错题 → 重新思考 → 沉淀覆盖答案 →（可选）申请重做并再答一轮 */
async function rethinkAfterSubmit(page, target, item, ctxData, attempt) {
  if (!RETHINK || !item.submitted || item.score == null) return;
  const total = Number(target.item.totalScore)
    || target.questions.reduce((a, q) => a + (Number(q.questionScore) || 0), 0);
  if (!total || item.score >= total) {   // 满分 / 总分未知，无需复核
    markReviewed(target, { score: item.score });
    return;
  }

  log(`   🔍 得分 ${item.score}/${total}，开始回顾错题…`);
  const review = await captureReview(page, target);
  const raw = review.raw || {};
  if (!raw.homework && !raw.answerInfo && !raw.sheet) {
    log('      ⚠️ 没拿到复习页数据（可能登录失效或暂不允许查看），跳过');
    item.review = { ok: false, reason: '复习页无数据' };
    return;
  }

  const qs = reviewQuestions(raw.homework);
  const answerMap = indexByQid(raw.answerInfo);
  if (!answerMap.size) for (const [k, v] of indexByQid(raw.sheet)) answerMap.set(k, v);
  const analysisMap = indexByQid(raw.analysis);

  const wrong = [];
  for (const [i, q] of qs.entries()) {
    const qid = String(q.id ?? q.questionId ?? '');
    const entry = qid ? answerMap.get(qid) : null;
    if (!entry) continue;
    const typeName = q.questionType?.name || '';
    if (entryIsWrong(entry, typeName) !== true) continue;

    const stemText = cleanText(q.name || q.questionName);
    const fromApi = platformAnswerTexts(q, analysisMap.get(qid));
    const block = findReviewBlock(review.blocks, stemText);
    const fromDom = block ? extractAnswerFromBlock(block, q) : { texts: [], analysis: '' };
    wrong.push({
      num: i + 1, qid, question: q, typeName, stem: stemText,
      chosen: studentAnswerText(entry, q) || '（未知）',
      platformTexts: fromApi.texts.length ? fromApi.texts : fromDom.texts,
      analysisText: [fromApi.evidence, fromDom.analysis].filter(Boolean).join(' ').slice(0, 600),
    });
  }

  if (!wrong.length) {
    log('      ✓ 没有识别到错题（可能全对，或平台未返回对错）');
    item.review = { ok: true, score: item.score, total, wrongCount: 0 };
    markReviewed(target, { score: item.score });
    return;
  }
  log(`      识别到错题 ${wrong.length} 道，逐题重新思考：`);

  const overrides = readJson(OVERRIDES_FILE, {}) || {};
  let added = 0;
  for (const w of wrong) {
    let final = { letters: '', texts: w.platformTexts, source: w.platformTexts.length ? '平台答案' : '' };
    if (w.platformTexts.length) {
      final.letters = w.platformTexts.map((t) => {
        const i = (w.question.questionOptions || []).findIndex((o) => normalize(cleanText(o.content)) === normalize(t));
        return i >= 0 ? String.fromCharCode(65 + i) : '';
      }).join('');
    }
    const a = await recheckWithAi(ctxData.ai, w.question, w.chosen, w.platformTexts, w.analysisText);
    if (a) final = { letters: a.letters, texts: a.texts, source: w.platformTexts.length ? 'AI复核+平台答案' : 'AI复核' };
    if (!final.texts.length) {
      log(`       ${w.num}. ⚠️ 未得到修正答案，保留原答案`);
      continue;
    }
    const key = normalize(stripStem(w.stem));
    if (!key) continue;
    overrides[key] = {
      stem: w.stem.slice(0, 160),
      answer: final.letters,
      correctTexts: final.texts,
      platformAnswer: w.platformTexts.join('；'),
      analysis: w.analysisText.slice(0, 300),
      reason: final.source,
      course: target.course,
      examName: target.item.examName,
      at: new Date().toISOString(),
    };
    ctxData.answers.map.set(key, { stem: w.stem, answer: final.letters, correctTexts: final.texts, fromOverride: true });
    added++;
    log(`       ${w.num}. ↻ ${final.letters || '-'}（${final.source}） ${w.stem.slice(0, 34)}`);
  }
  if (added) {
    writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf8');
    log(`      ✓ 已沉淀 ${added} 道修正答案 → ${OVERRIDES_FILE.replace(ROOT + '\\', '')}`);
  }
  item.review = {
    ok: true, score: item.score, total, wrongCount: wrong.length, fixed: added,
    wrong: wrong.map((w) => ({ stem: w.stem.slice(0, 60), chosen: w.chosen.slice(0, 40), platform: w.platformTexts })),
  };

  if (!added || !REDO) {
    markReviewed(target, { score: item.score });
    return;
  }
  if (attempt >= MAX_ATTEMPTS) {
    log('      （已达到最大作答轮数，不再重做）');
    markReviewed(target, { score: item.score });
    return;
  }
  const ok = await applyRedo(page, target);
  item.redo = ok;
  if (!ok) {
    markReviewed(target, { score: item.score });
    return;
  }
  await sleep(3000);
  log(`   🔄 重做已就绪，开始第 ${attempt + 1} 轮作答…`);
  await doPaper(page, target, ctxData, attempt + 1);
}

/** 在作业列表页点「申请重做」；不弹扫码框时全自动，弹出理由框则自动填写 */
async function applyRedo(page, target) {
  if (!target.listRid) return false;
  log('   🔁 尝试申请重做…');
  await page.goto(LIST_URL(target), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  for (let i = 0; i < 30; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('.examItemWrap').length).catch(() => 0);
    if (n > 0) break;
    await sleep(1000);
  }
  const cards = page.locator('.examItemWrap').filter({ hasText: target.item.examName });
  const cardCount = await cards.count();
  if (cardCount === 0) { log('      列表里找不到该作业，跳过重做'); return false; }
  if (cardCount > 1) { log(`      列表里有 ${cardCount} 份同名作业，为避免误操作跳过重做`); return false; }
  const card = cards.first();
  const btn = card.locator('a.showFromBtn, a.recreation').filter({ hasText: '申请重做' }).first();
  if (await btn.count() === 0) { log('      没有「申请重做」入口（次数已用完或未开放），跳过'); return false; }
  await humanClick(page, btn);

  const t0 = Date.now();
  let reasonFilled = false;
  let waitStart = 0;
  while (Date.now() - t0 < 60000 + REDO_WAIT) {
    const ds = await page.evaluate(DIALOGS).catch(() => []);
    const all = ds.map((d) => d.text).join(' ｜ ');
    if (/申请成功/.test(all)) {
      await clickDialogButton(page, /申请成功/, CONFIRM_BTN);
      log('      ✓ 已申请重做');
      return true;
    }
    if (/重做次数已用完|不能申请重做|课程已结束/.test(all)) {
      await clickDialogButton(page, /重做次数已用完|不能申请重做|课程已结束/, CONFIRM_BTN);
      log(`      ✗ ${(all.match(/重做次数已用完|不能申请重做|课程已结束/) || ['不能重做'])[0]}`);
      return false;
    }
    const reasonBox = page.locator('.report-dialog:visible textarea').first();
    if (await reasonBox.count() > 0) {
      if (!reasonFilled) {
        await reasonBox.fill('申请重做以修正答案').catch(() => {});
        await sleep(500);
        const yes = page.locator('.report-dialog:visible .popbtn_yes').last();
        if (await yes.count() > 0) await humanClick(page, yes);
        reasonFilled = true;
        log('      ✓ 已填写重做理由并提交');
      }
      await sleep(1500);
      continue;
    }
    if (/你还有\s*\d+\s*次重做机会/.test(all)) {
      await clickDialogButton(page, /重做机会/, CONFIRM_BTN);
      await sleep(1500);
      continue;
    }
    if (!waitStart) waitStart = Date.now();
    if (REDO_WAIT && Date.now() - waitStart > REDO_WAIT) {
      log('      ⌛ 重做申请等待超时');
      return false;
    }
    await sleep(1000);
  }
  log('      ⚠️ 重做申请结果未确认');
  return false;
}

/* ═══════════════════════ 单份作业 ═══════════════════════ */

async function doPaper(page, target, ctxData, attempt = 1) {
  const { byAnchor, answers, ai, report } = ctxData;
  const title = `${target.course} / ${target.item.examName}`;
  const item = {
    course: target.course, examName: target.item.examName, url: target.url, attempt,
    total: target.questions.length, at: new Date().toISOString(),
    questions: [], skipped: [], submitted: false, submitEvidence: '', error: null,
  };
  report.items.push(item);

  log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log(`📝 ${title}（${target.questions.length} 题）`);
  log(`   ${target.url}`);

  if (DRY) {
    for (const [i, q] of target.questions.entries()) {
      const entry = answers.map.get(normalize(stripStem(q.name)));
      item.questions.push({ num: i + 1, stem: cleanText(q.name).slice(0, 50), answer: entry?.answer || '?' });
      log(`   ${String(i + 1).padStart(2)}. [${q.questionType?.name || '?'}] ${entry?.answer || '✗ 无答案'}  ${cleanText(q.name).slice(0, 42)}`);
    }
    return item;
  }

  const opened = await openPaper(page, target);
  if (!opened) {
    item.error = '作业页加载失败';
    log('   ✗ 作业页加载失败，跳过');
    return item;
  }
  await page.bringToFront().catch(() => {});
  await sleep(1200);
  await dismissStartDialog(page);

  const first = await rewindToFirst(page);
  if (first && first.num && first.num > 1) log(`   ⚠️ 未能回到第 1 题（当前第 ${first.num} 题），继续`);
  else if (first) log('   ↺ 已回到第 1 题');

  const total = target.questions.length;
  const answered = new Set();
  let stuck = 0;
  let lastEid = null;

  for (let step = 0; step < total + 4; step++) {
    const st = await page.evaluate(READ_VISIBLE).catch(() => null);
    if (!st) { log('   ⚠️ 读不到当前题面，停止'); break; }

    const key = anchorKey(st.eid);
    const q = byAnchor.get(key);
    const qi = (st.num || step + 1) - 1;

    if (!answered.has(key)) {
      let question = q?.q || fallbackQuestion(target, st, qi);
      const fromAnchor = !!q?.q;
      if (!question) {
        log(`   ${st.num ?? '?'}. ⚠️ 题目无法对应（anchor=${st.eid}），跳过`);
        item.skipped.push({ num: st.num, eid: st.eid, reason: 'eid/选项均未匹配' });
      } else {
        const entry = answers.map.get(normalize(stripStem(question.name)));
        let targetInfo = entry ? resolveTargets(question, entry, st) : { indexes: [], unmatched: ['题库无答案'], letters: '', note: '题库无答案' };
        let source = entry ? '题库' : 'AI';

        // 题库不可用时，用页面上的选项问 AI
        if (!targetInfo.indexes.length) {
          const liveOpts = st.options.map((o, i) => ({ ...o, index: i }));
          const a = await askAi(ai, cleanText(question.name), judgeQ(st.typeName) ? 'judge' : (/多选|不定项/.test(st.typeName) ? 'multiple' : 'single'), liveOpts);
          if (a?.ok) {
            targetInfo = { indexes: a.indexes, unmatched: [], letters: a.indexes.map((i) => st.options[i]?.letter || '').join(''), note: 'AI 作答' };
            source = 'AI';
          }
        }

        // 题库和 AI 都没结果时随机选一个，保证每题都填上，不因个别题卡住整份作业
        if (!targetInfo.indexes.length && st.options.length) {
          const i = Math.floor(Math.random() * st.options.length);
          targetInfo = {
            indexes: [i], unmatched: [],
            letters: st.options[i]?.letter || String.fromCharCode(65 + i),
            note: '随机兜底',
          };
          source = '随机';
        }

        item.questions.push({
          num: st.num, eid: st.eid, anchorMatched: fromAnchor,
          stem: cleanText(question.name).slice(0, 80),
          type: question.questionType?.name || st.typeName,
          bankAnswer: entry?.answer || '', pageLetters: targetInfo.letters,
          pageIndexes: targetInfo.indexes, source, note: targetInfo.note,
        });

        if (!targetInfo.indexes.length) {
          log(`   ${st.num ?? '?'}. ✗ 无法确定答案：${targetInfo.note}`);
          item.skipped.push({ num: st.num, eid: st.eid, reason: targetInfo.note });
        } else {
          log(`   ${st.num ?? '?'}. [${question.questionType?.name || st.typeName}] 题库=${entry?.answer || '-'} → 页面=${targetInfo.letters}（${source}）`);
          const ok = await setOptions(page, targetInfo.indexes);
          if (!ok) {
            log('       ⚠️ 选项选中状态校验失败');
            item.skipped.push({ num: st.num, eid: st.eid, reason: '选项点击未生效' });
          }
          await humanDelay(220);
        }
      }
      answered.add(key);
    } else {
      log(`   ${st.num ?? '?'}. ↩ 已答过，继续`);
    }

    const isLast = st.nextDisabled || (st.num && st.num >= total);
    if (isLast) break;

    const prev = st.eid;
    const clicked = await clickButton(page, '下一题');
    if (!clicked) { log('   ⚠️ 找不到「下一题」'); break; }
    const next = await waitEid(page, prev);
    if (!next) {
      stuck++;
      log(`   ⚠️ 下一题没变化（第 ${stuck} 次）`);
      if (stuck >= 2) break;
      await sleep(1500);
      await clickButton(page, '下一题').catch(() => {});
      const retry = await waitEid(page, prev);
      if (!retry) break;
    } else {
      stuck = 0;
      lastEid = next.eid;
    }
    await humanDelay(350);
  }

  // 提交
  if (!SUBMIT) {
    log('   （--no-submit：已作答，未提交）');
    return item;
  }
  if (item.skipped.length && !FORCE) {
    log(`   ⚠️ 有 ${item.skipped.length} 题未解析，保守起见不提交（加 --force 可强制提交）`);
    item.error = '存在未解析题，未提交';
    return item;
  }

  log('   📤 提交作业…');
  const res = await submitPaper(page);
  item.submitted = !!res.ok;
  item.submitEvidence = res.text;
  item.dialogs = res.dialogs || [];
  item.submitUrl = res.url;
  if (res.ok) {
    item.score = res.score ?? null;
    log(`   ✓ 提交成功${res.score != null ? `，本次成绩 ${res.score} 分` : ''}`);
    submittedLedger[paperKey(target.course, target.item)] = {
      at: new Date().toISOString(), course: target.course, examName: target.item.examName,
      score: item.score, reviewed: false,
    };
    writeFileSync(SUBMITTED_FILE, JSON.stringify(submittedLedger, null, 2), 'utf8');
    await rethinkAfterSubmit(page, target, item, ctxData, attempt);
  } else {
    log(`   ⚠️ 提交结果未确认：${res.remaining || res.err || res.text.slice(0, 100)}`);
    item.error = res.err || '提交结果未确认';
  }
  await sleep(1200);
  return item;
}

/* ═══════════════════════ 补复盘 ═══════════════════════ */

/** 上次已提交但复盘没跑完：这次只进复习页补做复盘/重做，不重交原作业 */
async function reviewExisting(page, target, ctxData) {
  const item = {
    course: target.course, examName: target.item.examName, url: target.url,
    total: target.questions.length, at: new Date().toISOString(),
    questions: [], skipped: [], submitted: true, reviewOnly: true,
    submitEvidence: '', submitUrl: '', score: target.ledgerScore ?? null, error: null,
  };
  ctxData.report.items.push(item);
  log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log(`🔍 ${target.course} / ${target.item.examName}（补上次未完成的复盘）`);
  if (item.score == null) {
    log('   ⚠️ 台账里没有分数，无法判断是否需要复盘，跳过');
    markReviewed(target, { score: item.score });
    return item;
  }
  await rethinkAfterSubmit(page, target, item, ctxData, 1);
  return item;
}

/* ═══════════════════════ 主流程 ═══════════════════════ */

log('══════════ 全自动作业答题 ══════════');
const papers = readJson(join(EXPORT, 'papers.json'), {});
const resolved = readJson(join(EXPORT, 'courses-resolved.json'), {});
const answers = loadAnswers();
log(`答案库: ${answers.file ? answers.file.replace(ROOT + '\\', '') : '（无）'}  条目=${answers.count}  错题修正=${answers.overrideCount || 0}`);
log(`复盘: ${RETHINK ? `开启（重做=${REDO ? '开' : '关'}，最多 ${MAX_ATTEMPTS} 轮）` : '关闭'}`);
log(`模式: ${DRY ? '演练（不点页面）' : (SUBMIT ? '真实作答 + 自动提交' : '真实作答，不提交')}`);

let targets = buildTargets(papers, resolved, COURSE, EXAM);
const normalBefore = targets.filter((t) => !t.reviewOnly).length;
targets = targets.filter((t) => t.reviewOnly || !submittedLedger[paperKey(t.course, t.item)]);
const skippedDone = normalBefore - targets.filter((t) => !t.reviewOnly).length;
if (LIMIT > 0) targets = targets.slice(0, LIMIT);
log(`待完成作业: ${targets.length} 份${skippedDone ? `（另有 ${skippedDone} 份已真实提交，跳过）` : ''}`);
for (const [i, t] of targets.entries()) {
  log(`  ${i + 1}. ${t.course} / ${t.item.examName}（${t.questions.length} 题）${t.reviewOnly ? ' [补复盘]' : ''}`);
}

if (!targets.length) {
  writeFileSync(join(OUT, 'auto-answer-report.json'),
    JSON.stringify({ at: new Date().toISOString(), mode: DRY ? 'dry' : (SUBMIT ? 'auto' : 'answer-only'), items: [], finished: true }, null, 2),
    'utf8');
  log('\n没有需要处理的作业。');
  process.exit(0);
}

// 建 eid → 题目索引
const byAnchor = new Map();
for (const t of targets) {
  for (const q of t.questions) {
    const k = anchorKey(q.eid);
    if (k && !byAnchor.has(k)) byAnchor.set(k, { q, target: t });
  }
}
if (byAnchor.size !== targets.reduce((a, t) => a + t.questions.length, 0)) {
  log(`⚠️  eid 映射有重复或缺失：映射 ${byAnchor.size} / 题目 ${targets.reduce((a, t) => a + t.questions.length, 0)}`);
}

if (DRY) {
  const report = { at: new Date().toISOString(), mode: 'dry', items: [], finished: true };
  for (const t of targets) await doPaper(null, t, { answers, byAnchor, ai: null, report });
  writeFileSync(join(OUT, 'auto-answer-report.json'), JSON.stringify(report, null, 2), 'utf8');
  log('\n演练完成。确认无误后去掉 --dry 真实执行。');
  process.exit(0);
}

const ai = makeAi();
if (ai) log(`AI 兜底: 已启用（${ai.model}）`);

const { ctx, describe, close } = await connect({
  prefer: getArg('--browser', 'chromium') === 'firefox' ? 'firefox' : 'chromium',
  exe: getArg('--browser-exe'),
});
log('浏览器: ' + describe);

const page = ctx.pages().find((p) => p.url().includes('onlineexamh5new'))
  ?? await ctx.newPage();
page.on('dialog', (d) => d.accept().catch(() => {}));

const report = { at: new Date().toISOString(), mode: SUBMIT ? 'auto' : 'answer-only', items: [], finished: false };
const ctxData = { byAnchor, answers, ai, report };

for (const [i, t] of targets.entries()) {
  try {
    if (t.reviewOnly) await reviewExisting(page, t, ctxData);
    else await doPaper(page, t, ctxData);
  } catch (e) {
    log(`   ✗ 异常：${String(e).slice(0, 160)}`);
    report.items.push({ course: t.course, examName: t.item.examName, error: String(e).slice(0, 300) });
  }
  writeFileSync(join(OUT, 'auto-answer-report.json'), JSON.stringify(report, null, 2), 'utf8');
  if (i < targets.length - 1) await sleep(1500);
}

report.finished = true;
writeFileSync(join(OUT, 'auto-answer-report.json'), JSON.stringify(report, null, 2), 'utf8');

const done = new Set(report.items.filter((x) => x.submitted && !x.reviewOnly).map((x) => `${x.course}|${x.examName}`)).size;
const skipped = new Set(report.items.filter((x) => !x.submitted).map((x) => `${x.course}|${x.examName}`)).size;
log('\n══════════ 完成 ══════════');
log(`提交成功 ${done} 份，未提交/异常 ${skipped} 份`);
log(`报告: recon\\apply\\auto-answer-report.json`);

await tidy(ctx).catch(() => {});
await close();
process.exit(skipped ? 1 : 0);
