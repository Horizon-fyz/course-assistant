// 端到端验证：扫描 → 回填 → 校验（每次操作都重新取页面句柄，避免跳转导致句柄失效）
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = 9225;
const log = (m) => process.stdout.write(m + '\n');

const logText = readFileSync('K:\\网页自动学习\\dist\\智慧树助手\\启动日志.txt', 'utf8');
const m = logText.match(/(?:后端已启动|READY) http:\/\/127\.0\.0\.1:(\d+)/);
const appPort = m ? m[1] : null;
const testUrl = `http://127.0.0.1:${appPort}/test-exam.html`;
log('后端端口: ' + appPort);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];

/** 取"主窗口"页面：排除本地 UI 页与隐藏弹窗接收器 */
function mainPage() {
  const pages = ctx.pages();
  const cands = pages.filter((p) => !/desktop\/ui/.test(p.url()) && !/^about:/.test(p.url()));
  return cands[cands.length - 1] ?? pages[pages.length - 1];
}
function settingsPage() {
  return ctx.pages().find((p) => /desktop\/ui/.test(p.url()));
}

// 1) 把主窗口导航到模拟作业页（跳转可能被打断，重试到 URL 正确为止）
for (let i = 0; i < 5; i++) {
  const p = mainPage();
  if (/test-exam/.test(p.url())) break;
  await p.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
}
const mainUrlNow = mainPage()?.url();
log('[导航] 主窗口 = ' + mainUrlNow);
if (!/test-exam/.test(String(mainUrlNow))) { log('✗ 主窗口没能停在模拟作业页'); process.exit(1); }

// 2) 扫描（真实走：宿主读页面 → 后端调 AI）
log('\n[1] 扫描 …');
const scan = await settingsPage().evaluate(async () => {
  try { const r = await window.zhs.scanPage(); return { ok: true, n: (r?.questions || []).length, answers: r?.answers }; }
  catch (e) { return { ok: false, error: e.message }; }
});
if (!scan.ok) { log('✗ 扫描失败: ' + scan.error); process.exit(1); }
log(`   ✓ ${scan.n} 题`);
for (let i = 1; i <= scan.n; i++) {
  const a = (scan.answers || {})[String(i)] || {};
  log(`   ${i}. 答案=${a.answer || '(空)'}  解析=${(a.reason || '').slice(0, 40)}`);
}

// 3) 回填
log('\n[2] 回填 …');
const ap = await settingsPage().evaluate(async () => {
  try { return { ok: true, n: await window.zhs.applyPage() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
log('   ' + JSON.stringify(ap));
await new Promise((r) => setTimeout(r, 1000));

// 4) 校验：选中项的文字对不对
log('\n[3] 校验选中的选项');
const checked = await mainPage().evaluate(() => {
  const subs = [...document.querySelectorAll('.examPaper_subject')];
  return subs.map((s, i) => ({
    q: i + 1,
    picked: [...s.querySelectorAll('.nodeLab')]
      .filter((l) => l.querySelector('input')?.checked)
      .map((l) => (l.querySelector('.node_detail') || l).innerText.replace(/\s+/g, '').trim()),
  }));
});
const expect = { 1: ['北京'], 2: ['JavaScript', 'Python'], 3: ['正确'] };
let allOk = true;
for (const c of checked) {
  const want = (expect[c.q] || []).slice().sort().join(',');
  const got = c.picked.slice().sort().join(',');
  const ok = got === want;
  if (!ok) allOk = false;
  log(`   Q${c.q}: 选中[${c.picked.join(', ')}]  期望[${(expect[c.q] || []).join(', ')}]  ${ok ? '✓' : '✗'}`);
}
log(`\n结论: ${allOk ? '✓ 扫描与回填都正确' : '✗ 有错'}`);

await browser.close().catch(() => {});
