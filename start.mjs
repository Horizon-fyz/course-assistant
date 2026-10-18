#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
//  一键全自动：启动浏览器 → 等登录 → 自动答题 → 自动看课 → 汇总
//
//  双击「一键开始.exe」即可，不需要输入任何命令。
//  需要登录时会在浏览器里等你，登录成功后自动继续。
//
//  可选参数（一般不用）：
//    --browser auto       浏览器：auto（默认）/ chromium / firefox
//    --browser-exe PATH   直接指定浏览器可执行文件（Firefox 也能自动识别）
//    --no-homework        跳过答题
//    --no-watch           跳过看课
//    --login-timeout 15   等待登录的分钟数（默认 15）
//    --retries 1          每阶段失败后的自动重试次数（默认 1）
// ═══════════════════════════════════════════════════════════════════
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { connect, readyPage, tidy, HOME, listAvailableBrowsers } from './src/browser.mjs';

const ROOT = import.meta.dirname ?? dirname(fileURLToPath(import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || join(ROOT, 'ms-playwright');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const getArg = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const DO_HOMEWORK = !has('--no-homework');
const DO_WATCH = !has('--no-watch');

/* ───────── 浏览器选择 ───────── */

const BROWSER_ARG = String(getArg('--browser', 'auto')).toLowerCase();
const BROWSER_EXE = getArg('--browser-exe');

/** 按可执行文件名判断种类（Firefox 走 BiDi，其余走 CDP） */
function kindFromExe(exe) {
  return /firefox/i.test(basename(String(exe))) ? 'firefox' : 'chromium';
}

/**
 * 解析实际要用的浏览器：
 *   auto    → 优先 Chromium 系，没有才用 Firefox
 *   chromium / chrome → Chromium 系
 *   firefox → Firefox
 * 指定 --browser-exe 时以文件名判定种类。
 */
function resolveBrowser() {
  if (BROWSER_EXE) {
    if (!existsSync(BROWSER_EXE)) {
      process.stderr.write('✗ 指定的浏览器不存在：' + BROWSER_EXE + '\n');
      process.exit(1);
    }
    return { prefer: kindFromExe(BROWSER_EXE), exe: BROWSER_EXE, auto: false };
  }
  if (BROWSER_ARG === 'firefox') return { prefer: 'firefox', exe: null, auto: false };
  if (BROWSER_ARG === 'chromium' || BROWSER_ARG === 'chrome' || BROWSER_ARG === 'edge') {
    return { prefer: 'chromium', exe: null, auto: false };
  }
  const list = listAvailableBrowsers();
  const prefer = list.some((b) => b.kind === 'chromium') ? 'chromium'
    : list.some((b) => b.kind === 'firefox') ? 'firefox'
      : 'chromium'; // 都没有时仍返回 chromium，交给 connect 给出安装提示
  return { prefer, exe: null, auto: true };
}

const BROWSER = resolveBrowser();

/** 传给子进程（答题 / 看课 / 抓数据）的浏览器参数，prefer 可能被回退改写，故每次现算 */
function browserArgs() {
  const out = ['--browser', BROWSER.prefer];
  if (BROWSER.exe) out.push('--browser-exe', BROWSER.exe);
  return out;
}
const LOGIN_MS = Math.max(1, Number(getArg('--login-timeout', '15')) || 15) * 60_000;
const RETRIES = Math.max(0, Number(getArg('--retries', '1')) || 1);

const ANSWER_REPORT = join(ROOT, 'recon', 'apply', 'auto-answer-report.json');
const WATCH_REPORT = join(ROOT, 'recon', 'apply', 'watch-report.json');
const PAPERS = join(ROOT, 'export', 'papers.json');
const COURSES = join(ROOT, 'export', 'courses-resolved.json');

/* ───────── 输出 ───────── */
const C = process.stdout.isTTY
  ? { r: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', c: '\x1b[36m' }
  : { r: '', b: '', d: '', g: '', y: '', red: '', c: '' };
const say = (m = '') => process.stdout.write(m + '\n');
const good = (m) => say(`${C.g}✓${C.r} ${m}`);
const warn = (m) => say(`${C.y}!${C.r} ${m}`);
const bad = (m) => say(`${C.red}✗${C.r} ${m}`);
const info = (m) => say(`${C.d}  ${m}${C.r}`);
const head = (m) => say(`\n${C.b}${C.c}${m}${C.r}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** 只认「本次运行之后更新过」的报告，避免拿上次的旧报告误判 */
function readFresh(file, sinceMs) {
  try {
    if (!existsSync(file)) return null;
    if (statSync(file).mtimeMs < sinceMs - 1500) return null;
    return readJson(file);
  } catch { return null; }
}

function runNode(script, args = []) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], { cwd: ROOT, stdio: 'inherit' });
  return r.status ?? 1;
}

/* ───────── 登录 ───────── */

const LOGIN_PROBE = async () => {
  try {
    const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/f/v1/login/getLoginUserInfo', { credentials: 'include' });
    const j = await r.json();
    return { code: j?.code, user: j?.result ?? null };
  } catch (e) { return { error: String(e) }; }
};

/**
 * 连上浏览器 → 检查登录；没登录就等用户手动登录。
 * 每次调用结束都会断开连接（不关浏览器），把现场留给下一个阶段。
 */
async function ensureLogin() {
  let conn;
  // auto 模式下 Chromium 起不来时自动改用 Firefox（例如只装了 Firefox 的机器）
  const attempts = BROWSER.auto && BROWSER.prefer === 'chromium'
    ? [{ prefer: 'chromium', exe: null }, { prefer: 'firefox', exe: null }]
    : [{ prefer: BROWSER.prefer, exe: BROWSER.exe }];

  for (const a of attempts) {
    try {
      conn = await connect({ prefer: a.prefer, exe: a.exe });
      if (a.prefer !== BROWSER.prefer || a.exe !== BROWSER.exe) {
        warn(`Chromium 系浏览器不可用，已自动改用 Firefox`);
        BROWSER.prefer = 'firefox';
        BROWSER.exe = null;
      }
      break;
    } catch (e) {
      if (a !== attempts[attempts.length - 1]) {
        warn(`${a.prefer === 'firefox' ? 'Firefox' : 'Chromium 系浏览器'}启动失败：` + String(e).slice(0, 160));
      } else {
        bad('浏览器启动失败：' + String(e).slice(0, 200));
        if (a.prefer === 'firefox') info('请先安装 Firefox，或用 --browser-exe 指定浏览器路径。');
        else info('请先安装 Edge/Chrome/Firefox 之一，或用 --browser firefox / --browser-exe 指定。');
      }
    }
  }
  if (!conn) return { ok: false, reason: 'browser' };
  const { ctx, describe, close } = conn;
  let page;
  try {
    info('浏览器：' + describe);
    page = await readyPage(ctx, HOME);
    await tidy(ctx);

    const t0 = Date.now();
    let told = false;
    let lastTick = 0;
    while (true) {
      if (page.isClosed()) page = await readyPage(ctx, HOME);
      const chk = await page.evaluate(LOGIN_PROBE).catch(() => null);

      if (chk?.code === 200) {
        const who = chk.user?.realName || chk.user?.schoolName || '当前账号';
        good(`已登录：${who}`);
        return { ok: true, user: chk.user };
      }
      if (Date.now() - t0 > LOGIN_MS) {
        bad(`等待登录超时（${Math.round(LOGIN_MS / 60_000)} 分钟）`);
        return { ok: false, reason: 'timeout' };
      }
      if (!told) {
        told = true;
        say('');
        warn('还没有登录。请在弹出的浏览器窗口里完成登录（扫码或账号密码都行）。');
        info('登录成功后我会自动继续，不用回来按任何键。');
        say('');
      } else if (Date.now() - lastTick > 15_000) {
        lastTick = Date.now();
        info(`[${now()}] 仍在等待登录……（已等 ${Math.floor((Date.now() - t0) / 1000)} 秒）`);
      }
      await sleep(3000);
    }
  } finally {
    await tidy(ctx).catch(() => {});
    await close().catch(() => {});
  }
}

/* ───────── 数据检查 ───────── */

function countKeys(file) {
  const j = readJson(file);
  return j && typeof j === 'object' ? Object.keys(j).length : 0;
}

function dataState() {
  return { answer: countKeys(PAPERS) > 0, watch: countKeys(COURSES) > 0 };
}

/* ───────── 答题 ───────── */

async function stageHomework() {
  head('自动答题');
  const max = RETRIES + 1;
  let last = { ok: true, submitted: 0, failed: 0, note: '没有需要处理的作业' };

  for (let attempt = 1; attempt <= max; attempt++) {
    if (attempt > 1) info(`10 秒后重新检查未提交作业（第 ${attempt} 次）……`);
    const t0 = Date.now();
    const code = runNode('src/auto-homework.mjs', [...browserArgs(), '--force']);
    const rep = readFresh(ANSWER_REPORT, t0);
    if (!rep || rep.finished !== true) {
      const why = rep ? '答题脚本未正常结束（报告不完整）' : '答题脚本未产出报告';
      last = { ok: false, skipped: false, submitted: 0, failed: 0, note: why };
      bad(`${why}${code ? `（退出码 ${code}）` : ''}`);
      if (attempt < max) await sleep(10_000);
      continue;
    }
    const items = rep.items ?? [];
    const submitted = new Set(items.filter((x) => x.submitted && !x.reviewOnly)
      .map((x) => `${x.course}|${x.examName}`)).size;
    // 同一份作业可能因重做递归出现多条记录，按「课程|作业名」去重
    const failedMap = new Map();
    for (const x of items) if (!x.submitted) failedMap.set(`${x.course}|${x.examName}`, x);
    const failed = [...failedMap.values()];
    last = { ok: failed.length === 0, submitted, failed: failed.length, report: rep };

    if (failed.length === 0) {
      good(submitted ? `提交成功 ${submitted} 份` : '没有需要处理的作业');
      return last;
    }
    bad(`有 ${failed.length} 份未提交成功`);
    for (const it of failed.slice(0, 3)) {
      const why = it.error || (it.skipped?.length ? `有 ${it.skipped.length} 题无法确定答案` : '');
      if (why) info(`· ${it.course || ''} ${it.examName || ''}：${why}`);
    }
    if (attempt < max) await sleep(10_000);
  }
  warn('答题重试后仍未全部完成');
  return last;
}

/* ───────── 看课 ───────── */

function summarizeWatch(rep) {
  const courses = rep?.courses ?? [];
  const lessons = courses.flatMap((c) => c.lessons ?? []);
  const n = { done: 0, partial: 0, paused: 0, blocked: 0, error: 0, skipped: 0 };
  for (const l of lessons) if (l.status in n) n[l.status]++;
  return {
    lessons: lessons.length,
    ...n,
    courseErrors: courses.filter((c) => c.error).map((c) => `${c.course}：${c.error}`),
    blockedNotes: lessons.filter((l) => l.status === 'blocked')
      .map((l) => `${l.no} ${l.title}${l.note ? '：' + l.note : ''}`),
    errorNotes: lessons.filter((l) => /error|partial|paused/.test(l.status))
      .map((l) => `${l.no} ${l.title}${l.note ? '：' + l.note : ''}`),
  };
}

async function stageWatch() {
  head('自动看课');
  const max = RETRIES + 1;
  let last = { ok: false, note: '看课未执行' };

  for (let attempt = 1; attempt <= max; attempt++) {
    if (attempt > 1) info(`20 秒后重试（第 ${attempt} 次，已看完的课节会自动跳过）……`);
    const t0 = Date.now();
    const code = runNode('src/watch-course.mjs', browserArgs());
    const rep = readFresh(WATCH_REPORT, t0);
    const s = summarizeWatch(rep);

    if (!rep || rep.finished !== true) {
      const why = rep ? '看课脚本未正常结束（报告不完整）' : '看课脚本未产出报告';
      last = { ok: false, note: why, ...s };
      bad(`${why}${code ? `（退出码 ${code}）` : ''}`);
      if (attempt < max) await sleep(20_000);
      continue;
    }

    last = { ok: true, ...s };

    if (s.blocked) {
      last.ok = false;
      warn('看课被平台拦下，自动重试没有意义，已停下：');
      for (const m of s.blockedNotes.slice(0, 5)) info('· ' + m);
      info('人脸识别会自动等待你完成；走到这里通常是平台硬限制（学习时间已达上限 / 异常脚本风控）。');
      info('稍后重新双击「一键开始.exe」即可从未完成处继续，已看完的课节不会重做。');
      return last;
    }

    const trouble = s.error + s.partial + s.paused + s.courseErrors.length;
    if (trouble === 0) {
      good(`完成 ${s.done} 节${s.lessons ? `（共 ${s.lessons} 节）` : ''}`);
      return last;
    }

    bad(`完成 ${s.done} 节 · 未播完/异常 ${trouble} 节`);
    for (const m of [...s.courseErrors, ...s.errorNotes].slice(0, 5)) info('· ' + m);
    last.ok = false;
    if (attempt < max) await sleep(20_000);
  }

  warn('看课重试后仍有未完成课节');
  return last;
}

/* ───────── 主流程 ───────── */

say(`${C.b}${C.c}══════════ 智慧树 · 一键全自动 ══════════${C.r}`);
info('启动后不用再输入任何命令；需要登录时会在浏览器里等你。');

if (!existsSync(join(ROOT, 'node_modules', 'playwright'))) {
  bad('缺少依赖 playwright。请在本目录执行：npm install');
  process.exit(1);
}

head('第 1 步 · 启动浏览器并确认登录');
if (BROWSER.auto) info('浏览器：自动选择（优先 Chromium 系，未安装则用 Firefox）');
else info('浏览器：' + (BROWSER.prefer === 'firefox' ? 'Firefox' : 'Chromium 系') + (BROWSER.exe ? `（${BROWSER.exe}）` : ''));
const login = await ensureLogin();
if (!login.ok) {
  warn('没有登录，无法继续。处理后在浏览器里登录，然后重新双击「一键开始.exe」。');
  process.exit(1);
}

head('第 2 步 · 检查题库数据');
let data = dataState();
if ((DO_HOMEWORK && !data.answer) || (DO_WATCH && !data.watch)) {
  warn('题库数据缺失，先自动抓取一次（可能需要几分钟）……');
  const code = runNode('zhs.mjs', ['fetch', ...browserArgs()]);
  if (code !== 0) warn(`抓取退出码 ${code}`);
  data = dataState();
}
if (DO_HOMEWORK && data.answer) good('作业数据就绪');
if (DO_WATCH && data.watch) good('课程数据就绪');
if (DO_HOMEWORK && !data.answer) bad('缺少 export\\papers.json，答题阶段跳过');
if (DO_WATCH && !data.watch) bad('缺少 export\\courses-resolved.json，看课阶段跳过');

let hw = { ok: true, skipped: true, note: '已跳过' };
if (DO_HOMEWORK) {
  hw = data.answer
    ? await stageHomework()
    : { ok: false, skipped: false, note: '缺少 export\\papers.json' };
} else {
  info('按参数要求跳过答题');
}

let watch = { ok: true, skipped: true, note: '已跳过' };
if (DO_WATCH) {
  if (!data.watch) {
    watch = { ok: false, skipped: false, note: '缺少 export\\courses-resolved.json' };
  } else {
    head('检查登录状态');
    const again = await ensureLogin();
    if (!again.ok) {
      warn('登录已失效，看课阶段无法继续。');
      watch = { ok: false, note: '登录失效' };
    } else {
      watch = await stageWatch();
    }
  }
} else {
  info('按参数要求跳过看课');
}

/* ───────── 汇总 ───────── */
head('全部结束');
const hwText = hw.skipped ? '已跳过'
  : hw.ok ? `完成${hw.report ? `（提交 ${hw.submitted} 份）` : '（本次没有待做作业）'}`
    : `未完成（${hw.note ? hw.note + '；' : ''}提交 ${hw.submitted ?? 0} 份，失败 ${hw.failed ?? 0} 份）`;
const watchText = watch.skipped ? '已跳过'
  : watch.ok ? `完成 ${watch.done ?? 0} 节`
    : `未完成${watch.note ? `：${watch.note}` : ''}（完成 ${watch.done ?? 0} 节，异常 ${(watch.error ?? 0) + (watch.partial ?? 0) + (watch.paused ?? 0)} 节${watch.blocked ? `，被平台拦下 ${watch.blocked} 节` : ''}）`;

say(`  登录      ${login.user?.realName || '已登录'}`);
say(`  作业      ${hwText}`);
say(`  看课      ${watchText}`);
say(`  报告      recon\\apply\\auto-answer-report.json`);
say(`            recon\\apply\\watch-report.json`);

const allOk = (hw.skipped || hw.ok) && (watch.skipped || watch.ok);
say('');
if (allOk) {
  good('全部完成。浏览器不会自动关闭，检查完再关窗口即可。');
} else {
  warn('还有未完成项，按上面的提示处理后可再次双击「一键开始.exe」。');
}
process.exit(allOk ? 0 : 1);
