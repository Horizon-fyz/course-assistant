// 真正从课程列表逐门点进去，取每门课的真实菜单 URL
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'courses');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = await readyPage(ctx, 'https://onlineweb.zhihuishu.com/onlinestuh5');
await page.waitForTimeout(5000);

const COURSES = [
  { name: '大学生心理健康教育', courseId: 1000101708, recruitId: 435122 },
  { name: '国家安全教育', courseId: 1000120382, recruitId: 428806 },
  { name: '思想道德与法治', courseId: 1000070264, recruitId: 453708 },
];

const result = [];

for (const c of COURSES) {
  console.log(`\n########## ${c.name} ##########`);
  await page.goto('https://onlineweb.zhihuishu.com/onlinestuh5', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // 点击该课程卡片上的课程名，进入课程
  let entered = false;
  try {
    const link = page.locator(`text=${c.name}`).first();
    await link.click({ timeout: 10000 });
    await page.waitForTimeout(8000);
    entered = true;
  } catch (e) {
    console.log('  点击课程失败:', String(e).slice(0, 100));
  }

  const info = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].map((a) => ({
      text: (a.innerText || '').trim().slice(0, 20), href: a.href,
    })).filter((x) => x.text && /stuonline|qah5|onlineh5|onlineexamh5new|exam/i.test(x.href));
    return {
      url: location.href,
      title: document.title,
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260),
      links,
    };
  });

  console.log('  进入后:', info.url);
  console.log('  标题:', info.title);
  console.log('  文本:', info.text.slice(0, 200));
  console.log('  功能链接:');
  for (const l of info.links) console.log(`    "${l.text}" → ${l.href}`);

  result.push({ ...c, entered, ...info });
  writeFileSync(OUT + '\\course-menus2.json', JSON.stringify(result, null, 2));
}

console.log('\n已保存 recon/courses/course-menus2.json');
await tidy(ctx);
await browser.close().catch(() => {});
