// 诊断国家安全教育页的弹窗遮挡问题
import { connect, readyPage, HOME } from '../../src/core/browser.mjs';

const { ctx, close } = await connect();
const page = await readyPage(ctx, HOME);
await page.waitForTimeout(4000);

// 进入国家安全教育
await page.locator('text=国家安全教育').first().click({ timeout: 12000 });
await page.waitForTimeout(9000);
console.log('页面:', page.url().slice(0, 110));

// 弹窗状态
const st = await page.evaluate(() => {
  const d = document.querySelector('.dialog-read');
  const r = d ? d.getBoundingClientRect() : null;
  const icon = document.querySelector('.dialog-read .iconguanbi');
  const ir = icon ? icon.getBoundingClientRect() : null;
  return {
    dialogExists: !!d,
    dialogRect: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : null,
    dialogVisible: !!d && r.width > 0 && getComputedStyle(d).display !== 'none',
    iconExists: !!icon,
    iconRect: ir ? { x: Math.round(ir.x), y: Math.round(ir.y), w: Math.round(ir.width), h: Math.round(ir.height) } : null,
    // 菜单是否被遮住
    menuInfo: (() => {
      const el = [...document.querySelectorAll('*')].find((n) => (n.innerText || '').trim() === '作业考试' && n.children.length === 0);
      if (!el) return null;
      const mr = el.getBoundingClientRect();
      const top = document.elementFromPoint(mr.x + mr.width / 2, mr.y + mr.height / 2);
      return {
        rect: { x: Math.round(mr.x), y: Math.round(mr.y), w: Math.round(mr.width), h: Math.round(mr.height) },
        topElement: top ? { tag: top.tagName, cls: (top.className || '').toString().slice(0, 50) } : null,
        covered: top !== el && !el.contains(top),
      };
    })(),
  };
});
console.log('\n=== 弹窗与遮挡状态 ===');
console.log(JSON.stringify(st, null, 1));

// 尝试关闭
if (st.dialogVisible) {
  console.log('\n尝试关闭弹窗…');
  try {
    await page.locator('.dialog-read .iconguanbi').first().click({ timeout: 10000 });
    console.log('  ✅ 点击成功');
  } catch (e) { console.log('  ❌ 点击失败:', String(e).split('\n')[0].slice(0, 120)); }
  await page.waitForTimeout(2500);

  const after = await page.evaluate(() => {
    const d = document.querySelector('.dialog-read');
    const r = d ? d.getBoundingClientRect() : null;
    return { stillVisible: !!d && r.width > 0, rect: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : null };
  });
  console.log('  关闭后:', JSON.stringify(after));
}

// 再试点击菜单
console.log('\n再次尝试点击「作业考试」…');
try {
  await page.getByText('作业考试', { exact: true }).first().click({ timeout: 15000 });
  console.log('  ✅ 点击成功');
  await page.waitForTimeout(3500);
  const cap = await page.evaluate(() => window.__cap || []);
  console.log('  捕获:', JSON.stringify(cap).slice(0, 200));
} catch (e) { console.log('  ❌ 仍失败:', String(e).split('\n')[0].slice(0, 120)); }

await close();
process.exit(0);
