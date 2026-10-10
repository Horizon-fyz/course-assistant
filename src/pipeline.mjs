// 一键全流程：多浏览器 → 会话校验 → 动态发现课程 → 批量抓题 → 安全检查 → 生成文档
//
// 用法：
//   node src\pipeline.mjs                  # Edge/Chrome，抓全部课程
//   node src\pipeline.mjs --browser firefox
//   node src\pipeline.mjs --dry-run        # 只发现课程，不抓题
//   node src\pipeline.mjs --course 国家安全教育   # 只处理指定课程
//
// 安全保证：全程只「进入试卷读取题目」，绝不点击「提交作业」「暂存作业」；
//          结束后自动复查每份作业的 state/backNum 是否仍为未提交状态。
import { writeFileSync, mkdirSync, existsSync, readFileSync, writeSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { connect, readyPage, tidy, HOME } from './browser.mjs';
import { PY } from './python.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
const EXPORT = BASE + '\\export';
mkdirSync(EXPORT, { recursive: true });

// 日志同时写控制台和文件（管道缓冲会导致控制台看不到实时进度）
const LOGFILE = EXPORT + '\\pipeline.log';
try { writeFileSync(LOGFILE, ''); } catch {}
const log = (m) => {
  const line = String(m);
  try { writeSync(1, line + '\n'); } catch {}
  try { appendFileSync(LOGFILE, line + '\n', 'utf8'); } catch {}
};

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const getArg = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const prefer = getArg('--browser', 'chromium') === 'firefox' ? 'firefox' : 'chromium';
const dryRun = argv.includes('--dry-run');
const onlyCourse = getArg('--course');

const SIG_COURSE = 'NEuH3llD9woD4DQgu0k6Uvp5yyo8WT84Dq5lU2iPwvgKNatePzJ+vu/4PRaNYy+K';
const COURSES_CACHE = EXPORT + '\\courses-resolved.json';
const PAPERS = EXPORT + '\\papers.json';

let _ctx = null;
const getCtx = () => _ctx;

// ---------- 1) 会话校验（带重试，容忍重定向导致的上下文销毁） ----------
async function checkLogin(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // 先确保停在站内页面，避免未登录时被重定向打断
      if (!page.url().includes('zhihuishu.com')) {
        await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await page.waitForTimeout(4000);
      }
      return await page.evaluate(async () => {
        const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
        const j = await r.json();
        return { code: j.code, user: j.result };
      });
    } catch (e) {
      log(`      校验重试 ${attempt}/3: ${String(e).slice(0, 70)}`);
      await page.waitForTimeout(3000);
    }
  }
  return { code: -1, error: '校验失败（页面持续跳转）' };
}

// ---------- 2) 动态发现课程（带重试） ----------
async function discoverCourses(page) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await page.evaluate(async (sig) => {
        const res = await fetch('https://onlineservice-api.zhihuishu.com/gateway/t/v1/student/course/share/queryShareCourseInfo', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secretStr: sig, date: Date.now(), pageNo: 1, pageSize: 100 }).toString(),
        });
        const j = await res.json();
        return {
          code: j.code,
          list: (j?.result?.courseOpenDtos || []).map((c) => ({
            courseId: c.courseId, courseName: c.courseName, teacherName: c.teacherName,
            recruitId: c.recruitId, secret: c.secret, progress: c.progress,
          })),
        };
      }, SIG_COURSE);
      return r;
    } catch (e) {
      log(`      发现重试 ${attempt}/3: ${String(e).slice(0, 70)}`);
      await page.waitForTimeout(3000);
    }
  }
  return { code: -1, list: [] };
}

// ---------- 3) 关闭「学前必读」弹窗 ----------
// 该弹窗带 .mask 遮罩，会盖住「作业考试」等菜单，导致点击超时。
// 注意：弹窗并非每次出现，且出现有延迟，所以要等待 + 重试 + 确认。
async function closePreStudyDialog(page) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const visible = await page.evaluate(() => {
      const d = document.querySelector('.dialog-read');
      if (!d) return false;
      const r = d.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(d).display !== 'none';
    }).catch(() => false);

    if (!visible) {
      if (attempt === 1) {
        // 首次未见，给它一点时间出现
        await page.waitForTimeout(2500);
        continue;
      }
      return true;   // 确认无遮罩
    }

    try {
      await page.locator('.dialog-read .iconguanbi').first().click({ timeout: 10000 });
      await page.waitForTimeout(1500);
    } catch {
      // 图标被挡时退回用事件直接触发
      await page.evaluate(() => {
        const i = document.querySelector('.dialog-read .iconguanbi');
        if (i) { i.click(); i.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }
  // 最终确认
  return page.evaluate(() => {
    const d = document.querySelector('.dialog-read');
    if (!d) return true;
    const r = d.getBoundingClientRect();
    return !(r.width > 0 && r.height > 0);
  }).catch(() => false);
}

// ---------- 4) 解析考试页 listRid ----------
// 注意：必须在 evaluate 之外点击。点击会触发页面导航，
// 若把 click 放在 evaluate 内部，执行上下文会被销毁导致永远不返回。
async function captureListRid(page) {
  // 1) 先装钩子
  await page.evaluate(() => {
    window.__cap = [];
    if (!window.__hookedOpen) {
      window.__hookedOpen = true;
      window.open = function (...a) { try { window.__cap.push(String(a[0] || '')); } catch {} return null; };
    }
  }).catch(() => {});

  // 2) 在 evaluate 外用 locator 点击
  try {
    await page.getByText('作业考试', { exact: true }).first().click({ timeout: 20000 });
  } catch (e) {
    return { err: '点击「作业考试」失败: ' + String(e).split('\n')[0].slice(0, 90) };
  }

  await page.waitForTimeout(4000);

  // 3) 再读钩子结果（重新求值，容忍导航）
  for (let i = 0; i < 3; i++) {
    try {
      const cap = await page.evaluate(() => window.__cap || []);
      const hit = (cap || []).filter((u) => /onlineexamh5new/.test(u)).pop();
      if (hit) {
        const m = hit.match(/recruitId=([^&]+)/);
        return { rid: m ? m[1] : null, url: hit };
      }
      if (cap?.length) return { err: '捕获到 URL 但非考试页', cap: cap.slice(-3) };
    } catch {
      // 页面正在导航，等下一轮
    }
    await page.waitForTimeout(2500);
  }
  return { err: '未捕获到考试页 URL' };
}

// ---------- 4) 取作业列表 ----------
async function fetchHomework(page, listRid) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let body = null;
    const onRes = async (r) => { if (/getStudentHomework/.test(r.url())) { try { body = await r.text(); } catch {} } };
    page.on('response', onRes);
    try {
      await page.goto(`https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList?recruitId=${listRid}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.reload({ waitUntil: 'networkidle', timeout: 45000 });
    } catch {}
    await page.waitForTimeout(9000);
    page.off('response', onRes);
    if (body) { try { const l = JSON.parse(body).rt.studentHomeworkList; if (l) return l; } catch {} }
    log(`      作业列表重试 ${attempt}/3…`);
  }
  return [];
}

// ---------- 5) 抓单份试卷（只读，不提交） ----------
async function grabPaper(page, url, timeout = 25000) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let resolveFn = null;
    const handler = async (r) => {
      if (!/student\/doHomework/.test(r.url())) return;
      let t = ''; try { t = await r.text(); } catch { return; }
      if (resolveFn) { const f = resolveFn; resolveFn = null; f(t); }
    };
    page.on('response', handler);
    const p = new Promise((res) => { resolveFn = res; setTimeout(() => { if (resolveFn === res) { resolveFn = null; res(null); } }, timeout); });
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (attempt === 1) await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    } catch {}
    const raw = await p;
    page.off('response', handler);
    if (raw) { try { return JSON.parse(raw); } catch {} }
  }
  return null;
}

// ================= 主流程 =================
log('══════════ 智慧树全流程自动化 ══════════');
log(`浏览器: ${prefer}   模式: ${dryRun ? '仅发现课程(dry-run)' : '完整抓取'}   ${onlyCourse ? '限定课程: ' + onlyCourse : ''}\n`);

const { ctx, describe, close } = await connect({ prefer });
_ctx = ctx;
log('[1] 浏览器: ' + describe);

const page = await readyPage(ctx, HOME);
await page.waitForTimeout(5000);

log('\n[2] 校验登录态…');
const login = await checkLogin(page);
if (login.code !== 200) {
  log('  ❌ 未登录：' + JSON.stringify(login));
  log('     请在浏览器窗口里登录一次，然后重跑本脚本。');
  log('     窗口地址: ' + page.url());
  await tidy(ctx);
  await close();
  process.exit(2);
}
log(`  ✅ 已登录：${login.user.realName}`);

log('\n[3] 动态发现课程…');
const { code, list } = await discoverCourses(page);
log(`  接口 code=${code}，发现 ${list.length} 门课程`);
if (!list.length) { log('  ⚠️ 没有课程'); await close(); process.exit(3); }
for (const c of list) log(`    · ${c.courseName}  courseId=${c.courseId} recruitId=${c.recruitId} 进度=${c.progress}`);

if (dryRun) {
  log('\n[dry-run] 仅发现，不抓题。退出。');
  await tidy(ctx);
  await close();
  process.exit(0);
}

// 解析每门课的 listRid（考试页参数）
// 复用 resolve-courses.mjs 的捕获逻辑：钩子与点击分离，避免 evaluate 内点击导致上下文销毁
const cache = existsSync(COURSES_CACHE) ? JSON.parse(readFileSync(COURSES_CACHE, 'utf8')) : {};
const targets = [];
for (const c of list) {
  if (onlyCourse && c.courseName !== onlyCourse) continue;
  let listRid = cache[c.courseName]?.listRid || null;
  const secret = c.secret || cache[c.courseName]?.secret || null;

  if (!listRid) {
    log(`\n[4] 解析「${c.courseName}」考试入口…`);
    try {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4500);

      // 点课程（定位器已验证唯一）
      log('    · 定位课程元素…');
      const cloc = page.locator(`text=${c.courseName}`);
      log('      匹配数: ' + (await cloc.count()));
      await cloc.first().click({ timeout: 12000 });
      await page.waitForTimeout(9000);
      log('    · 已进入: ' + page.url().slice(0, 90));

      // 关学前必读（可能不出现，且带遮罩会挡住菜单）
      const cleared = await closePreStudyDialog(page);
      log('    弹窗处理: ' + (cleared ? '已清除/无弹窗' : '⚠️ 仍存在'));

      const r = await captureListRid(page);
      if (r.rid) { listRid = r.rid; log('    ✓ listRid=' + decodeURIComponent(r.rid)); }
      else log('    ✗ 失败: ' + (r.err || '?'));

      // 若接口未直接给出 secret，则从视频页 URL 兜底解析
      if (!secret) {
        const m = page.url().match(/recruitAndCourseId=([0-9a-f]+)/i);
        if (m) log('    ✓ secret=' + m[1]);
      }
    } catch (e) { log('    ✗ 进入课程失败: ' + String(e).split('\n')[0].slice(0, 90)); }
  } else {
    log(`\n[4] 「${c.courseName}」已有 listRid，跳过解析`);
  }

  cache[c.courseName] = { secret, listRid, courseId: c.courseId, recruitId: c.recruitId, updatedAt: new Date().toISOString() };
  writeFileSync(COURSES_CACHE, JSON.stringify(cache, null, 2), 'utf8');
  targets.push({ ...c, secret, listRid });
}

log('\n[5] 批量抓题（只进入试卷，绝不提交）…');
const all = existsSync(PAPERS) ? JSON.parse(readFileSync(PAPERS, 'utf8')) : {};
const examPage = await ctx.newPage();

for (const c of targets) {
  if (!c.listRid) { log(`  ✗ ${c.courseName}: 缺少 listRid，跳过`); continue; }
  log(`\n  ── ${c.courseName} ──`);
  const items = await fetchHomework(examPage, c.listRid);
  log(`     作业 ${items.length} 份`);
  if (!items.length) continue;

  const collected = [];
  for (const [i, hw] of items.entries()) {
    const url = `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/${c.recruitId}/${hw.id}/${hw.examId}/${c.courseId}/5371/${hw.meetCourseType ?? 0}`;
    const paper = await grabPaper(examPage, url);
    const base = paper?.rt?.examBase;
    const n = (base?.workExamParts || []).flatMap((x) => x.questionDtos || []).length;
    collected.push({ ...hw, paper });
    all[c.courseName] = collected;
    writeFileSync(PAPERS, JSON.stringify(all, null, 2), 'utf8');
    log(`     [${String(i + 1).padStart(2)}/${items.length}] ${hw.examName} → ${base ? `✓ ${n} 题` : '✗ 未捕获'}`);
  }
}

// ---------- 6) 安全复查 ----------
log('\n[6] 安全复查（确认未提交、次数未消耗）…');
let bad = 0, total = 0;
for (const c of targets) {
  if (!c.listRid) continue;
  const items = await fetchHomework(examPage, c.listRid);
  for (const x of items) {
    total++;
    const ok = x.state === 1 && x.backNum === 3 && x.score === null;
    if (!ok) { bad++; log(`     ⚠️ ${c.courseName} / ${x.examName}: state=${x.state} backNum=${x.backNum} score=${x.score}`); }
  }
  log(`     ${c.courseName}: ${items.length} 份，异常 ${items.filter((x) => !(x.state === 1 && x.backNum === 3 && x.score === null)).length} 份`);
}
log(`\n     总计 ${total} 份作业，异常 ${bad} 份  ${bad === 0 ? '✅ 全部未提交' : '⚠️ 需人工核查'}`);

// ---------- 7) 生成打印稿 ----------
// ZHS_SKIP_DOCS=1 时跳过文档生成（由上层 zhs.mjs 的 docs 阶段统一产出，避免重复生成）
const skipDocs = process.env.ZHS_SKIP_DOCS === '1';

if (!skipDocs) {
log('\n[7] 生成打印稿…');
const py = PY;
const r = spawnSync(py, [EXPORT + '\\make-docx.py'], { encoding: 'utf8' });
log(r.stdout?.trim() || r.stderr?.slice(0, 300) || '(无输出)');

// 同时生成 Markdown 版（可读 + 可打印），保证与 docx 同步，不会忘记重跑
log('\n[8] 生成 Markdown 题库…');
const mdScript = join(ROOT, 'recon', 'make-md.mjs');
if (existsSync(mdScript)) {
  for (const extra of [[], ['--bare']]) {
    const m = spawnSync(process.execPath, [mdScript, ...extra], { encoding: 'utf8' });
    log((m.stdout || '').trim() || (m.stderr || '').trim() || '(无输出)');
  }
  // 打印预览 HTML + PDF（无头 Edge），失败不影响主流程
  const pdfScript = join(ROOT, 'recon', 'make-pdf.mjs');
  if (existsSync(pdfScript)) {
    const p = spawnSync(process.execPath, [pdfScript], { encoding: 'utf8' });
    log((p.stderr || '').trim() || '(PDF 已生成)');
  }
} else {
  log('   跳过：未找到 recon\\make-md.mjs');
}

log('\n══════════ 完成 ══════════');
log('题库数据: export\\papers.json');
log('Word 稿 : export\\智慧树作业题库_打印版.docx');
log('Markdown: export\\智慧树作业题库_打印版.md');
log('PDF 稿  : export\\智慧树作业题库_打印版.pdf');
} else {
  log('\n[7][8] 跳过文档生成（ZHS_SKIP_DOCS=1，由 zhs.mjs docs 统一产出）');
}

await tidy(ctx);
await close();
process.exit(bad === 0 ? 0 : 1);
