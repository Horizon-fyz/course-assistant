// 只读侦察：作业页题干结构 + 提交按钮；看课页课节状态与播放器控件
// 不点任何选项、不保存、不提交、不播放
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, readyPage, tidy } from '../../src/core/browser.mjs';
import { DATA_DIR, findCourse } from '../../src/core/store.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const EXPORT = DATA_DIR;
const log = (m) => process.stdout.write(m + '\n');

const papers = JSON.parse(readFileSync(join(EXPORT, 'papers.json'), 'utf8'));
const resolved = JSON.parse(readFileSync(join(EXPORT, 'courses-resolved.json'), 'utf8'));

function firstPending() {
  for (const [course, items] of Object.entries(papers)) {
    const rid = findCourse(resolved, { courseName: course })?.recruitId;
    if (!rid) continue;
    for (const it of items) {
      if (it.state !== 1 || it.score !== null) continue;
      return {
        course,
        name: it.examName,
        url: `https://onlineexamh5new.zhihuishu.com/stuExamWeb.html#/webExamList/dohomework/`
          + `${rid}/${it.id}/${it.examId}/${it.courseId}/5371/${it.meetCourseType ?? 0}`,
      };
    }
  }
  return null;
}

const { ctx, describe, close } = await connect();
log('浏览器: ' + describe);

// ---------- 1) 作业页 ----------
const target = firstPending();
if (target) {
  log(`\n[作业页] ${target.course} / ${target.name}`);
  const p = await ctx.newPage();
  await p.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(9000);
  const info = await p.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const q = document.querySelector('.examPaper_subject');
    const stemCands = [...document.querySelectorAll('[class*=stem], [class*=describe], [class*=subject_describe]')]
      .map((el) => ({
        cls: (el.className || '').toString().slice(0, 80),
        text: clean(el.innerText).slice(0, 120),
        html: el.innerHTML.replace(/\s+/g, ' ').slice(0, 600),
      })).slice(0, 12);
    const buttons = [...document.querySelectorAll('button, a, [class*=btn], [role=button]')]
      .map((n) => ({ tag: n.tagName, cls: (n.className || '').toString().slice(0, 60), text: clean(n.innerText).slice(0, 30) }))
      .filter((x) => x.text).slice(0, 40);
    const dialogs = [...document.querySelectorAll('.el-dialog, .el-message-box, .el-dialog__wrapper')]
      .map((d) => ({ cls: (d.className || '').toString().slice(0, 60), text: clean(d.innerText).slice(0, 200), visible: d.getBoundingClientRect().width > 0 }));
    const sub = q ? {
      subjectHtml: q.outerHTML.replace(/\s+/g, ' ').slice(0, 4000),
      stems: stemCands,
      stemImages: [...q.querySelectorAll('img')].map((i) => i.src.slice(0, 160)),
      optionCount: q.querySelectorAll('.nodeLab').length,
      optionTypes: [...new Set([...q.querySelectorAll('.nodeLab input')].map((i) => i.type))],
      optionTexts: [...q.querySelectorAll('.nodeLab .node_detail')].map((d) => clean(d.innerText).slice(0, 60)),
    } : null;
    return { url: location.href, title: document.title, sub, buttons, dialogs };
  }).catch((e) => ({ error: String(e).slice(0, 200) }));
  log(JSON.stringify(info, null, 1).slice(0, 7000));
  await p.close().catch(() => {});
} else {
  log('没有可用的待作答作业');
}

// ---------- 2) 看课页 ----------
const secret = Object.values(resolved)[0]?.secret;
const vurl = `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${secret}`;
log(`\n[看课页] ${vurl}`);
const vp = await readyPage(ctx, vurl);
await vp.waitForTimeout(8000);
const vinfo = await vp.evaluate(() => {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const list = [...document.querySelectorAll('li.video, li[class*=video], .list li')].map((li) => ({
    cls: (li.className || '').toString(),
    text: clean(li.innerText).slice(0, 70),
    html: li.outerHTML.replace(/\s+/g, ' ').slice(0, 500),
  })).slice(0, 6);
  const chapters = [...document.querySelectorAll('li.chapter')].length;
  const video = document.querySelector('video');
  const controls = [...document.querySelectorAll('[class*=speed], [class*=play], [class*=control], .vjs-control-bar button')]
    .map((n) => ({ cls: (n.className || '').toString().slice(0, 60), text: clean(n.innerText).slice(0, 20) }))
    .slice(0, 25);
  return {
    title: document.title,
    chapters,
    lessons: list,
    video: video ? { duration: video.duration, currentTime: video.currentTime, paused: video.paused, rate: video.playbackRate, src: video.currentSrc.slice(0, 120) } : null,
    controls,
    dialogRead: !!document.querySelector('.dialog-read'),
    dialogs: [...document.querySelectorAll('.el-dialog__wrapper')].map((d) => ({ cls: (d.className || '').toString().slice(0, 60), text: clean(d.innerText).slice(0, 120) })).slice(0, 5),
  };
}).catch((e) => ({ error: String(e).slice(0, 200) }));
log(JSON.stringify(vinfo, null, 1).slice(0, 6000));

await vp.screenshot({ path: join(ROOT, 'recon', 'apply', 'live-video.png') }).catch(() => {});
await tidy(ctx).catch(() => {});
await close();
