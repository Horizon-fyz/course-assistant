// apply-homework.mjs —— 接管当前已打开的作业页面，模拟人类作答
//
// 核心设计（按用户要求）：
//   · 不主动开新标签页，避免刷新/时序问题；
//   · 先扫描当前所有标签页，找到已打开的作业页；
//   · 如果没找到，提示用户待完成的作业清单，让用户手动打开；
//   · 找到后，模拟人类：慢慢读题、慢慢点选、点保存/下一题，绝不提交。
//
// 安全边界：
//   · 默认 dry-run：只高亮预选，不点击；
//   · --apply 才真正点击（仍只点「保存/下一题」，绝不点「提交作业/暂存作业」）；
//   · 每次操作间加随机延迟，模拟人类节奏。
//
// 用法：
//   node src\apply-homework.mjs                        # 扫描当前页面，干跑
//   node src\apply-homework.mjs --apply                # 扫描 + 真实回填
//   node src\apply-homework.mjs --list                 # 只列出待完成作业，不操作
//   node src\apply-homework.mjs --no-ai                # 不启用 AI 兜底
//   node src\apply-homework.mjs --delay 800            # 自定义操作间隔(ms)
import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect, tidy } from './browser.mjs';
import { indexFromAnswersJson, resolveAnswer, buildLivePrompt, normalize, TYPE_LABELS } from './answer-engine.mjs';
import { createClient } from '../md-ai-answer/src/ai.mjs';

const ROOT = join(import.meta.dirname, '..');
const EXPORT = join(ROOT, 'export');
const OUT = join(ROOT, 'recon', 'apply');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const getArg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const LIST_ONLY = argv.includes('--list');
const USE_AI = !argv.includes('--no-ai');
const DELAY = Number(getArg('--delay', '600')) || 600;

const log = (m) => process.stdout.write(m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 模拟人类的随机延迟 */
const humanDelay = (base = DELAY) => sleep(base + Math.floor(Math.random() * 400));

// ---------- 读答案库 ----------
function loadAnswerIndex() {
  const preferred = join(EXPORT, '智慧树作业题库_打印版.answers.json');
  let file = existsSync(preferred) ? preferred : null;
  if (!file && existsSync(EXPORT)) {
    const cands = readdirSync(EXPORT).filter((f) => /\.answers\.json$/i.test(f))
      .map((f) => join(EXPORT, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    file = cands[0] || null;
  }
  if (!file) return { index: { byStem: new Map(), count: 0 }, file: null };
  try {
    const json = JSON.parse(readFileSync(file, 'utf8'));
    return { index: indexFromAnswersJson(json), file };
  } catch (e) {
    log('  ⚠️ 答案库解析失败：' + e.message);
    return { index: { byStem: new Map(), count: 0 }, file: null };
  }
}

// ---------- 列出待完成作业 ----------
function loadPendingHomework() {
  const papers = join(EXPORT, 'papers.json');
  const resolved = join(EXPORT, 'courses-resolved.json');
  if (!existsSync(papers)) return [];
  const data = JSON.parse(readFileSync(papers, 'utf8'));
  const rec = existsSync(resolved) ? JSON.parse(readFileSync(resolved, 'utf8')) : {};
  const out = [];
  for (const [course, items] of Object.entries(data)) {
    const recruitId = rec[course]?.recruitId;
    for (const it of items) {
      // 只列出未提交的（state=1, score=null）
      if (it.state !== 1 || it.score !== null) continue;
      out.push({
        course, examName: it.examName, problemNum: it.problemNum,
        url: `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/`
          + `${recruitId}/${it.id}/${it.examId}/${it.courseId}/5371/${it.meetCourseType ?? 0}`,
      });
    }
  }
  return out;
}

// ---------- 扫描当前标签页，找到作业页 ----------
async function findExamPage(ctx) {
  const pages = ctx.pages();
  log(`\n当前打开 ${pages.length} 个标签页：`);
  for (const p of pages) {
    const url = p.url();
    const isExam = /onlineexamh5new\.zhihuishu\.com.*dohomework/.test(url);
    log(`  ${isExam ? '★' : ' '} ${url.slice(0, 80)}`);
    if (isExam) return p;
  }
  return null;
}

// ---------- 页面内：读取当前题面 ----------
const READ_PAGE = () => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const subs = [...document.querySelectorAll('.examPaper_subject')].filter((s) => s.querySelector('.nodeLab'));
  return subs.map((s, qi) => {
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
        id: inp ? inp.value : null,
        checked: inp ? inp.checked : null,
        text: clean(detail?.innerText || lab.innerText || ''),
      };
    });
    const anchor = s.querySelector('.subject_num span[id^=anchor_]');
    const eid = anchor ? anchor.id.replace(/^anchor_/, '') : null;
    return {
      index: qi, eid, type, typeName, headText,
      stem: stemEl ? clean(stemEl.innerText) : '',
      options,
    };
  });
};

/** 按 (题目序号, 选项序号) 设置选项为目标状态；dry-run 时只描边 */
const ACT_ON_OPTIONS = ([qi, indexes, dry]) => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const subs = [...document.querySelectorAll('.examPaper_subject')].filter((s) => s.querySelector('.nodeLab'));
  const sub = subs[qi];
  if (!sub) return { ok: false, err: '题目不存在' };
  const labs = [...sub.querySelectorAll('.nodeLab')];
  const want = new Set(indexes);
  const before = labs.map((l) => { const i = l.querySelector('input'); return i ? i.checked : null; });

  for (let i = 0; i < labs.length; i++) {
    const lab = labs[i];
    const inp = lab.querySelector('input');
    const label = lab.querySelector('.label') || lab;
    const should = want.has(i);
    if (dry) {
      if (should) { label.style.outline = '2px dashed #2e7d32'; label.style.outlineOffset = '2px'; }
      continue;
    }
    if (inp && inp.checked === should) continue;
    label.click();
    if (inp && inp.checked !== should) {
      inp.checked = should;
      inp.dispatchEvent(new Event('click', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  const after = labs.map((l) => { const i = l.querySelector('input'); return i ? i.checked : null; });
  const got = after.map((c, i) => (c ? i : -1)).filter((i) => i >= 0);
  const ok = dry ? true : got.length > 0 && got.every((i) => want.has(i));
  return {
    ok,
    before, after,
    letters: indexes.map((oi) => clean(labs[oi]?.querySelector('.label span')?.innerText || '')).join(','),
  };
};

/** 点击「保存」或「下一题」（只点这两个，绝不碰提交/暂存） */
const CLICK_SAVE_OR_NEXT = ([which, dry]) => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const wanted = which === 'next' ? ['下一题'] : ['保存'];
  const nodes = [...document.querySelectorAll('button, a, [class*=btn], [class*=Btn], div[role=button]')];
  const hit = nodes.find((n) => wanted.includes(clean(n.innerText)));
  if (!hit) return { ok: false, err: `未找到「${wanted[0]}」按钮` };
  if (dry) return { ok: true, clicked: clean(hit.innerText), dry: true };
  hit.click();
  return { ok: true, clicked: clean(hit.innerText) };
};

const READ_STATE = () => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const nodes = [...document.querySelectorAll('button, a, [class*=btn], div[role=button]')];
  return {
    hasSubmit: nodes.some((n) => /提交作业/.test(clean(n.innerText))),
    hasNext: nodes.some((n) => clean(n.innerText) === '下一题'),
    hasPrev: nodes.some((n) => clean(n.innerText) === '上一题'),
    qCount: [...document.querySelectorAll('.examPaper_subject')].filter((s) => s.querySelector('.nodeLab')).length,
  };
};

// ---------- 主流程 ----------
log('══════════ 作业答案回填（接管模式） ══════════');
log(APPLY ? '模式: 真实回填（模拟人类点击，绝不提交）' : '模式: 干跑（只高亮预选）');

const { index, file } = loadAnswerIndex();
log(`答案库: ${file ? file.replace(ROOT + '\\', '') : '（无）'}  条目=${index.count}`);

// 列出待完成作业
const pending = loadPendingHomework();
log(`\n待完成作业（未提交）: ${pending.length} 份`);
for (const [i, p] of pending.entries()) {
  log(`  ${i + 1}. ${p.course} / ${p.examName}（${p.problemNum} 题）`);
}

if (LIST_ONLY) {
  log('\n（--list 模式，仅列出，不操作）');
  process.exit(0);
}

// 连接浏览器
const { ctx, describe, close } = await connect({
  prefer: getArg('--browser', 'chromium') === 'firefox' ? 'firefox' : 'chromium',
  exe: getArg('--browser-exe'),
});
log('\n浏览器: ' + describe);

// 扫描当前标签页
const examPage = await findExamPage(ctx);
if (!examPage) {
  log('\n⚠️ 未找到已打开的作业页面。');
  log('请手动在浏览器里打开上述任意一份作业（复制链接或从课程页进入），然后重新运行本脚本。');
  log('\n待完成链接（示例前 3 个）:');
  for (const p of pending.slice(0, 3)) log(`  ${p.url}`);
  await close();
  process.exit(2);
}

log('\n✓ 找到作业页面，开始接管…');
await examPage.bringToFront().catch(() => {});

// AI 客户端
let aiClient = null;
if (USE_AI) {
  try {
    const cfgFile = join(ROOT, 'md-ai-answer', 'config.json');
    const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};
    const baseUrl = process.env.AI_BASE_URL || cfg.baseUrl;
    const apiKey = process.env.AI_API_KEY || cfg.apiKey;
    if (baseUrl && apiKey) { aiClient = createClient({ ...cfg, baseUrl, apiKey }); log('AI 兜底: 已启用'); }
  } catch { /* 忽略 */ }
}

const ask = async (live) => {
  if (!aiClient) throw new Error('AI 未配置');
  return aiClient.chat(buildLivePrompt(live));
};

// 等待页面稳定
log('等待页面渲染…');
await sleep(3000);

const state0 = await examPage.evaluate(READ_STATE).catch(() => ({}));
log(`当前页面: ${state0.qCount ?? '?'} 道题；有「下一题」=${state0.hasNext}`);

const report = { at: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', items: [] };
const item = { questions: [], skipped: [], saved: false };
const answered = new Set();

const maxRounds = Math.max(1, Math.min(state0.qCount || 10, 50));
for (let round = 1; round <= maxRounds; round++) {
  const lives = await examPage.evaluate(READ_PAGE).catch(() => []);
  if (!lives.length) break;

  let fresh = 0;
  for (const live of lives) {
    const key = live.eid || normalize(live.stem) || `#${live.index}`;
    if (answered.has(key)) continue;
    answered.add(key);
    fresh++;

    // 模拟人类读题
    await humanDelay(300);
    log(`\n第 ${live.index + 1} 题 [${TYPE_LABELS[live.type] || live.type}]`);
    log(`  题干: ${live.stem.slice(0, 60)}${live.stem.length > 60 ? '…' : ''}`);

    const r = await resolveAnswer(live, { index, ask: aiClient ? ask : null });
    if (!r.ok) {
      log(`  ✗ 未解析：${r.note}`);
      item.skipped.push({ index: live.index, stem: live.stem, note: r.note });
      continue;
    }

    const letters = r.indexes.map((i) => live.options[i]?.letter || String(i + 1)).join('');
    log(`  → 答案: ${letters}（来源: ${r.source}）`);

    // 模拟人类思考后点击
    await humanDelay(500);
    const act = await examPage.evaluate(ACT_ON_OPTIONS, [live.index, r.indexes, !APPLY]).catch((e) => ({ ok: false, err: String(e).slice(0, 120) }));
    if (APPLY && !act.ok) log(`  ⚠️ 点选异常: ${act.err || '未知'}`);
    item.questions.push({ index: live.index, stem: live.stem, type: live.type, letters, source: r.source });
  }

  const after = await examPage.evaluate(READ_STATE).catch(() => ({}));
  const which = after.hasNext ? 'next' : 'save';
  await humanDelay(400);
  const next = await examPage.evaluate(CLICK_SAVE_OR_NEXT, [which, !APPLY]).catch((e) => ({ ok: false, err: String(e) }));
  log(`\n${APPLY ? '点击' : '将点击'}: ${next.clicked || next.err}`);
  item.saved = !!next.ok;
  if (!after.hasNext) break;
  if (fresh === 0) break;
  await sleep(2000);
}

report.items.push(item);
writeFileSync(join(OUT, 'apply-report.json'), JSON.stringify(report, null, 2), 'utf8');

log(`\n══════════ 完成 ══════════`);
log(`已解析 ${item.questions.length} 题，跳过 ${item.skipped.length} 题`);
log(`报告: recon\\apply\\apply-report.json`);
if (!APPLY) log('（干跑完成；确认无误后加 --apply 真实回填）');

await tidy(ctx).catch(() => {});
await close();
process.exit(item.skipped.length === 0 ? 0 : 1);
