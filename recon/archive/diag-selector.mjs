// 对比子串匹配与精确匹配的定位器行为
import { connect, readyPage, HOME } from '../../src/core/browser.mjs';

const { ctx, close } = await connect();
const page = await readyPage(ctx, HOME);
await page.waitForTimeout(4000);

const names = ['大学生心理健康教育', '国家安全教育', '思想道德与法治'];
console.log('定位器匹配数量对比（首页）:');
for (const nm of names) {
  const sub = await page.locator('text=' + nm).count();
  const ex = await page.getByText(nm, { exact: true }).count();
  console.log(`  ${nm.padEnd(14)} 子串=${sub}  精确=${ex}  ${sub > 1 ? '← 子串有歧义！' : ''}`);
}

// 看看子串匹配到的到底是什么
console.log('\n子串匹配到的元素:');
for (const nm of names) {
  const loc = page.locator('text=' + nm);
  const n = await loc.count();
  for (let i = 0; i < Math.min(n, 5); i++) {
    const t = await loc.nth(i).evaluate((el) => ({
      tag: el.tagName, cls: (el.className || '').toString().slice(0, 40),
      text: (el.innerText || '').trim().slice(0, 40), vis: !!el.offsetParent,
    })).catch(() => ({}));
    console.log(`  [${nm}][${i}]`, JSON.stringify(t));
  }
}

await close();
process.exit(0);
