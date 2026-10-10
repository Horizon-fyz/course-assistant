// 把智慧树 Edge 窗口提到最前（被其他窗口盖住时随时运行）
// 用法: node src\focus.mjs
import { connect, tidy, focusEdgeWindow } from './browser.mjs';

let browser, ctx;
try {
  ({ browser, ctx } = await connect());
} catch (e) {
  console.log('CDP 浏览器未运行，请先执行 start-browser.ps1');
  process.exit(1);
}

const target = await tidy(ctx);
const focusResult = await focusEdgeWindow();

console.log('前台页面:', target ? target.url() : '(无)');
console.log('窗口置前:', focusResult);
console.log('\n当前标签页:');
for (const p of ctx.pages()) console.log('  -', p.url().slice(0, 90));

await browser.close().catch(() => {});
