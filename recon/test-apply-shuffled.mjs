// 验证回填的健壮性：扫描后打乱选项顺序，看是否仍能点中"文字正确"的那几项
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = 9225;
const log = (m) => process.stdout.write(m + '\n');

const logText = readFileSync('K:\\网页自动学习\\dist\\智慧树助手\\启动日志.txt', 'utf8');
const m = logText.match(/(?:后端已启动|READY) http:\/\/127\.0\.0\.1:(\d+)/);
const appPort = m ? m[1] : null;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const getMain = () => {
  const pages = ctx.pages();
  const notUi = pages.filter((p) => !/desktop\/ui/.test(p.url()));
  return notUi.find((p) => !/^about:/.test(p.url())) ?? notUi[0] ?? pages[0];
};
const getSettings = () => ctx.pages().find((p) => /desktop\/ui/.test(p.url()));

let main = getMain();
const settings = getSettings();
if (!settings) { log('✗ 没有设置窗口'); process.exit(1); }

await main.goto(`http://127.0.0.1:${appPort}/test-exam.html`, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 1000));

// 1) 扫描
log('[1] 扫描 …');
const scan = await settings.evaluate(async () => {
  try { const r = await window.zhs.scanPage(); return { ok: true, n: (r?.questions || []).length }; }
  catch (e) { return { ok: false, error: e.message }; }
});
log('   ' + JSON.stringify(scan));
if (!scan.ok) process.exit(1);

// 2) 打乱每题选项的 DOM 顺序（模拟"重新渲染后选项乱序"）
log('\n[2] 打乱选项 DOM 顺序 …');
const shuffled = await main.evaluate(() => {
  const subs = [...document.querySelectorAll('.examPaper_subject')];
  const out = [];
  for (let i = 0; i < subs.length; i++) {
    const node = subs[i].querySelector('.subject_node');
    if (!node) continue;
    const labs = [...node.querySelectorAll('.nodeLab')];
    // 反转顺序
    const reversed = [...labs].reverse();
    for (const l of reversed) node.appendChild(l);
    out.push(`Q${i + 1}: ` + [...node.querySelectorAll('.nodeLab')]
      .map((l) => (l.querySelector('.node_detail') || l).innerText.replace(/\s+/g, '').slice(0, 10)).join(' | '));
  }
  return out;
});
for (const s of shuffled) log('   ' + s);

// 3) 回填
log('\n[3] 回填 …');
const ap = await settings.evaluate(async () => {
  try { return { ok: true, n: await window.zhs.applyPage() }; }
  catch (e) { return { ok: false, error: e.message }; }
});
log('   ' + JSON.stringify(ap));
await new Promise((r) => setTimeout(r, 800));

// 4) 校验：被选中的项，其文字是否是"正确"的那几个
log('\n[4] 校验（看选中的文字对不对，而不是位置）');
const checked = await main.evaluate(() => {
  const subs = [...document.querySelectorAll('.examPaper_subject')];
  return subs.map((s, i) => ({
    q: i + 1,
    picked: [...s.querySelectorAll('.nodeLab')]
      .filter((l) => l.querySelector('input')?.checked)
      .map((l) => (l.querySelector('.node_detail') || l).innerText.replace(/\s+/g, '').trim()),
  }));
});
const expect = {
  1: ['北京'],
  2: ['JavaScript', 'Python'],
  3: ['正确'],
};
let allOk = true;
for (const c of checked) {
  const want = expect[c.q] || [];
  const got = c.picked.slice().sort().join(',');
  const exp = want.slice().sort().join(',');
  const ok = got === exp;
  if (!ok) allOk = false;
  log(`   Q${c.q}: 选中[${c.picked.join(', ')}]  期望[${want.join(', ')}]  ${ok ? '✓' : '✗'}`);
}
log(`\n结论: ${allOk ? '✓ 乱序后仍然点中正确的选项' : '✗ 有错'}`);

await browser.close().catch(() => {});
