// 关闭「学前必读」弹窗，验证机制与副作用
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy, HOME } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'dialog');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = await readyPage(ctx, HOME);

// 记录弹窗出现前后的所有请求，排查是否有「已读」上报
const calls = [];
page.on('request', (r) => {
  const u = r.url();
  if (/zhihuishu/.test(u) && !/\.(js|css|png|jpg|gif|woff2?|ico|mp4)(\?|$)/.test(u)) {
    calls.push({ t: Date.now(), method: r.method(), url: u.slice(0, 150), post: (r.postData() || '').slice(0, 400) });
  }
});

await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
try { await page.locator('text=大学生心理健康教育').first().click({ timeout: 10000 }); } catch {}
await page.waitForTimeout(9000);

// 1) 弹窗状态 + 关闭按钮定位
const before = await page.evaluate(() => {
  const d = document.querySelector('.dialog-read');
  const closeIcon = document.querySelector('.dialog-read .iconguanbi');
  const r = closeIcon ? closeIcon.getBoundingClientRect() : null;
  // 找有 @click 绑定的父元素（Vue 组件常见）
  let p = closeIcon, chain = [];
  for (let i = 0; i < 4 && p; i++) {
    chain.push({ tag: p.tagName, cls: (p.className || '').toString().slice(0, 70) });
    p = p.parentElement;
  }
  return {
    dialogVisible: !!d && d.getBoundingClientRect().width > 0,
    closeIconExists: !!closeIcon,
    closeIconRect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    closeChain: chain,
    wrapperVisible: !!document.querySelector('.el-dialog__wrapper')?.getBoundingClientRect().width,
    maskExists: !!document.querySelector('.el-dialog__wrapper, .v-modal, .el-overlay'),
    hasAgreeCheckbox: !!document.querySelector('.dialog-read input[type=checkbox]'),
    bodyOverflow: getComputedStyle(document.body).overflow,
  };
});
console.log('=== 关闭前 ===');
console.log(JSON.stringify(before, null, 1));

await page.screenshot({ path: OUT + '\\before-close.png' });

const callsAtClick = calls.length;

// 2) 点击关闭
console.log('\n点击关闭图标…');
await page.locator('.dialog-read .iconguanbi').first().click({ timeout: 10000 });
await page.waitForTimeout(4000);

const after = await page.evaluate(() => {
  const d = document.querySelector('.dialog-read');
  const cs = d ? getComputedStyle(d) : null;
  const r = d ? d.getBoundingClientRect() : null;
  // 视频播放器是否就绪
  const video = document.querySelector('video');
  return {
    dialogExists: !!d,
    dialogDisplay: cs ? cs.display : null,
    dialogRect: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : null,
    stillVisible: !!d && r.width > 0 && cs.display !== 'none',
    bodyOverflow: getComputedStyle(document.body).overflow,
    videoElement: video ? { exists: true, src: (video.currentSrc || '').slice(0, 90), duration: video.duration, paused: video.paused, readyState: video.readyState } : { exists: false },
    courseTitle: (document.querySelector('.course-name, .header-course-name')?.innerText || '').trim().slice(0, 60),
    catalogCount: document.querySelectorAll('.chapter-item, .catalogue-item, [class*=chapter]').length,
  };
});
console.log('\n=== 关闭后 ===');
console.log(JSON.stringify(after, null, 1));

await page.screenshot({ path: OUT + '\\after-close.png' });

// 3) 点击瞬间是否触发了上报接口
console.log('\n=== 点击关闭后新产生的请求 ===');
for (const c of calls.slice(callsAtClick)) {
  console.log(`  ${c.method} ${c.url}`);
  if (c.post) console.log('     post:', c.post.slice(0, 200));
}

writeFileSync(OUT + '\\close-result.json', JSON.stringify({ before, after, newCalls: calls.slice(callsAtClick) }, null, 2));
console.log('\n已保存 recon/dialog/close-result.json');

try { await tidy(ctx); } catch (e) { console.log('tidy:', String(e).slice(0, 80)); }
await browser.close().catch(() => {});
