// 核实：作业/考试页是否存在「已提交后查看题目」的正当复习入口
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = ctx.pages().find((p) => p.url().includes('onlineexamh5new'));
if (!page) { console.log('没有考试页标签，请先打开作业考试页'); process.exit(1); }

await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(9000);

const info = await page.evaluate(() => {
  const out = {};

  // 1) 顶部 tab（未提交 / 已提交）
  out.tabs = [...document.querySelectorAll('.el-tabs__item, [class*=tab]')]
    .map((e) => ({ text: (e.innerText || '').trim(), cls: (e.className || '').toString().slice(0, 80), active: /active|is-active|cur/.test(e.className || '') }))
    .filter((x) => x.text);

  // 2) 列表容器结构（找 Vue 的 item 节点与数据属性）
  out.containers = [...document.querySelectorAll('[class*=list], [class*=item], [class*=card]')]
    .map((e) => (e.className || '').toString()).filter(Boolean).slice(0, 25);

  // 3) 每个作业条目挂载的属性（可能含 examId / id / state）
  const items = [...document.querySelectorAll('[class*=item], li, tr, [class*=card]')]
    .filter((e) => /单元测试|教程考试|开始答题|查看|已提交/.test(e.innerText || ''));
  out.itemAttrs = items.slice(0, 6).map((e) => {
    const attrs = {};
    for (const a of e.attributes || []) attrs[a.name] = a.value.slice(0, 80);
    return { tag: e.tagName, text: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 90), attrs };
  });

  // 4) 有没有任何「查看 / 回顾 / 解析 / 答案 / 复习」入口
  out.reviewEntries = [...document.querySelectorAll('a, button, span, div')]
    .map((e) => (e.innerText || '').trim())
    .filter((t) => t && t.length <= 14 && /查看|回顾|解析|答案|详情|复习|报告/.test(t));
  out.reviewEntries = [...new Set(out.reviewEntries)];

  // 5) 未提交/已提交 数量
  out.submittedCount = document.body.innerText.match(/已提交/g)?.length || 0;
  out.unsubmittedCount = document.body.innerText.match(/未提交/g)?.length || 0;

  return out;
});

console.log(JSON.stringify(info, null, 1));

// 6) 点击「已提交」tab 看有无内容
console.log('\n尝试点击「已提交」标签…');
try {
  const t = page.getByText('已提交', { exact: true }).first();
  if (await t.count()) {
    await t.click({ timeout: 8000 });
    await page.waitForTimeout(6000);
    const after = await page.evaluate(() => ({
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600),
      hasEmpty: /暂无|没有|空/.test(document.body.innerText.slice(0, 400)),
      entries: [...new Set([...document.querySelectorAll('a, button, span')].map((e) => (e.innerText || '').trim()).filter((t) => t && t.length <= 14))].slice(0, 20),
    }));
    console.log('已提交页内容:', after.text.slice(0, 400));
    console.log('入口:', JSON.stringify(after.entries));
    writeFileSync(OUT + '\\submitted-tab.json', JSON.stringify(after, null, 2));
  } else console.log('未找到「已提交」标签');
} catch (e) { console.log('点击失败:', String(e).slice(0, 120)); }

writeFileSync(OUT + '\\review-check.json', JSON.stringify(info, null, 2));
console.log('\n已保存 recon/exam/review-check.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
