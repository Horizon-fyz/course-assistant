// 汇总三门课的作业与考试数据 + 统计新发现域名
import { readFileSync, writeFileSync } from 'node:fs';
import { connect, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const BASE = ROOT;
const { browser, ctx } = await connect();

// 1) 三门课的考试数据（从已捕获的响应里提取）
const existing = JSON.parse(readFileSync(BASE + '\\recon\\exam\\exam-start-probe.json', 'utf8'));
const domains = new Set();
for (const r of existing.responses) {
  try { domains.add(new URL(r.url).host); } catch {}
}

// 2) 补齐：逐考试页取 getStudentHomework / getStudentFinalExam
const courses = [];
for (const page of ctx.pages().filter((p) => p.url().includes('onlineexamh5new'))) {
  const rid = decodeURIComponent((page.url().match(/recruitId=([^&]+)/) || [, ''])[1]);
  const data = await page.evaluate(async () => {
    const out = { homework: null, final: null };
    // 用页面自身的加密函数生成 secretStr 不可行；改为读 Vue 实例/全局已缓存数据
    const w = window;
    out.hasVue = !!document.querySelector('#app');
    out.text = document.body.innerText.replace(/\s+/g, ' ').slice(0, 150);
    return out;
  }).catch(() => ({}));
  courses.push({ rid, ...data });
}

// 3) 从 exam-lists.json 汇总已有的作业/考试条目
let lists = [];
try { lists = JSON.parse(readFileSync(BASE + '\\recon\\exam\\exam-lists.json', 'utf8')); } catch {}

console.log('=== 已捕获的考试相关域名 ===');
for (const d of [...domains].sort()) console.log('  ' + d);

console.log('\n=== 三门课的作业/考试条目 ===');
for (const l of lists) {
  console.log(`\n--- ${l.info?.text?.slice(0, 20)} (recruitId=${l.rid}) ---`);
  for (const it of (l.info?.items || []).slice(0, 14)) console.log('   ·', it.slice(0, 130));
  for (const b of (l.info?.btns || []).filter((x) => /考试/.test(x))) console.log('   [考试入口]', b);
}

writeFileSync(BASE + '\\recon\\exam\\exam-summary.json', JSON.stringify({ domains: [...domains].sort(), courses, lists }, null, 2));
console.log('\n已保存 recon/exam/exam-summary.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
