// 探查作业/考试页：3 门课分别能否进入、有哪些题目入口
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy, HOME } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();

const COURSES = [
  { name: '大学生心理健康教育', courseId: 1000101708, recruitId: 435122, secret: '4e5b5c59475b4859454a585858445e4350' },
  { name: '国家安全教育', courseId: 1000120382, recruitId: 428806, secret: '4e5a5150455f4859454a58585a455a4b5a' },
  { name: '思想道德与法治', courseId: 1000070264, recruitId: 453708, secret: '4e5d5a5f45514859454a58595f455b455c' },
];

// 先取出「作业考试」菜单的真实 URL（在视频页里点击触发）
const page = await readyPage(ctx, 'https://studyvideoh5.zhihuishu.com/stuStudy');
const results = [];

for (const c of COURSES) {
  console.log(`\n########## ${c.name} ##########`);

  // 进入该课程（用已反解的加密参数直接打开）
  await page.goto(`https://studyvideoh5.zhihuishu.com/stuStudy?recruitAndCourseId=${c.secret}`, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(8000);

  // 关掉学前必读
  try { await page.locator('.dialog-read .iconguanbi').first().click({ timeout: 6000 }); await page.waitForTimeout(2500); } catch {}

  // 抓「作业考试」菜单的跳转地址
  const menu = await page.evaluate(() => {
    const out = { links: [], onclick: [] };
    for (const a of document.querySelectorAll('a[href]')) {
      const t = (a.innerText || '').trim();
      if (/作业|考试/.test(t)) out.links.push({ text: t, href: a.href });
      if (/exam/i.test(a.href)) out.links.push({ text: t || '(exam链接)', href: a.href });
    }
    for (const el of document.querySelectorAll('[onclick]')) {
      const t = (el.innerText || '').trim();
      if (/作业|考试/.test(t)) out.onclick.push({ text: t, onclick: el.getAttribute('onclick').slice(0, 200) });
    }
    return out;
  });
  console.log('  作业考试入口:', JSON.stringify(menu.links.filter((l) => l.href && !l.href.startsWith('javascript')).slice(0, 4), null, 1));
  if (menu.onclick.length) console.log('  onclick:', JSON.stringify(menu.onclick.slice(0, 4)));

  // 点击「作业考试」并观察跳转
  let jump = null;
  try {
    const before = page.url();
    const el = page.getByText('作业考试', { exact: true }).first();
    if (await el.count()) {
      await el.click({ timeout: 10000 });
      await page.waitForTimeout(9000);
      jump = { from: before, to: page.url(), title: await page.title() };
      console.log('  跳转到:', jump.to);
      console.log('  标题:', jump.title);
    } else console.log('  未找到「作业考试」菜单');
  } catch (e) { console.log('  点击失败:', String(e).slice(0, 110)); }

  // 读取作业/考试页内容
  let content = null;
  if (jump && /exam/i.test(jump.to)) {
    content = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[class*=item], [class*=list] li, .exam-item, tr')]
        .map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t && /作业|考试|截止|开始答题|总分|题目数量|未提交|已提交/.test(t))
        .slice(0, 25);
      const tabs = [...document.querySelectorAll('[class*=tab], .el-tabs__item')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 12);
      const btns = [...document.querySelectorAll('button, a, [class*=btn]')].map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 12).slice(0, 20);
      return { url: location.href, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 900), rows, tabs, btns: [...new Set(btns)] };
    });
    console.log('  标签页:', JSON.stringify(content.tabs));
    console.log('  按钮:', JSON.stringify(content.btns));
    console.log('  内容:', content.text.slice(0, 420));
  }

  await page.screenshot({ path: `${OUT}\\exam-${c.recruitId}.png` }).catch(() => {});
  results.push({ ...c, menu, jump, content });
}

writeFileSync(OUT + '\\exam-per-course.json', JSON.stringify(results, null, 2));
console.log('\n已保存 recon/exam/exam-per-course.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
