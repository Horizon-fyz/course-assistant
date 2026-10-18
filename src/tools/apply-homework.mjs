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
//   node src\tools\apply-homework.mjs                        # 扫描当前页面，干跑
//   node src\tools\apply-homework.mjs --apply                # 扫描 + 真实回填
//   node src\tools\apply-homework.mjs --list                 # 只列出待完成作业，不操作
//   node src\tools\apply-homework.mjs --no-ai                # 不启用 AI 兜底
//   node src\tools\apply-homework.mjs --delay 800            # 自定义操作间隔(ms)
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { connect, tidy } from '../core/browser.mjs';
import { indexFromAnswersJson, resolveAnswer, buildLivePrompt, normalize, TYPE_LABELS } from '../flows/answer-engine.mjs';
import { createClient } from '../../md-ai-answer/src/ai.mjs';
import { mergeConfig, configFromEnv, pickReason } from '../../md-ai-answer/src/config.mjs';
import { DATA_DIR, readJson, writeJson, findCourse } from '../core/store.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
/** 数据目录：与其它模块统一（支持 ZHS_DATA_DIR 重定向） */
const EXPORT = DATA_DIR;
const OUT = join(ROOT, 'recon', 'apply');
mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const getArg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const APPLY = argv.includes('--apply');
const SCAN = argv.includes('--scan');       // 只读扫描：读页面题目 + 出答案，不点击
const scanOut = getArg('--out');            // 扫描结果输出路径
const LIST_ONLY = argv.includes('--list');
const USE_AI = !argv.includes('--no-ai');
const DELAY = Number(getArg('--delay', '600')) || 600;

const log = (m) => process.stdout.write(m + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 模拟人类的随机延迟 */
const humanDelay = (base = DELAY) => sleep(base + Math.floor(Math.random() * 400));

// ---------- 读答案库 ----------
function loadAnswerIndex() {
  // 1) 显式指定（桌面版通过环境变量传入）
  const explicit = process.env.ZHS_ANSWERS_JSON;
  if (explicit && existsSync(explicit)) {
    try {
      const json = JSON.parse(readFileSync(explicit, 'utf8'));
      return { index: indexFromAnswersJson(json), file: explicit };
    } catch (e) { log('  ⚠️ 指定的答案文件解析失败：' + e.message); }
  }

  // 2) 约定的文件名；3) 目录内最新的 *.answers.json / answers.json
  const preferred = join(EXPORT, '智慧树作业题库_打印版.answers.json');
  let file = existsSync(preferred) ? preferred : null;
  if (!file && existsSync(EXPORT)) {
    const cands = readdirSync(EXPORT).filter((f) => /(\.answers\.json|^answers\.json)$/i.test(f))
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
  const data = readJson(papers, null);
  if (!data || typeof data !== 'object') return [];
  const rec = readJson(resolved, {}) || {};
  // 课程缓存可能以 courseId 或课程名为 key，兼容两种
  const recOf = (course) => findCourse(rec, { courseName: course }) || {};
  const out = [];
  for (const [course, items] of Object.entries(data)) {
    if (!Array.isArray(items)) continue;
    const recruitId = recOf(course)?.recruitId;
    if (!recruitId) continue;         // 缺 recruitId 时拼不出有效链接，直接跳过而不是产出坏 URL
    for (const it of items) {
      // 只列出未提交的（state=1, score=null）
      if (it.state !== 1 || it.score !== null) continue;
      out.push({
        course, examName: it.examName, problemNum: it.problemNum, examId: it.examId,
        url: `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/`
          + `${recruitId}/${it.id}/${it.examId}/${it.courseId}/5371/${it.meetCourseType ?? 0}`,
      });
    }
  }
  return out;
}

// ---------- 扫描当前标签页，找到作业页 ----------
async function findExamPage(ctx, pending = []) {
  const pages = ctx.pages();
  log(`\n当前打开 ${pages.length} 个标签页：`);
  const candidates = [];
  for (const p of pages) {
    const url = p.url();
    const isExam = /onlineexamh5new\.zhihuishu\.com.*dohomework/.test(url);
    log(`  ${isExam ? '★' : ' '} ${url.slice(0, 80)}`);
    if (isExam) candidates.push(p);
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  // 多个作业页时，优先选「待完成清单」里对应的那份，避免接管到已提交的作业
  const hit = candidates.find((p) => pending.some((x) => x.examId && p.url().includes(String(x.examId))));
  return hit || candidates[0];
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
    // .subject_describe 的文本节点常为空（动态字体），回退到 .subject_stem 再去掉题型前缀
    const stem = (stemEl ? clean(stemEl.innerText) : '')
      || clean(headEl?.innerText || '').replace(/^【[^】]*】\s*/, '');
    return {
      index: qi, eid, type, typeName, headText,
      stem,
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
  // 真实选中态在 span.ABCase / .node_detail 的 onChecked 类上，input.checked 恒为 false
  const isChecked = (lab) => {
    const inp = lab.querySelector('input');
    if (inp?.checked) return true;
    const span = lab.querySelector('.label span');
    const detail = lab.querySelector('.node_detail, .examquestions-answer');
    return /(^|\s)onChecked(\s|$)/.test(span?.className || '')
      || /(^|\s)onChecked(\s|$)/.test(detail?.className || '');
  };
  const readChecked = () => labs.map(isChecked);
  const before = readChecked();

  for (let i = 0; i < labs.length; i++) {
    const lab = labs[i];
    const label = lab.querySelector('.label') || lab;
    const should = want.has(i);
    if (dry) {
      if (should) { label.style.outline = '2px dashed #2e7d32'; label.style.outlineOffset = '2px'; }
      continue;
    }
    if (isChecked(lab) === should) continue;
    label.click();
    // 不用 JS 强改 input 状态（会和 Vue 的双向绑定打架），只重试一次真实点击
    if (isChecked(lab) !== should) label.click();
  }

  const after = readChecked();
  const ok = dry ? true
    : indexes.every((i) => after[i])
      && after.every((c, i) => (want.has(i) ? c : !c));
  return {
    ok,
    before, after,
    letters: indexes.map((oi) => clean(labs[oi]?.querySelector('.label span')?.innerText || '')).join(','),
  };
};

/** 点击「保存」或「下一题」（只点这两个，绝不碰提交/暂存） */
const CLICK_SAVE_OR_NEXT = ([which, dry]) => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const vis = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const enabled = (n) => !n.disabled && !/disabled/i.test(n.className || '');
  const wanted = which === 'next' ? ['下一题'] : ['保存'];
  const nodes = [...document.querySelectorAll('button, a, [class*=btn], [class*=Btn], div[role=button]')];
  const hit = nodes.find((n) => wanted.includes(clean(n.innerText)) && vis(n) && enabled(n));
  if (!hit) return { ok: false, err: `未找到「${wanted[0]}」按钮` };
  if (dry) return { ok: true, clicked: clean(hit.innerText), dry: true };
  hit.click();
  return { ok: true, clicked: clean(hit.innerText) };
};

const READ_STATE = () => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const vis = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const nodes = [...document.querySelectorAll('button, a, [class*=btn], div[role=button]')].filter(vis);
  return {
    hasSubmit: nodes.some((n) => /提交作业/.test(clean(n.innerText))),
    hasNext: nodes.some((n) => clean(n.innerText) === '下一题' && !n.disabled),
    hasPrev: nodes.some((n) => clean(n.innerText) === '上一题' && !n.disabled),
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
const examPage = await findExamPage(ctx, pending);
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
    const cfg = mergeConfig(existsSync(cfgFile) ? readJson(cfgFile, {}) : {}, configFromEnv(process.env));
    const r = pickReason(cfg);
    if (r.baseUrl && r.apiKey) {
      aiClient = createClient({ baseUrl: r.baseUrl, apiKey: r.apiKey, model: r.model, timeoutMs: cfg.timeoutMs, maxRetries: cfg.maxRetries });
      log(`AI 兜底: 已启用（${r.model}）`);
    }
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

// ---------- 扫描模式：只读页面、给出答案，绝不点击 ----------
if (SCAN) {
  const outFile = scanOut || join(EXPORT, 'scan-result.json');
  const lives = await examPage.evaluate(READ_PAGE).catch(() => []);
  if (!lives.length) {
    log('\n⚠️ 当前页面没有读到题目，请确认作业页已加载完成。');
    await close();
    process.exit(1);
  }

  log(`\n扫描到 ${lives.length} 道题，正在生成答案…`);
  const questions = [];
  let okCount = 0, skipCount = 0;

  for (const live of lives) {
    const r = await resolveAnswer(live, { index, ask: aiClient ? ask : null });
    const letters = r.ok ? r.indexes.map((i) => live.options[i]?.letter || String(i + 1)).join('') : '';
    if (r.ok) okCount++; else skipCount++;
    log(`  ${String(live.index + 1).padStart(2)}. [${TYPE_LABELS[live.type] || live.type}] ${letters || '✗ ' + r.note}  ${live.stem.slice(0, 40)}`);
    questions.push({
      id: live.index + 1,
      number: String(live.index + 1),
      type: live.type,
      stem: live.stem,
      options: (live.options || []).map((o, i) => ({
        key: o.letter || String.fromCharCode(65 + i),
        text: o.text,
      })),
      answer: letters,
      reason: r.note || '',
      confidence: null,
    });
  }

  writeJson(outFile, {
    meta: { source: '当前网页', pageUrl: examPage.url(), generatedAt: new Date().toISOString(), count: questions.length },
    questions,
  });

  log(`\n已解析 ${okCount} 题，未解析 ${skipCount} 题`);
  log(`结果已写入: ${outFile}`);
  log('（扫描模式：只读，未点击任何东西）');
  await close();
  process.exit(skipCount === 0 ? 0 : 1);
}

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
    if (APPLY && !act.ok) {
      log(`  ⚠️ 点选异常: ${act.err || '选中状态校验失败'}`);
      item.skipped.push({ index: live.index, stem: live.stem, note: '选项点击未生效' });
      continue;
    }
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
writeJson(join(OUT, 'apply-report.json'), report);

log(`\n══════════ 完成 ══════════`);
log(`已解析 ${item.questions.length} 题，跳过 ${item.skipped.length} 题`);
log(`报告: recon\\apply\\apply-report.json`);
if (!APPLY) log('（干跑完成；确认无误后加 --apply 真实回填）');

await tidy(ctx).catch(() => {});
await close();
process.exit(item.skipped.length === 0 ? 0 : 1);
