// 验证含填空/简答的页面：扫描 → 回填 → 校验选项与文本框
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = 9225;
const log = (m) => process.stdout.write(m + '\n');

const logText = readFileSync('K:\\网页自动学习\\dist\\智慧树助手\\启动日志.txt', 'utf8');
const mm = logText.match(/(?:后端已启动|READY) http:\/\/127\.0\.0\.1:(\d+)/);
const appPort = mm ? mm[1] : null;
const testUrl = `http://127.0.0.1:${appPort}/test-fill.html`;
log('后端端口: ' + appPort);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const mainPage = () => {
  const pages = ctx.pages();
  const c = pages.filter((p) => !/desktop\/ui/.test(p.url()) && !/^about:/.test(p.url()));
  return c[c.length - 1] ?? pages[pages.length - 1];
};
const settingsPage = () => ctx.pages().find((p) => /desktop\/ui/.test(p.url()));

for (let i = 0; i < 5; i++) {
  const p = mainPage();
  if (/test-fill/.test(p.url())) break;
  await p.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}
log('[导航] 主窗口 = ' + mainPage()?.url());

log('\n[1] 扫描 …');
const scan = await settingsPage().evaluate(async () => {
  try { const r = await window.zhs.scanPage(); return { ok: true, n: (r?.questions || []).length, answers: r?.answers }; }
  catch (e) { return { ok: false, error: e.message }; }
});
if (!scan.ok) { log('✗ ' + scan.error); process.exit(1); }
log('   ✓ ' + scan.n + ' 题');
for (let i = 1; i <= scan.n; i++) {
  const a = (scan.answers || {})[String(i)] || {};
  log(`   ${i}. 答案=${String(a.answer || '(空)').slice(0, 60)}`);
}

log('\n[2] 回填 …');
const ap = await settingsPage().evaluate(async () => {
  try { return { ok: true, n: await window.zhs.applyPage() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
log('   ' + JSON.stringify(ap));
await new Promise((r) => setTimeout(r, 1000));

log('\n[3] 校验页面实际内容');
const state = await mainPage().evaluate(() => {
  const subs = [...document.querySelectorAll('.examPaper_subject')];
  return subs.map((s, i) => ({
    q: i + 1,
    stem: (s.querySelector('.subject_describe') || {}).innerText || '',
    picked: [...s.querySelectorAll('.nodeLab')].filter((l) => l.querySelector('input')?.checked)
      .map((l) => (l.querySelector('.node_detail') || l).innerText.replace(/\s+/g, '').trim()),
    texts: [...s.querySelectorAll('textarea, input[type=text]')].map((el) => el.value),
  }));
});
for (const s of state) {
  log(`   Q${s.q} 「${String(s.stem).slice(0, 22)}」`);
  if (s.picked.length) log(`        选中: ${s.picked.join(', ')}`);
  if (s.texts.length) log(`        文本框: ${JSON.stringify(s.texts)}`);
}

const okQ1 = state[0]?.picked.join(',') === '北京';
const okQ2 = (state[1]?.texts[0] || '').length > 0;
const okQ3 = (state[2]?.texts || []).every((t) => t.length > 0);
const okQ4 = (state[3]?.texts[0] || '').length > 0;
log(`\nQ1 单选: ${okQ1 ? '✓' : '✗'}    Q2 填空: ${okQ2 ? '✓' : '✗'}    Q3 两空: ${okQ3 ? '✓' : '✗'}    Q4 简答: ${okQ4 ? '✓' : '✗'}`);
log(`结论: ${okQ1 && okQ2 && okQ3 && okQ4 ? '✓ 四题全部处理' : '✗ 有未处理'}`);

await browser.close().catch(() => {});
