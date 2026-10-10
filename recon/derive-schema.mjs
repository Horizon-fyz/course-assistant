// 从真实数据推导 papers.json 的完整字段结构，供编写 JSON Schema 使用
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('K:\\网页自动学习\\export\\papers.json', 'utf8'));

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

function walk(obj, prefix, acc) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    const t = typeOf(v);
    if (!acc.has(path)) acc.set(path, new Set());
    acc.get(path).add(t);
    if (t === 'object') walk(v, path, acc);
    else if (t === 'array' && v.length && typeof v[0] === 'object' && v[0] !== null) {
      const at = `${path}[]`;
      if (!acc.has(at)) acc.set(at, new Set());
      acc.get(at).add('object');
      walk(v[0], at, acc);
    }
  }
}

const hwFields = new Map();
const baseFields = new Map();
const qFields = new Map();
const partFields = new Map();
const optFields = new Map();

let hwCount = 0, qCount = 0, optCount = 0;
const qTypeNames = new Set();
const nonEmpty = {};

for (const [course, items] of Object.entries(data)) {
  for (const it of items) {
    hwCount++;
    walk(Object.fromEntries(Object.entries(it).filter(([k]) => k !== 'paper')), '', hwFields);
    const base = it.paper?.rt?.examBase;
    if (base) walk(base, '', baseFields);
    for (const p of base?.workExamParts ?? []) {
      walk(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'questionDtos')), '', partFields);
      for (const q of p.questionDtos ?? []) {
        qCount++;
        walk(Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'questionOptions')), '', qFields);
        qTypeNames.add(q.questionType?.name);
        for (const o of q.questionOptions ?? []) { optCount++; walk(o, '', optFields); }
      }
    }
  }
}

const show = (label, map) => {
  console.log(`\n=== ${label} ===`);
  for (const [k, types] of [...map.entries()].sort()) {
    console.log(`  ${k.padEnd(34)} ${[...types].join('|')}`);
  }
};

console.log(`课程数 ${Object.keys(data).length} · 作业 ${hwCount} · 题目 ${qCount} · 选项 ${optCount}`);
console.log('题型:', [...qTypeNames].join(', '));
show('作业字段（homework item）', hwFields);
show('试卷字段（examBase）', baseFields);
show('分卷字段（workExamParts[]）', partFields);
show('题目字段（questionDtos[]）', qFields);
show('选项字段（questionOptions[]）', optFields);

// 一些具体取值，便于写 enum / 示例
const samples = {};
for (const items of Object.values(data)) {
  for (const it of items) {
    for (const p of it.paper?.rt?.examBase?.workExamParts ?? []) {
      for (const q of p.questionDtos ?? []) {
        if (!samples.q) samples.q = q;
      }
    }
    if (!samples.hw) samples.hw = it;
  }
}
console.log('\n=== 样例题目（截断）===');
console.log(JSON.stringify(samples.q, null, 1).slice(0, 1500));
console.log('\n=== paper.rt 的键 ===');
console.log(Object.keys(samples.hw?.paper?.rt ?? {}));
console.log('=== paper 的键 ===');
console.log(Object.keys(samples.hw?.paper ?? {}));
