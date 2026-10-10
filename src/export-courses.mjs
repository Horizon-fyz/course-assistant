// 批量导出：课程 + 章节视频 → JSON（供 Excel 生成）
// 显示约定：复用已有标签、不新建空白页、结束前把真实页面切到前台
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy, HOME } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'export');
mkdirSync(OUT, { recursive: true });

const SIG_COURSE = 'NEuH3llD9woD4DQgu0k6Uvp5yyo8WT84Dq5lU2iPwvgKNatePzJ+vu/4PRaNYy+K';
const SIG_VIDEO = 'QhSgx0MEvvp0jRL20aaxWiUkrjuZvigMo7O0OApkaCEo76j+nBmFpel6fwHuTiRWnz+pGIblHqSmkUPS2xszknn3/CwHW1Br60fY/IJ4iX7UCYd8wCln28Ex0cB0bmgJ';

const { browser, ctx } = await connect();

// 在线学堂域（课程接口）
const pageA = await readyPage(ctx, HOME);
// 视频域（视频服务接口）—— 跨域限制要求在该域页面内调用
const pageB = await readyPage(ctx, 'https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=4e5b5c59475b4859454a585858445e4350');

const post = (page) => async (url, form) => page.evaluate(async ([u, f]) => {
  try {
    const r = await fetch(u, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(f).toString(),
    });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 300) }; }
  } catch (e) { return { __error: String(e) }; }
}, [url, form]);

const postA = post(pageA);
const postB = post(pageB);
const API = 'https://onlineservice-api.zhihuishu.com/gateway/t/v1';
const SVC = 'https://studyservice-api.zhihuishu.com/gateway/t/v1';

const courses = await postA(`${API}/student/course/share/queryShareCourseInfo`, {
  secretStr: SIG_COURSE, date: Date.now(), pageNo: 1, pageSize: 50,
});
console.log('课程列表 code =', courses?.code, ' 数量 =', courses?.result?.courseOpenDtos?.length);

const list = courses?.result?.courseOpenDtos || [];
const data = { fetchedAt: new Date().toISOString(), courses: [], videos: {} };

for (const c of list) {
  data.courses.push({
    courseId: c.courseId, courseName: c.courseName, teacherName: c.teacherName,
    schoolName: c.schoolName, recruitId: c.recruitId, secret: c.secret, progress: c.progress,
    lessonName: c.lessonName, lessonNum: c.lessonNum, courseStartTime: c.courseStartTime,
    courseEndTime: c.courseEndTime, courseStatus: c.courseStatus, termId: c.termId, courseType: c.courseType,
  });

  const vl = await postB(`${SVC}/learning/videolist`, {
    secretStr: SIG_VIDEO, dateFormate: Date.now(), recruitId: c.recruitId, courseId: c.courseId,
  });
  data.videos[c.courseId] = vl?.data ?? { __resp: vl };

  const chapters = data.videos[c.courseId]?.videoChapterDtos?.length ?? 0;
  const lessons = (data.videos[c.courseId]?.videoChapterDtos || []).reduce((a, ch) => a + (ch.videoLessons?.length || 0), 0);
  console.log(`  ${c.courseName.padEnd(12)} 章节=${String(chapters).padStart(2)} 视频=${String(lessons).padStart(3)} 进度=${c.progress}`);
}

writeFileSync(OUT + '\\raw.json', JSON.stringify(data, null, 2), 'utf8');
console.log('\n已保存 export/raw.json');

// 收尾：清理标签并把真实页面切到前台，避免界面上只剩空白页
const focused = await tidy(ctx);
console.log('前台页面:', focused ? focused.url() : '(none)');
await browser.close().catch(() => {});
