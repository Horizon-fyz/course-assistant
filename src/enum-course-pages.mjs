// 逐课程枚举真实功能页入口（从视频学习页取菜单链接），不猜测 URL
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'courses');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();

// 课程清单（含 Firefox 历史里的 cparams 形态）
const COURSES = [
  { name: '大学生心理健康教育', courseId: 1000101708, recruitId: 435122, secret: '4e5b5c59475b4859454a585858445e4350' },
  { name: '国家安全教育', courseId: 1000120382, recruitId: 428806, secret: null },
  { name: '思想道德与法治', courseId: 1000070264, recruitId: 453708, secret: null },
];

const page = await readyPage(ctx, 'https://studyvideoh5.zhihuishu.com/stuStudy');
const result = [];

for (const c of COURSES) {
  // 用页面自身的跳转逻辑打开该课程（recruitAndCourseId 为加密串，缺失时退回首页再点）
  const url = c.secret
    ? `https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${c.secret}`
    : `https://studyvideoh5.zhihuishu.com/stuStudy`;
  console.log(`\n########## ${c.name} (recruitId=${c.recruitId}) ##########`);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);

  if (!c.secret) {
    // 从课程列表切到目标课程
    try {
      const item = page.getByText(c.name, { exact: false }).first();
      if (await item.count()) { await item.click({ timeout: 8000 }); await page.waitForTimeout(6000); }
    } catch (e) { console.log('  切换课程失败:', String(e).slice(0, 90)); }
  }

  const info = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].map((a) => ({
      text: (a.innerText || '').trim().slice(0, 20), href: a.href,
    })).filter((x) => x.text && !/^javascript/i.test(x.href));
    // 也收集带 onclick 跳转的菜单项
    const menus = [...document.querySelectorAll('li,a,span')].map((el) => (el.innerText || '').trim())
      .filter((t) => t && t.length <= 8 && /作业考试|课程问答|成绩分析|课程资料|见面课|教学大纲|班级信息|课程表|课程提醒|目录/.test(t));
    const courseName = document.querySelector('.course-name, .header-course-name, h1')?.innerText?.trim() || '';
    return { url: location.href, links, menus: [...new Set(menus)], courseName, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200) };
  });

  console.log('  当前页面:', info.url);
  console.log('  识别课程:', info.courseName || '(未识别)');
  console.log('  菜单项:', JSON.stringify(info.menus));
  console.log('  链接:');
  for (const l of info.links) console.log(`    "${l.text}" → ${l.href.slice(0, 120)}`);

  result.push({ ...c, ...info });
}

writeFileSync(OUT + '\\course-menus.json', JSON.stringify(result, null, 2));
console.log('\n已保存 recon/courses/course-menus.json');

await tidy(ctx);
await browser.close().catch(() => {});
