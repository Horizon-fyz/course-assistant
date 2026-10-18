// 从混淆的 app.js 中抽取字符串常量里的 URL / 接口路径
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

const src = readFileSync(join(ROOT, 'recon', 'out', 'js', 'app.js'), 'utf8');

// 1) 所有带引号的字符串字面量
const lits = new Set();
for (const m of src.matchAll(/'((?:[^'\\]|\\.){4,400})'/g)) lits.add(m[1]);
for (const m of src.matchAll(/"((?:[^"\\]|\\.){4,400})"/g)) lits.add(m[1]);

const urls = new Set();
const paths = new Set();
const hosts = new Set();

for (const s of lits) {
  if (/^https?:\/\//i.test(s) || /^\/\//.test(s)) {
    urls.add(s);
    const h = s.replace(/^https?:\/\//i, '').replace(/^\/\//, '').split(/[/?]/)[0];
    if (h) hosts.add(h);
  } else if (/^\/[a-zA-Z0-9_\-/.]+$/.test(s) && s.length > 3 && s.split('/').length > 1) {
    paths.add(s);
  }
}

// 2) 反混淆：找出字符串数组本身（形如 var X=['a','b',...]），扫描其全部元素
const arrays = [];
for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*\[((?:\s*'(?:[^'\\]|\\.)*'\s*,?)+)\]/g)) {
  const items = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1]);
  if (items.length > 20) arrays.push({ name: m[1], count: items.length, items });
}

const arrUrls = new Set();
const arrHosts = new Set();
const arrPaths = new Set();
for (const a of arrays) {
  for (const s of a.items) {
    if (/^(https?:)?\/\//i.test(s)) {
      arrUrls.add(s);
      const h = s.replace(/^(https?:)?\/\//i, '').split(/[/?]/)[0];
      if (h) arrHosts.add(h);
    } else if (/^\/[a-zA-Z0-9_\-/.]+$/.test(s) && s.length > 3 && s.split('/').length > 2) {
      arrPaths.add(s);
    }
  }
}

const dump = [
  '=== STRING ARRAYS ===',
  ...arrays.map((a) => `${a.name} (${a.count})`),
  '',
  '=== HOSTS (literal + array) ===',
  ...[...new Set([...hosts, ...arrHosts])].sort(),
  '',
  '=== FULL URLS ===',
  ...[...new Set([...urls, ...arrUrls])].sort(),
  '',
  '=== API-LIKE PATHS (literal) ===',
  ...[...paths].filter((p) => /api|gateway|json|list|get|query|save|login|course|exam|homework|video|study|recruit|user|student/i.test(p)).sort(),
  '',
  '=== API-LIKE PATHS (from arrays) ===',
  ...[...arrPaths].filter((p) => /api|gateway|json|list|get|query|save|login|course|exam|homework|video|study|user|student/i.test(p)).sort(),
].join('\n');

writeFileSync(join(ROOT, 'recon', 'out', 'endpoints.txt'), dump);
console.log('literals:', lits.size, 'arrays:', arrays.length, 'hosts:', hosts.size + arrHosts.size, 'urls:', urls.size + arrUrls.size, 'paths:', paths.size + arrPaths.size);
