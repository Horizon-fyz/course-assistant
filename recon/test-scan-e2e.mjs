// 端到端验证扫描链路：模拟作业页 → 读题 → 后端调 AI → 回传答案
// 用 CDP 连运行中的「智慧树助手」，主窗口导航到模拟作业页，再从设置页调 window.zhs.scanPage()
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PORT = 9225;
const log = (m) => process.stdout.write(m + '\n');

// 后端端口从启动日志里读
const logText = readFileSync('K:\\网页自动学习\\dist\\智慧树助手\\启动日志.txt', 'utf8');
const m = logText.match(/后端已启动: http:\/\/127\.0\.0\.1:(\d+)/) || logText.match(/READY http:\/\/127\.0\.0\.1:(\d+)/);
const appPort = m ? m[1] : null;
log('后端端口: ' + appPort);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const ctx = browser.contexts()[0];
const pages = ctx.pages();
log('页面数: ' + pages.length);
for (const p of pages) log('  ' + p.url().slice(0, 80));

const main = pages.find((p) => /zhihuishu|test-exam|about:blank/.test(p.url())) ?? pages[0];
const settings = pages.find((p) => /127\.0\.0\.1.*index\.html/.test(p.url()));
if (!main || !settings) { log('✗ 找不到主窗口或设置窗口'); process.exit(1); }

// 1) 主窗口导航到模拟作业页
const testUrl = `http://127.0.0.1:${appPort}/test-exam.html`;
log('\n[1] 主窗口 → ' + testUrl);
await main.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log('  goto: ' + String(e).slice(0, 80)));
await new Promise((r) => setTimeout(r, 1500));

// 2) 从设置页调用扫描（走真实的 window.zhs → 宿主 → 主窗口读题 → 后端 AI）
log('\n[2] 从设置页调用 window.zhs.scanPage() …');
const res = await settings.evaluate(async () => {
  try {
    const r = await window.zhs.scanPage();
    return { ok: true, count: (r?.questions || []).length, questions: r?.questions, answers: r?.answers };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}).catch((e) => ({ ok: false, error: 'evaluate 失败: ' + String(e).slice(0, 150) }));

if (!res.ok) { log('✗ 扫描失败: ' + res.error); process.exit(1); }

log(`✓ 扫到 ${res.count} 题`);
for (let i = 0; i < (res.questions || []).length; i++) {
  const q = res.questions[i];
  const a = (res.answers || {})[String(i + 1)] || {};
  log(`   ${i + 1}. [${q.type}] ${q.stem}`);
  log(`      选项: ${q.options.map((o) => o.key + '.' + o.text).join(' | ')}`);
  log(`      → 答案: ${a.answer || '(空)'}   解析: ${(a.reason || '').slice(0, 50)}`);
}

const answered = Object.values(res.answers || {}).filter((a) => a && a.answer).length;
log(`\n结果: ${res.count} 题 / ${answered} 个答案  ${answered === res.count ? '✓ 全部作答' : '⚠️ 有未作答'}`);

await browser.close().catch(() => {});
