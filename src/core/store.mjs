// store.mjs —— 统一的根目录/数据目录 + 数据文件原子读写
//
// 所有模块都从这里取数据目录，避免出现「部分模块读 export、部分模块读
// ZHS_DATA_DIR」导致便携版读错目录的问题。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

/** 题库/报告等业务数据目录：默认 <ROOT>\export，可用 ZHS_DATA_DIR 重定向 */
export const DATA_DIR = process.env.ZHS_DATA_DIR
  ? resolve(process.env.ZHS_DATA_DIR)
  : join(ROOT, 'export');

export function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * 严格读取：文件不存在返回 fallback；文件存在但 JSON 损坏则抛错。
 * 用于「读-改-写」业务数据（如 papers.json），避免把损坏文件当空对象覆盖。
 */
export function readJsonStrict(file, fallback = null, label = file) {
  if (!existsSync(file)) return fallback;
  let text = readFileSync(file, 'utf8');
  while (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${label} 已损坏，为避免覆盖丢失数据，已中止：${String(e.message || e).slice(0, 120)}`);
  }
}

let seq = 0;

/** 原子写：先写同目录临时文件再 rename，避免写成半截 JSON */
export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${seq++}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

/**
 * 在 courses-resolved.json 里查课程条目。
 * 缓存可能以 courseId 或课程名为 key（历史数据），这里统一兼容。
 */
export function findCourse(resolved, { courseId, courseName } = {}) {
  if (!resolved || typeof resolved !== 'object') return null;
  const vals = Object.values(resolved).filter((v) => v && typeof v === 'object');
  if (courseId != null) {
    const hit = vals.find((v) => String(v.courseId) === String(courseId));
    if (hit) return hit;
  }
  if (courseName) {
    const hit = vals.find((v) => v.courseName === courseName);
    if (hit) return hit;
    if (resolved[courseName]) return resolved[courseName];
  }
  return null;
}
