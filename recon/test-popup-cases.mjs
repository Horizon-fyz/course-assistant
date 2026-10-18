// 验证三种弹窗是否都被并进主窗口
// 注意：合并成功后主窗口的 page 句柄会失效，所以每次点击后都要重新取句柄
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = 9225;
const log = (m) => process.stdout.write(m + '\n');

const logText = readFileSync('K:\\网页自动学习\\dist\\智慧树助手\\启动日志.txt', 'utf8');
const m = logText.match(/(?:后端已启动|READY) http:\/\/127\.0\.0\.1:(\d+)/);
const appPort = m ? m[1] : null;
log('后端端口: ' + appPort);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const testUrl = `http://127.0.0.1:${appPort}/test-popup.html`;

/** 取主窗口的 page：排除本地 UI 页 与 隐藏弹窗接收器（about:blank） */
const getMain = () => {
  const pages = ctx.pages();
  const notUi = pages.filter((p) => !/desktop\/ui/.test(p.url()));
  return notUi.find((p) => !/^about:/.test(p.url())) ?? notUi[0] ?? pages[0];
};

async function runCase(name, selector, check) {
  log(`\n===== ${name} =====`);

  let main = getMain();
  await main.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 700));

  const before = ctx.pages().length;
  await main.click(selector).catch((e) => log('  click: ' + String(e).slice(0, 90)));
  await new Promise((r) => setTimeout(r, 2500));

  // 句柄可能已被合并销毁 → 重新取
  const pages = ctx.pages();
  const after = pages.length;
  main = getMain();

  let url = '(取不到)', body = '(取不到)';
  try {
    url = main.url();
    body = await main.evaluate(() => (document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 140) : '(空)'));
  } catch (e) { log('  读取失败: ' + String(e).slice(0, 90)); }

  log(`  页面数: ${before} → ${after}   ${after <= before ? '✓ 没多出独立窗口' : '✗ 多出窗口'}`);
  log(`  主窗口地址: ${String(url).slice(0, 90)}`);
  log(`  主窗口内容: ${body}`);

  const ok = check({ after, before, url, body });
  log(`  结论: ${ok ? '✓ 通过' : '✗ 失败'}`);
  return ok;
}

let allOk = true;

// ① about:blank + document.write —— 就是「开始答题」那种，之前会变空白页卡住
allOk = await runCase('① about:blank + document.write', '#go-blank',
  (r) => /POPUP CONTENT OK/.test(r.body)) && allOk;

// ② window.open(真实地址)
allOk = await runCase('② window.open(真实地址)', '#go-url',
  (r) => /example\.com/.test(r.url)) && allOk;

// ③ target=_blank 链接
allOk = await runCase('③ target=_blank 链接', '#go-link',
  (r) => /example\.com/.test(r.url)) && allOk;

log(`\n总体: ${allOk ? '✓ 三种都并进了主窗口' : '✗ 有失败项'}`);
await browser.close().catch(() => {});
