// 诊断：进课程取 listRid 到底卡在哪一步（逐步打印）
import { connect, readyPage, HOME } from '../src/browser.mjs';

const { ctx, describe, close } = await connect();
console.log('浏览器:', describe);

const page = await readyPage(ctx, HOME);
await page.waitForTimeout(4000);
console.log('起始页:', page.url());

const COURSE = '大学生心理健康教育';

console.log('\n[1] 定位课程名元素…');
const loc = page.locator(`text=${COURSE}`);
const n = await loc.count();
console.log(`    匹配到 ${n} 个元素`);
for (let i = 0; i < Math.min(n, 6); i++) {
  const info = await loc.nth(i).evaluate((el) => ({
    tag: el.tagName, cls: (el.className || '').toString().slice(0, 50),
    text: (el.innerText || '').trim().slice(0, 30),
    visible: !!el.offsetParent,
  })).catch((e) => ({ err: String(e).slice(0, 60) }));
  console.log(`      [${i}]`, JSON.stringify(info));
}

console.log('\n[2] 尝试点击第一个可见的…');
try {
  await loc.first().click({ timeout: 12000 });
  console.log('    ✅ 点击成功');
} catch (e) {
  console.log('    ❌ 点击失败:', String(e).split('\n')[0].slice(0, 140));
  // 换策略：找可见的再点
  for (let i = 0; i < n; i++) {
    const vis = await loc.nth(i).isVisible().catch(() => false);
    if (!vis) continue;
    try { await loc.nth(i).click({ timeout: 8000 }); console.log(`    ✅ 改用第 ${i} 个可见元素点击成功`); break; }
    catch (e2) { console.log(`    第 ${i} 个也不可点: ${String(e2).split('\n')[0].slice(0, 80)}`); }
  }
}
await page.waitForTimeout(9000);
console.log('    现在页面:', page.url().slice(0, 130));

console.log('\n[3] 关掉学前必读…');
try { await page.locator('.dialog-read .iconguanbi').first().click({ timeout: 5000 }); console.log('    ✅ 已关闭'); await page.waitForTimeout(1500); }
catch { console.log('    (无弹窗或未出现)'); }

console.log('\n[4] 装钩子并点击「作业考试」…');
try {
  await page.evaluate(() => {
    window.__cap = [];
    if (!window.__hookedOpen) {
      window.__hookedOpen = true;
      window.open = function (...a) { try { window.__cap.push(String(a[0] || '')); } catch {} return null; };
    }
  });
  console.log('    钩子已装');
  const ex = page.getByText('作业考试', { exact: true });
  console.log('    「作业考试」匹配数:', await ex.count());
  await ex.first().click({ timeout: 12000 });
  console.log('    ✅ 已点击');
} catch (e) {
  console.log('    ❌ 失败:', String(e).split('\n')[0].slice(0, 140));
}
await page.waitForTimeout(4000);

for (let i = 0; i < 3; i++) {
  try {
    const cap = await page.evaluate(() => window.__cap || []);
    const hit = (cap || []).filter((u) => /onlineexamh5new/.test(u)).pop();
    if (hit) { console.log('    ✅ 捕获:', hit.slice(0, 110)); break; }
    console.log(`    第 ${i + 1} 次未捕获, cap=`, JSON.stringify(cap).slice(0, 160));
  } catch (e) { console.log(`    第 ${i + 1} 次读取异常`); }
  await page.waitForTimeout(2500);
}

await close();
process.exit(0);
