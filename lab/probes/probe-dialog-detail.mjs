// 深入分析 dialog-read 弹窗的 DOM 结构与关闭机制
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect, readyPage, tidy, HOME } from '../../src/core/browser.mjs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const OUT = join(ROOT, 'recon', 'dialog');
mkdirSync(OUT, { recursive: true });

const { browser, ctx } = await connect();
const page = await readyPage(ctx, HOME);
await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

try { await page.locator('text=大学生心理健康教育').first().click({ timeout: 10000 }); } catch {}
await page.waitForTimeout(9000);

const detail = await page.evaluate(() => {
  const out = { found: false };
  // 找 dialog-read 及其外层 wrapper
  const el = document.querySelector('.dialog-read');
  if (!el) return out;
  out.found = true;

  const walk = (node, depth = 0) => {
    if (depth > 4) return null;
    const r = node.getBoundingClientRect();
    const cs = getComputedStyle(node);
    const info = {
      tag: node.tagName,
      cls: (node.className || '').toString().slice(0, 100),
      id: node.id || '',
      rect: `${Math.round(r.width)}x${Math.round(r.height)}`,
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      zIndex: cs.zIndex, position: cs.position,
      text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      onclick: node.getAttribute && node.getAttribute('onclick') || '',
      children: [],
    };
    if (depth < 4) {
      for (const c of node.children) {
        const ci = walk(c, depth + 1);
        if (ci) info.children.push(ci);
      }
    }
    return info;
  };
  out.tree = walk(el);

  // 向上找 wrapper
  let p = el.parentElement, chain = [];
  for (let i = 0; i < 5 && p; i++) {
    const r = p.getBoundingClientRect();
    chain.push({
      tag: p.tagName, cls: (p.className || '').toString().slice(0, 100),
      rect: `${Math.round(r.width)}x${Math.round(r.height)}`,
      display: getComputedStyle(p).display,
    });
    p = p.parentElement;
  }
  out.ancestors = chain;

  // 全页找所有可能是关闭按钮的元素
  const closers = [];
  document.querySelectorAll('*').forEach((n) => {
    const cls = ((n.className || '') + ' ' + (n.id || '')).toString();
    const title = (n.getAttribute && (n.getAttribute('title') || n.getAttribute('aria-label'))) || '';
    if (/close|icon-close|el-dialog__close|dialog-close|cancel/i.test(cls) || /关闭/.test(title)) {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      closers.push({
        tag: n.tagName, cls: cls.slice(0, 90), title,
        rect: `${Math.round(r.width)}x${Math.round(r.height)}`,
        display: cs.display, visibility: cs.visibility,
        visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
        text: (n.innerText || '').trim().slice(0, 30),
      });
    }
  });
  out.closers = closers.slice(0, 25);

  // 底部按钮区
  const footer = document.querySelector('.dialog-read .dialog-footer, .dialog-read .el-dialog__footer, .dialog-read .footer, .dialog-read [class*=btn]');
  out.footerHtml = footer ? footer.outerHTML.slice(0, 800) : null;

  // 弹窗自身 HTML（截断）
  out.dialogHtml = el.outerHTML.slice(0, 2500);
  return out;
});

console.log(JSON.stringify(detail, null, 1).slice(0, 6000));
writeFileSync(OUT + '\\dialog-detail.json', JSON.stringify(detail, null, 2));
console.log('\n已保存 recon/dialog/dialog-detail.json');

await page.screenshot({ path: OUT + '\\dialog-detail.png' });
await tidy(ctx);
await browser.close().catch(() => {});
