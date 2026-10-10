// 精确提取 stuExamWeb 的取题/作答接口与调用方式
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const OUT = join(ROOT, 'recon', 'exam');
mkdirSync(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

const files = [
  'https://onlineexamh5new.zhihuishu.com/js/stuExamWeb.3577f5621cd754d97d2e.js',
  'https://onlineexamh5new.zhihuishu.com/js/common-api.d65f62bec32ce2be3e30.js',
];

const texts = {};
for (const u of files) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': UA, Referer: 'https://onlineexamh5new.zhihuishu.com/stuExamWeb.html' } });
    const t = await r.text();
    texts[u.split('/').pop()] = t;
    console.log(`${u.split('/').pop()}  ${t.length}B`);
  } catch (e) { console.log('ERR', u, String(e).slice(0, 80)); }
}

// 1) 抽所有接口路径
const allPaths = new Set();
for (const t of Object.values(texts)) {
  for (const m of t.matchAll(/["'`](\/[A-Za-z0-9_\/.-]*(?:gateway|exam|question|answer|paper|homework)[A-Za-z0-9_\/.-]*)["'`]/gi)) allPaths.add(m[1]);
  for (const m of t.matchAll(/url\s*:\s*["'`]([^"'`]{4,120})["'`]/g)) allPaths.add(m[1]);
}
console.log('\n=== 候选接口路径 ===');
for (const p of [...allPaths].sort()) if (/gateway|exam|question|answer|paper|homework/i.test(p)) console.log('  ' + p);

// 2) getQuestion / submitExam 的上下文
console.log('\n\n=== getQuestion / submitExam 调用上下文 ===');
for (const [name, t] of Object.entries(texts)) {
  for (const key of ['getQuestion', 'submitExam', 'saveAnswer', 'startExam', 'getExamPaper', 'beginAnswer']) {
    let i = -1, n = 0;
    while ((i = t.indexOf(key, i + 1)) >= 0 && n < 2) {
      console.log(`\n[${name}] "${key}" @${i}`);
      console.log('  ' + t.slice(Math.max(0, i - 400), i + 400).replace(/\s+/g, ' '));
      n++;
    }
  }
}

writeFileSync(OUT + '\\exam-js-extract.json', JSON.stringify({ allPaths: [...allPaths].sort() }, null, 2));
console.log('\n已保存 recon/exam/exam-js-extract.json');
