// 用 docs/schemas/*.schema.json 校验产物结构，并额外做业务规则检查
//
// 用法：
//   node recon\validate-data.mjs
//   node recon\validate-data.mjs --papers X.json --courses Y.json
//
// 退出码：0 通过 / 3 不通过
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const ARGV = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = ARGV.indexOf('--' + n);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : d;
};

const PAPERS = resolve(flag('papers', join(ROOT, 'export', 'papers.json')));
const COURSES = resolve(flag('courses', join(ROOT, 'export', 'courses-resolved.json')));
const SCHEMAS = join(ROOT, 'docs', 'schemas');

// ---------- 极简 JSON Schema 校验器（draft-07 子集，够用即可） ----------
function typeOk(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    if (t === 'null') return value === null;
    if (t === 'array') return Array.isArray(value);
    if (t === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    if (t === 'integer') return Number.isInteger(value);
    if (t === 'number') return typeof value === 'number';
    if (t === 'string') return typeof value === 'string';
    if (t === 'boolean') return typeof value === 'boolean';
    return false;
  });
}

function validate(value, schema, path, schemaRoot, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    const ref = schema.$ref.replace(/^#\//, '').split('/');
    let node = schemaRoot;
    for (const seg of ref) node = node?.[seg];
    return validate(value, node, path, schemaRoot, errors);
  }
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((s) => {
      const sink = [];
      validate(value, s, path, schemaRoot, sink);
      return sink.length === 0;
    });
    if (!hits.length) errors.push(`${path}: 不满足 oneOf 的任何分支`);
    return;
  }
  if (schema.type && !typeOk(value, schema.type)) {
    errors.push(`${path}: 期望 ${JSON.stringify(schema.type)}，实际 ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: 值 ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema.enum)} 中`);
  }
  if (Array.isArray(value)) {
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`, schemaRoot, errors));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const req of schema.required ?? []) {
      if (!(req in value)) errors.push(`${path}: 缺少必填字段 ${req}`);
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validate(v, props[k], `${path}.${k}`, schemaRoot, errors);
      // 未声明字段不报错：平台字段会变，schema 只约束关键结构
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (!props[k]) validate(v, schema.additionalProperties, `${path}.${k}`, schemaRoot, errors);
      }
    }
  }
}

function check(label, file, schemaFile) {
  const out = { label, file, ok: true, schemaErrors: [], ruleErrors: [], warnings: [], stats: {} };
  if (!existsSync(file)) { out.ok = false; out.schemaErrors.push(`文件不存在：${file}`); return out; }
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { out.ok = false; out.schemaErrors.push('JSON 解析失败: ' + String(e).slice(0, 120)); return out; }

  if (schemaFile && existsSync(schemaFile)) {
    let schema = null;
    try { schema = JSON.parse(readFileSync(schemaFile, 'utf8')); }
    catch (e) { out.schemaErrors.push(`schema 损坏 ${schemaFile}: ${String(e.message || e).slice(0, 120)}`); }
    if (schema) validate(data, schema, '$', schema, out.schemaErrors);
  }
  if (out.schemaErrors.length) out.ok = false;
  out.data = data;
  return out;
}

const results = [];

// ---------- papers.json ----------
const papers = check('papers.json', PAPERS, join(SCHEMAS, 'papers.schema.json'));
if (papers.data) {
  const d = papers.data;
  const courses = Object.keys(d);
  let hw = 0, q = 0, opt = 0, noPaper = 0, emptyQ = 0, submitted = 0;
  const typeCount = new Map();
  for (const [course, items] of Object.entries(d)) {
    if (!Array.isArray(items)) { papers.ruleErrors.push(`课程 ${course} 的值不是数组`); continue; }
    for (const it of items) {
      hw++;
      if (!it.paper) { noPaper++; papers.ruleErrors.push(`${course}/${it.examName}: 未抓到试卷（paper 为空）`); }
      // 旧数据可能没有 state/backNum/score 字段，缺字段只提示，不误判为已提交
      const hasState = it.state !== undefined && it.backNum !== undefined && it.score !== undefined;
      if (hasState && !(it.state === 1 && it.backNum === 3 && it.score === null)) {
        submitted++;
        papers.ruleErrors.push(`${course}/${it.examName}: 疑似已提交/已消耗（state=${it.state} backNum=${it.backNum} score=${it.score}）`);
      } else if (!hasState) {
        papers.warnings.push(`${course}/${it.examName}: 缺少 state/backNum/score，跳过提交状态判断`);
      }
      const qs = (it.paper?.rt?.examBase?.workExamParts ?? []).flatMap((p) => p.questionDtos ?? []);
      if (!qs.length && it.paper) { emptyQ++; papers.ruleErrors.push(`${course}/${it.examName}: 试卷里没有题目`); }
      for (const que of qs) {
        q++;
        const t = que.questionType?.name ?? '未知';
        typeCount.set(t, (typeCount.get(t) ?? 0) + 1);
        const n = (que.questionOptions ?? []).length;
        opt += n;
        // 只有选择题/判断题才必须有选项；填空题、简答题本来就没有
        if (n === 0 && /单选|多选|判断|选择|不定项/.test(t)) {
          papers.ruleErrors.push(`${course}/${it.examName}: ${t}无选项 —— ${String(que.name).slice(0, 40)}`);
        }
      }
    }
  }
  papers.stats = {
    课程: courses.length, 作业: hw, 题目: q, 选项: opt,
    未抓到试卷: noPaper, 空试卷: emptyQ, 疑似已提交: submitted,
    题型: Object.fromEntries(typeCount),
  };
}
if (papers.ruleErrors.length) papers.ok = false;
results.push(papers);

// ---------- courses-resolved.json ----------
const courses = check('courses-resolved.json', COURSES, join(SCHEMAS, 'courses-resolved.schema.json'));
if (courses.data) {
  let missing = 0;
  for (const [name, c] of Object.entries(courses.data)) {
    if (!c.listRid) { missing++; courses.ruleErrors.push(`${name}: 缺少 listRid（下次抓取会自动补）`); }
  }
  courses.stats = { 课程: Object.keys(courses.data).length, 缺listRid: missing };
  // 缺 listRid 只是提示，不算失败
}
results.push(courses);

// ---------- 输出 ----------
const C = process.stdout.isTTY
  ? { r: '\x1b[0m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m', d: '\x1b[2m' }
  : { r: '', b: '', g: '', y: '', red: '', d: '' };

console.log(`${C.b}数据契约校验${C.r}`);
for (const r of results) {
  const mark = r.schemaErrors.length ? `${C.red}✗${C.r}` : `${C.g}✓${C.r}`;
  console.log(`\n${mark} ${C.b}${r.label}${C.r}  ${C.d}${r.file}${C.r}`);
  if (r.stats && Object.keys(r.stats).length) console.log('   统计: ' + JSON.stringify(r.stats, null, 0).replace(/"/g, ''));
  if (r.schemaErrors.length) {
    console.log(`   ${C.red}结构错误 ${r.schemaErrors.length} 条：${C.r}`);
    for (const e of r.schemaErrors.slice(0, 10)) console.log('     · ' + e);
    if (r.schemaErrors.length > 10) console.log(`     …另 ${r.schemaErrors.length - 10} 条`);
  }
  if (r.ruleErrors.length) {
    console.log(`   ${C.y}规则警告 ${r.ruleErrors.length} 条：${C.r}`);
    for (const e of r.ruleErrors.slice(0, 10)) console.log('     · ' + e);
    if (r.ruleErrors.length > 10) console.log(`     …另 ${r.ruleErrors.length - 10} 条`);
  }
  if (r.warnings?.length) {
    console.log(`   ${C.d}提示 ${r.warnings.length} 条：${C.r}`);
    for (const e of r.warnings.slice(0, 5)) console.log('     · ' + e);
    if (r.warnings.length > 5) console.log(`     …另 ${r.warnings.length - 5} 条`);
  }
  if (!r.schemaErrors.length && !r.ruleErrors.length) console.log(`   ${C.g}结构与业务规则均通过${C.r}`);
}

const failed = results.filter((r) => r.schemaErrors.length || r.ruleErrors.length);
console.log('');
if (failed.length) {
  console.log(`${C.red}不通过：${failed.map((f) => f.label).join('、')}${C.r}`);
  process.exit(3);
}
console.log(`${C.g}全部通过${C.r}`);
process.exit(0);
