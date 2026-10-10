// 课程自动发现与解析（多浏览器）
// 目的：学生将来被分配新课程时，脚本能自动识别，无需改代码
//
// 关键事实：queryShareCourseInfo 会直接返回每门课的 secret（= recruitAndCourseId），
// 所以「视频页参数」可完全自动获取；只有考试页的 listRid 需要实地捕获。
import { writeFileSync, mkdirSync, existsSync, readFileSync, writeSync } from 'node:fs';
import { connect, readyPage, HOME } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
const CACHE = BASE + '\\export\\courses-resolved.json';
mkdirSync(BASE + '\\export', { recursive: true });
const log = (m) => { try { writeSync(1, m + '\n'); } catch { console.log(m); } };

const SIG_COURSE = 'NEuH3llD9woD4DQgu0k6Uvp5yyo8WT84Dq5lU2iPwvgKNatePzJ+vu/4PRaNYy+K';

// 支持从命令行指定浏览器：node src\resolve-courses.mjs firefox
const prefer = process.argv[2] === 'firefox' ? 'firefox' : 'chromium';

/** 拉取当前账号全部课程（动态） */
async function fetchCourses(page) {
  return page.evaluate(async (sig) => {
    const r = await fetch('https://onlineservice-api.zhihuishu.com/gateway/t/v1/student/course/share/queryShareCourseInfo', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secretStr: sig, date: Date.now(), pageNo: 1, pageSize: 100 }).toString(),
    });
    const j = await r.json();
    return {
      code: j.code,
      courses: (j?.result?.courseOpenDtos || []).map((c) => ({
        courseId: c.courseId, courseName: c.courseName, teacherName: c.teacherName,
        schoolName: c.schoolName, recruitId: c.recruitId, secret: c.secret,
        progress: c.progress, courseStatus: c.courseStatus, termId: c.termId,
      })),
      total: j?.result?.totalCount ?? 0,
    };
  }, SIG_COURSE);
}

/** 在校内页面上钩住 window.open，点「作业考试」拿考试页 listRid */
async function captureListRid(page) {
  return page.evaluate(async () => {
    window.__cap = window.__cap || [];
    if (!window.__hookedOpen) {
      window.__hookedOpen = true;
      const orig = window.open;
      window.open = function (...a) { try { window.__cap.push(String(a[0] || '')); } catch {} return null; };
    }
    const el = [...document.querySelectorAll('*')].find((n) => (n.innerText || '').trim() === '作业考试' && n.children.length === 0);
    if (!el) return { err: '未找到「作业考试」菜单' };
    el.click();
    await new Promise((r) => setTimeout(r, 3500));
    const hit = (window.__cap || []).filter((u) => /onlineexamh5new/.test(u)).pop();
    if (!hit) return { err: '未捕获到考试页 URL', cap: window.__cap.slice(-3) };
    const m = hit.match(/recruitId=([^&]+)/);
    return { rid: m ? m[1] : null, url: hit };
  }).catch((e) => ({ err: String(e).slice(0, 120) }));
}

// ---------------- 主流程 ----------------
const { ctx, describe, close } = await connect({ prefer });
log('浏览器: ' + describe);

const page = await readyPage(ctx, HOME);
await page.waitForTimeout(4000);

log('\n[1] 拉取课程列表…');
const { code, courses, total } = await fetchCourses(page);
log(`    接口 code=${code}  totalCount=${total}`);
log(`    发现 ${courses.length} 门课程:`);
for (const c of courses) {
  log(`      · ${c.courseName}  courseId=${c.courseId}  recruitId=${c.recruitId}  进度=${c.progress}  secret=${c.secret ? '有' : '缺'}`);
}

if (!courses.length) {
  log('\n⚠️ 未发现任何课程。可能原因：未登录 / 身份不对 / 确实无课。');
  await close();
  process.exit(2);
}

const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {};
const resolved = [];

for (const [i, c] of courses.entries()) {
  log(`\n[2.${i + 1}] 解析「${c.courseName}」`);
  const cached = cache[c.courseName] || {};

  // secret 直接来自接口（新课程同样适用）
  let secret = c.secret || cached.secret || null;
  let listRid = cached.listRid || null;

  log(`    secret: ${secret || '(需实地解析)'}`);
  log(`    listRid: ${listRid ? decodeURIComponent(listRid) : '(需实地捕获)'}`);

  if (!secret || !listRid) {
    // 进入该课程的视频页
    let ok = false;
    try {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4500);
      await page.locator(`text=${c.courseName}`).first().click({ timeout: 12000 });
      await page.waitForTimeout(9000);
      ok = true;
    } catch (e) {
      log('    进入课程失败: ' + String(e).slice(0, 90));
    }

    if (ok) {
      // 关掉「学前必读」
      try { await page.locator('.dialog-read .iconguanbi').first().click({ timeout: 5000 }); await page.waitForTimeout(1500); } catch {}

      if (!secret) {
        const m = page.url().match(/recruitAndCourseId=([0-9a-f]+)/i);
        if (m) { secret = m[1]; log('    ✓ 实地取得 secret: ' + secret); }
      }
      if (!listRid) {
        const r = await captureListRid(page);
        if (r.rid) { listRid = r.rid; log('    ✓ 实地取得 listRid: ' + decodeURIComponent(r.rid)); }
        else log('    ✗ listRid 捕获失败: ' + (r.err || JSON.stringify(r.cap || [])));
      }
    }
  }

  resolved.push({ ...c, secret, listRid });
  cache[c.courseName] = {
    secret, listRid, courseId: c.courseId, recruitId: c.recruitId,
    teacherName: c.teacherName, updatedAt: new Date().toISOString(),
  };
  writeFileSync(CACHE, JSON.stringify(cache, null, 2), 'utf8');
}

log('\n\n================ 课程解析结果 ================');
let complete = 0;
for (const r of resolved) {
  const ok = !!(r.secret && r.listRid);
  if (ok) complete++;
  log(`  ${ok ? '✅' : '⚠️ '} ${r.courseName}（${r.teacherName || ''}）`);
  log(`        courseId=${r.courseId}  recruitId=${r.recruitId}`);
  log(`        secret =${r.secret || '缺失'}`);
  log(`        listRid=${r.listRid ? decodeURIComponent(r.listRid) : '缺失'}`);
}
log(`\n  ${complete}/${resolved.length} 门课程解析完整`);
log('已保存 export/courses-resolved.json');

writeFileSync(CACHE, JSON.stringify(cache, null, 2), 'utf8');
await close();
process.exit(complete === resolved.length ? 0 : 1);
