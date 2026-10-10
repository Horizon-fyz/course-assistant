// 用无头 Edge 把 MD 题库渲染成 HTML 并打印成 PDF，验证「可打印性」
// 说明：这里自带一个极简 Markdown 渲染器（只处理我们生成器用到的语法），
//       目的是让打印验证不依赖任何外部 Markdown 工具。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const ARGV = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = ARGV.indexOf('--' + n);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d;
};
const SRC = resolve(flag('src', join(ROOT, 'export', '智慧树作业题库_打印版.md')));
const HTML = resolve(flag('html', join(ROOT, 'export', '智慧树作业题库_打印预览.html')));
const PDF = resolve(flag('out', join(ROOT, 'export', '智慧树作业题库_打印版.pdf')));

if (!existsSync(SRC)) { console.error('缺少 ' + SRC); process.exit(1); }
mkdirSync(dirname(HTML), { recursive: true });
const md = readFileSync(SRC, 'utf8');

// ---------- 取出文首的 <style> 块 ----------
let css = '';
const styleMatch = md.match(/<style>([\s\S]*?)<\/style>/);
if (styleMatch) css = styleMatch[1];
const bodyMd = md.replace(/<style>[\s\S]*?<\/style>/g, '').trim();

const escHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (t) => escHtml(t)
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/(^|\s)\*(?!\s)(.+?)\*/g, '$1<em>$2</em>')
  .replace(/\\([\\`*_[\]]|<|>)/g, '$1');

// ---------- 极简 Markdown → HTML ----------
const out = [];
let inList = false;
const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

for (const raw of bodyMd.split('\n')) {
  const line = raw.replace(/\s+$/, '');

  if (/^\s*$/.test(line)) { closeList(); continue; }

  // 分隔线
  if (/^-{3,}$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }

  // 标题
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

  // 缩进选项（3 空格 + A. ...）
  const opt = line.match(/^\s{2,}([A-Z])\.\s+(.*)$/);
  if (opt) { out.push(`<div class="opt"><span class="ol">${opt[1]}.</span> ${inline(opt[2])}</div>`); continue; }

  // 有序题目（1. **题干**）
  const num = line.match(/^(\d+)\.\s+(.*)$/);
  if (num) {
    out.push(`<div class="q"><div class="stem"><span class="qn">${num[1]}.</span> ${inline(num[2])}</div></div>`);
    continue;
  }

  // 引用
  const bq = line.match(/^>\s?(.*)$/);
  if (bq) { closeList(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }

  // 列表
  const li = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (li) {
    const depth = Math.floor(li[1].length / 2);
    if (!inList) { out.push('<ul>'); inList = true; }
    out.push(`<li class="d${depth}">${inline(li[2])}</li>`);
    continue;
  }

  closeList();
  out.push(`<p>${inline(line)}</p>`);
}
closeList();

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>智慧树作业题库 · 打印稿</title>
<style>
${css}
body { background: #fff; color: #000; }
.q { margin: 12px 0 16px; }
.stem { font-weight: 600; }
.qn { font-weight: 700; margin-right: 2px; }
.ol { font-weight: 700; margin-right: 2px; }
.opt { margin: 1px 0 1px 1.6em; }
.opt:last-child { margin-bottom: 0; }
blockquote { color: #444; }
li.d1 { margin-left: 1.2em; list-style: none; }
li.d1::before { content: ""; }
ul { padding-left: 1.4em; }
@media print { .opt, .q { page-break-inside: avoid; } }
</style>
</head>
<body>
${out.join('\n')}
</body>
</html>`;

writeFileSync(HTML, html, 'utf8');
process.stderr.write(`html: ${HTML}  (${html.length} 字符)\n`);

// ---------- 无头 Edge 打印 PDF ----------
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
await page.goto('file:///' + HTML.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 60000 });
await page.waitForTimeout(1200);
await page.pdf({
  path: PDF,
  format: 'A4',
  printBackground: true,
  margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate: '<div style="font-size:8px;color:#888;width:100%;text-align:center;">第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>',
});
await browser.close();

const pdfSize = (await import('node:fs')).statSync(PDF).size;
process.stderr.write(`pdf : ${PDF}  (${(pdfSize / 1024).toFixed(1)} KB)\n`);
