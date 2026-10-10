// 个人信息（登录凭据）的统一入口：可自定义输入、可导入、可导出
//
// 设计要点：
//   1) 凭据不再只来自一个写死的文件。取值优先级（高 → 低）：
//        ① 命令行：--school / --student-id / --password / --real-name
//        ② 环境变量：ZHS_SCHOOL / ZHS_STUDENT_ID / ZHS_PASSWORD / ZHS_REAL_NAME
//        ③ 指定文件：--account <path>（任意来源导出的 JSON，字段名可自定义）
//        ④ 凭据库：config/credentials.json（本工具写入，含个人信息）
//        ⑤ 兼容旧文件：config/account-live.json、config/account.json
//   2) 导入时做字段别名归一，别人的文件不用改格式也能直接喂进来
//      （支持 userName/userid/account/sid/学号/密码/schoolName … 见 FIELD_ALIASES）
//   3) 登录成功后把「平台返回的真实姓名 + 实际选中的学校」回写凭据库，
//      文档封面因此不再依赖手写值，而是平台真值。
//   4) 写盘时尝试把权限收紧到仅当前用户。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const CONFIG = join(ROOT, 'config');

export const STORE = join(CONFIG, 'credentials.json');
export const LEGACY = [join(CONFIG, 'account-live.json'), join(CONFIG, 'account.json')];

/** 字段别名：把各种来源的命名归一到 { school, studentId, realName, password } */
export const FIELD_ALIASES = {
  school: ['school', 'schoolName', 'university', 'college', 'school_name', '学校', '院校', '学校名称'],
  studentId: ['studentId', 'student_id', 'studentNo', 'studentNumber', 'sid', 'unid', 'userId', 'userid',
    'userName', 'username', 'account', 'loginName', '学号', '账号', '用户名'],
  realName: ['realName', 'real_name', 'name', 'displayName', 'nickName', 'nickname', '姓名', '真实姓名'],
  password: ['password', 'passwd', 'pwd', 'pass', 'secret', '密码'],
};

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_-]/g, '');

/** 把任意对象归一成标准凭据字段；返回 { acc, mapped, unknown } */
export function normalizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return { acc: {}, mapped: {}, unknown: [] };
  const acc = {};
  const mapped = {};   // 标准字段 → 命中的原始键名
  const used = new Set();

  for (const [std, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const [k, v] of Object.entries(raw)) {
      if (used.has(k) || v === null || v === undefined || v === '') continue;
      if (typeof v === 'object') continue;
      if (aliases.some((a) => norm(a) === norm(k))) {
        acc[std] = String(v);
        mapped[std] = k;
        used.add(k);
        break;
      }
    }
  }
  const unknown = Object.keys(raw).filter((k) => !used.has(k) && k !== 'note' && k !== '$schema');
  return { acc, mapped, unknown };
}

function tryReadJson(path, tag) {
  if (!existsSync(path)) return null;
  try {
    // 去掉 BOM：很多工具（含 PowerShell 的 Out-File）导出的 JSON 带 BOM，JSON.parse 会直接失败。
    // 这里循环去掉所有前导 BOM，容忍被重复写入 BOM 的文件。
    let text = readFileSync(path, 'utf8');
    while (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const raw = JSON.parse(text);
    const { acc, mapped, unknown } = normalizeAccount(raw);
    return { tag, file: path, name: basename(path), acc, mapped, unknown, raw };
  } catch (e) {
    return { tag, file: path, name: basename(path), error: String(e).slice(0, 120) };
  }
}

/**
 * 解析凭据。
 * @param {{argv?: string[], env?: object, explicitFile?: string}} opts
 * @returns {{acc, source, candidates, problems, complete}}
 */
export function resolveAccount({ argv = process.argv.slice(2), env = process.env, explicitFile = null } = {}) {
  const getFlag = (names) => {
    for (const n of names) {
      const i = argv.indexOf('--' + n);
      if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    }
    return null;
  };

  const fromCli = {};
  const school = getFlag(['school']);
  const studentId = getFlag(['student-id', 'student', 'sid']);
  const password = getFlag(['password', 'pass']);
  const realName = getFlag(['real-name', 'name']);
  if (school) fromCli.school = school;
  if (studentId) fromCli.studentId = studentId;
  if (password) fromCli.password = password;
  if (realName) fromCli.realName = realName;

  const fromEnv = {};
  if (env.ZHS_SCHOOL) fromEnv.school = env.ZHS_SCHOOL;
  if (env.ZHS_STUDENT_ID) fromEnv.studentId = env.ZHS_STUDENT_ID;
  if (env.ZHS_PASSWORD) fromEnv.password = env.ZHS_PASSWORD;
  if (env.ZHS_REAL_NAME) fromEnv.realName = env.ZHS_REAL_NAME;

  const fileFlag = explicitFile || getFlag(['account', 'import']);
  const candidates = [];
  if (fileFlag) candidates.push(tryReadJson(join(process.cwd(), fileFlag), 'file') ?? tryReadJson(fileFlag, 'file'));
  candidates.push(tryReadJson(STORE, 'store'));
  for (const l of LEGACY) candidates.push(tryReadJson(l, 'legacy'));

  const read = candidates.filter((c) => c && !c.error);
  const problems = candidates.filter((c) => c && c.error).map((c) => `${c.name}: ${c.error}`);

  // 逐字段按优先级取第一个非空值
  const acc = { ...(read[0]?.acc ?? {}) };
  const source = { school: read[0]?.name ?? null, studentId: read[0]?.name ?? null, password: read[0]?.name ?? null, realName: read[0]?.name ?? null };
  for (const key of ['school', 'studentId', 'password', 'realName']) {
    if (fromEnv[key]) { acc[key] = fromEnv[key]; source[key] = 'env'; continue; }
    if (fromCli[key]) { acc[key] = fromCli[key]; source[key] = 'cli'; continue; }
    if (acc[key]) { source[key] = source[key] ?? 'file'; continue; }
    for (const c of read) {
      if (c.acc[key]) { acc[key] = c.acc[key]; source[key] = c.name; break; }
    }
  }

  // 备份文件名也要带上，方便排查
  const backup = ['ZHS_STUDENT_ID', 'ZHS_PASSWORD'].some((k) => env[k]) ? 'env' : null;
  if (backup && !source.password) source.password = 'env';

  return {
    acc,
    source,
    read,
    candidates,
    problems,
    complete: !!(acc.school && acc.studentId && acc.password),
    missing: ['school', 'studentId', 'password'].filter((k) => !acc[k]),
  };
}

/** 收紧文件权限到仅当前用户（尽力而为，失败不抛错） */
export function harden(path) {
  try {
    const r = spawnSync('icacls', [path, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { encoding: 'utf8' });
    return r.status === 0;
  } catch { return false; }
}

/** 写入凭据库（登录成功后回写真实姓名/学校也走这里） */
export function saveAccount(acc, { file = STORE, merge = true } = {}) {
  mkdirSync(join(file, '..'), { recursive: true });
  let existing = {};
  if (merge && existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  }
  const clean = {};
  for (const k of ['school', 'studentId', 'realName', 'password']) {
    const v = acc[k] ?? existing[k];
    if (v !== undefined && v !== null && v !== '') clean[k] = v;
  }
  clean.updatedAt = new Date().toISOString();
  clean.note = '本工具写入的登录凭据。请勿提交到任何仓库（.gitignore 已忽略 config/）。';
  writeFileSync(file, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  const secured = harden(file);
  return { file, saved: Object.keys(clean).filter((k) => k !== 'note' && k !== 'updatedAt'), secured };
}

/** 导入：读任意来源 → 归一 → 写入凭据库 */
export function importAccount(fromFile, { file = STORE, fields = null } = {}) {
  const p = existsSync(fromFile) ? fromFile : join(process.cwd(), fromFile);
  const got = tryReadJson(p, 'import');
  if (!got) return { ok: false, error: `读不到文件：${p}` };
  if (got.error) return { ok: false, error: `${p}: ${got.error}` };
  const acc = { ...got.acc, ...(fields ?? {}) };
  if (!acc.school || !acc.studentId || !acc.password) {
    return { ok: false, error: `归一后缺字段：${['school', 'studentId', 'password'].filter((k) => !acc[k]).join(', ')}`, mapped: got.mapped, unknown: got.unknown, acc };
  }
  const r = saveAccount(acc, { file });
  return { ok: true, ...r, mapped: got.mapped, unknown: got.unknown, acc };
}

/** 导出到指定文件（用于备份/迁移） */
export function exportAccount(acc, outFile) {
  const r = saveAccount(acc, { file: outFile, merge: false });
  return r;
}

/** 脱敏显示 */
export const mask = (s) => {
  const t = String(s ?? '');
  if (!t) return '(空)';
  if (t.length <= 2) return t[0] + '*';
  return t.slice(0, 1) + '*'.repeat(Math.min(t.length - 2, 8)) + t.slice(-1);
};

/** 可用字段速查（打印给人看） */
export function fieldHelp() {
  return Object.entries(FIELD_ALIASES).map(([std, aliases]) => `  ${std.padEnd(10)} ← ${aliases.join(' / ')}`).join('\n');
}
