// 读取作业考试列表 + 探查题目是否可只读获取（不开始答题）
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, tidy } from './browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();

const pages = ctx.pages().filter((p) => p.url().includes('onlineexamh5new'));
console.log('考试页标签数:', pages.length);

const report = [];
for (const page of pages) {
  const url = page.url();
  const rid = (url.match(/recruitId=([^&]+)/) || [, ''])[1];
  console.log(`\n########## recruitId=${decodeURIComponent(rid)} ##########`);

  // 收集该页的网络调用
  const api = [];
  const onReq = (r) => {
    const u = r.url();
    if (!/zhihuishu/.test(u) || /\.(js|css|png|jpg|gif|woff2?|ico)(\?|$)/.test(u)) return;
    api.push({ method: r.method(), url: u.slice(0, 160), post: (r.postData() || '').slice(0, 300) });
  };
  page.on('request', onReq);

  // 重新加载以捕获接口
  await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(9000);

  const info = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.el-tabs__item, [class*=tab]')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 12);
    const items = [...document.querySelectorAll('[class*=examItem], [class*=exam-item], .item, li[class*=list], [class*=card]')]
      .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && /作业|考试|截止|提交|总分|题目/.test(t))
      .slice(0, 18);
    const btns = [...new Set([...document.querySelectorAll('button, a, [class*=btn]')].map((e) => (e.innerText || '').trim()).filter((t) => t && t.length <= 12))];
    return {
      url: location.href,
      title: document.title,
      text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 1000),
      tabs, items, btns,
    };
  });

  console.log('  标题:', info.title);
  console.log('  标签:', JSON.stringify(info.tabs));
  console.log('  按钮:', JSON.stringify(info.btns.slice(0, 16)));
  console.log('  条目:');
  for (const it of info.items.slice(0, 10)) console.log('    ·', it.slice(0, 150));
  console.log('  正文:', info.text.slice(0, 350));

  console.log('  --- 接口 ---');
  for (const c of api) console.log(`    ${c.method} ${c.url}${c.post ? '\n        post: ' + c.post : ''}`);

  await page.screenshot({ path: `${OUT}\\list-${decodeURIComponent(rid).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}.png` }).catch(() => {});
  page.off('request', onReq);
  report.push({ url, rid: decodeURIComponent(rid), info, api });
}

writeFileSync(OUT + '\\exam-lists.json', JSON.stringify(report, null, 2));
console.log('\n已保存 recon/exam/exam-lists.json');

try { await tidy(ctx); } catch {}
await browser.close().catch(() => {});
