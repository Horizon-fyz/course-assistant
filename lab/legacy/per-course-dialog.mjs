// 逐课程验证：能否进入、弹窗能否关闭、视频是否就绪
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy, HOME } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'dialog');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();

const COURSES = ['大学生心理健康教育', '国家安全教育', '思想道德与法治'];
const results = [];

// 打开一个"干净的播放页"用于关闭单个弹窗
async function openCourse(name) {
  const page = ctx.pages().find((p) => p.url().includes('studyvideoh5')) ?? (await ctx.newPage());
  await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  try { await page.locator(`text=${name}`).first().click({ timeout: 12000 }); } catch (e) {
    return { page, err: '点击课程失败: ' + String(e).slice(0, 80) };
  }
  await page.waitForTimeout(9000);
  return { page };
}

for (const name of COURSES) {
  console.log(`\n########## ${name} ##########`);
  const { page, err } = await openCourse(name);
  if (err) { console.log('  ', err); results.push({ name, err }); continue; }

  const pre = await page.evaluate(() => {
    const d = document.querySelector('.dialog-read');
    const r = d ? d.getBoundingClientRect() : null;
    return {
      url: location.href,
      title: document.title,
      dialogVisible: !!d && r.width > 0,
      dialogText: d ? (d.innerText || '').replace(/\s+/g, ' ').slice(0, 160) : null,
      closeIcon: !!document.querySelector('.dialog-read .iconguanbi'),
      hasCheckbox: !!document.querySelector('.dialog-read input[type=checkbox]'),
      video: (() => { const v = document.querySelector('video'); return v ? { dur: Math.round(v.duration || 0), readyState: v.readyState } : null; })(),
    };
  });
  console.log('  进入:', pre.url);
  console.log('  弹窗可见:', pre.dialogVisible, ' 关闭图标:', pre.closeIcon, ' 有同意框:', pre.hasCheckbox);
  if (pre.dialogText) console.log('  内容:', pre.dialogText.slice(0, 110));

  let closed = null;
  if (pre.dialogVisible) {
    try {
      await page.locator('.dialog-read .iconguanbi').first().click({ timeout: 10000 });
      await page.waitForTimeout(4000);
      closed = await page.evaluate(() => {
        const d = document.querySelector('.dialog-read');
        const r = d ? d.getBoundingClientRect() : null;
        const v = document.querySelector('video');
        return {
          stillVisible: !!d && r.width > 0,
          video: v ? { dur: Math.round(v.duration || 0), readyState: v.readyState, paused: v.paused } : null,
          chapters: document.querySelectorAll('[class*=chapter]').length,
        };
      });
      console.log('  关闭后 → 仍可见:', closed.stillVisible, ' 视频:', JSON.stringify(closed.video), ' 章节数:', closed.chapters);
    } catch (e) { console.log('  关闭失败:', String(e).slice(0, 100)); }
  }

  await page.screenshot({ path: `${OUT}\\course-${name}.png` }).catch(() => {});
  results.push({ name, ...pre, closed });
}

writeFileSync(OUT + '\\per-course-dialog.json', JSON.stringify(results, null, 2));
console.log('\n已保存 recon/dialog/per-course-dialog.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
