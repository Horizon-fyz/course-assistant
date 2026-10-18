/**
 * bank.mjs —— 本地题库层
 *
 * 作用：把「已经作答过的题目」持久化到本地，下次遇到同样的题目直接复用答案，
 * 不再浪费一次 AI 调用。命中判据是**归一化后的题干**（去空白/标点/大小写）。
 *
 * 存储格式（<dataDir>/bank.json）：
 * {
 *   "version": 1,
 *   "entries": {
 *     "<stemKey>": { "stem": "原题干", "type": "single", "options": [...],
 *                    "answer": "A", "reason": "...", "hits": 3, "updatedAt": 1710000000000 }
 *   }
 * }
 *
 * @module bank
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

/**
 * 题干的归一化 key：去掉所有空白、常见标点，转小写。
 * 只用于「同一道题」的判定，不用于展示。
 * @param {string} stem
 * @returns {string}
 */
export function stemKey(stem) {
  return String(stem || '')
    .replace(/\s+/g, '')
    .replace(/[\u3000-\u303f\uff00-\uff5e]/g, '') // 全角标点/空格段
    .replace(/[.,;:!?'"`~()\[\]{}<>/\\|+\-*=@#$%^&_、。，；：！？…—～·“”‘’（）【】《》]/g, '')
    .toLowerCase();
}

/** 选择题类题型（这些题型必须有多个选项才算完整） */
const CHOICE_TYPES = new Set(['single', 'multiple', 'choice', 'multi']);

/** 极短字符串哈希（FNV-1a），仅用于给同题干不同选项的条目生成稳定后缀 */
function shortHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 选项签名：「题型 + 各选项文本归一化」。
 * 只归一化题干会让「同题干、不同选项」的两道题共用一条记录，
 * 从而把 A 题的答案套到 B 题上。签名用于区分它们。
 * @param {{type?:string, options?:object[]}} q
 * @returns {string}
 */
export function optionSignature(q) {
  const options = Array.isArray(q?.options) ? q.options : [];
  const text = options.map((o) => stemKey(o?.text ?? o?.key ?? o)).join('|');
  return text ? `${String(q?.type || '').toLowerCase()}:${text}` : '';
}

/**
 * 判断一条识别结果是否「完整」，可安全写入题库。
 * 页面被遮挡 / 只截到一截时，模型会「忠实」地只录下残缺的一小段
 * （题干过短或选项不全），这种结果不入库，避免用垃圾答案污染已有记录。
 * @param {{stem?:string,type?:string,options?:object[]}} q
 * @returns {boolean}
 */
export function isCompleteQuestion(q) {
  if (!q) return false;
  if (stemKey(q.stem).length < 6) return false; // 题干过短，多半是残句
  const options = Array.isArray(q.options) ? q.options : [];
  const type = String(q.type || '').toLowerCase();
  const isChoice = CHOICE_TYPES.has(type) || options.length > 0;
  // 选择题必须有 ≥2 个选项；判断题/填空/简答无选项也视为完整
  if (isChoice && options.length < 2) return false;
  return true;
}

/** 新建一个空题库 */
export function emptyBank() {
  return { version: 1, entries: {} };
}

/**
 * 读取题库文件；不存在或损坏时返回空题库（不抛错，保证主流程不被拖垮）。
 * @param {string} file
 * @returns {Promise<{version:number, entries:Record<string, object>}>}
 */
export async function loadBank(file) {
  try {
    const txt = await readFile(file, 'utf8');
    const obj = JSON.parse(txt);
    if (obj && typeof obj === 'object' && obj.entries && typeof obj.entries === 'object') {
      return { version: obj.version || 1, entries: obj.entries };
    }
  } catch {
    /* 文件不存在 / 解析失败 → 当作空题库 */
  }
  return emptyBank();
}

/**
 * 写回题库文件（自动建目录）。先写同目录临时文件再 rename，
 * 避免进程中断或断电时留下半截 JSON 把整个题库弄坏。
 * @param {string} file
 * @param {{entries:Record<string, object>}} bank
 */
export async function saveBank(file, bank) {
  await mkdir(path.dirname(file), { recursive: true });
  const out = { version: 1, entries: bank.entries || {} };
  const tmp = `${file}.${process.pid}.${Date.now()}.${saveSeq++}.tmp`;
  await writeFile(tmp, JSON.stringify(out, null, 2), 'utf8');
  await rename(tmp, file);
}

let saveSeq = 0;
/** 每个题库文件一条串行队列，保证「读 → 改 → 写」不互相覆盖 */
const bankQueues = new Map();

/**
 * 在串行队列内完成「读 → 改 → 写」。
 * 三个接口同时命中/写回题库时，单纯的 load + save 会丢更新（后写的覆盖先写的），
 * 这里用同一文件的 Promise 链把整个事务串起来。
 *
 * @template T
 * @param {string} file
 * @param {(bank:object) => T|Promise<T>} mutator 直接修改传入的 bank
 * @returns {Promise<T>}
 */
export function updateBank(file, mutator) {
  const prev = bankQueues.get(file) || Promise.resolve();
  const run = prev.then(async () => {
    const bank = await loadBank(file);
    const result = await mutator(bank);
    await saveBank(file, bank);
    return result;
  });
  const tail = run.then(
    () => {},
    () => {},
  );
  bankQueues.set(file, tail);
  tail.finally(() => {
    if (bankQueues.get(file) === tail) bankQueues.delete(file);
  });
  return run;
}

/** 题库条目数 */
export function bankCount(bank) {
  return Object.keys((bank && bank.entries) || {}).length;
}

/**
 * 在题库里找这道题。
 * 先精确匹配 key；未命中时，若题干足够长（≥12 字），再尝试「互相包含」的模糊匹配。
 * 与旧版的区别：
 *   1) 残缺条目（题干过短 / 选项不全）永不命中，避免用垃圾答案覆盖真答案；
 *   2) 命中多条时优先返回「更完整（key 更长）」的那条，长度并列视为歧义、放弃命中；
 *   3) 前缀/后缀命中必须长度接近（≥0.6），避免用一小截题干套到完全不同的长题上；
 *   4) 传入题目对象时校验选项签名，同题干不同选项不会被误判为同一题。
 * @param {object} bank
 * @param {string} stem
 * @param {{type?:string,options?:object[]}} [question] 原始题目（可选，用于选项校验）
 * @returns {{key:string, entry:object}|null}
 */
export function matchBank(bank, stem, question = null) {
  const entries = (bank && bank.entries) || {};
  const key = stemKey(stem);
  if (!key) return null;

  /** 选项不一致的条目不能命中（题干相同但选项换了，答案就不成立） */
  const compatible = (entry) => {
    if (!question) return true;
    const a = optionSignature(entry);
    const b = optionSignature(question);
    return !a || !b || a === b;
  };

  // 精确命中：仅当该条目本身完整时直接复用
  const exact = entries[key];
  if (exact && isCompleteQuestion(exact) && compatible(exact)) return { key, entry: exact };

  // 太短的题干做模糊匹配极易误伤，直接放弃
  if (key.length < 12) return null;

  let best = null;
  let ambiguous = false;
  for (const k of Object.keys(entries)) {
    const entry = entries[k];
    // 残缺条目永不命中（它自己就是被截断的脏数据）
    if (!isCompleteQuestion(entry)) continue;
    if (k.length < 12) continue;
    if (!compatible(entry)) continue;

    let related = k === key;
    if (!related && (k.indexOf(key) >= 0 || key.indexOf(k) >= 0)) {
      const lo = Math.min(k.length, key.length);
      const hi = Math.max(k.length, key.length);
      const ratio = lo / hi;
      const isAffix = k.startsWith(key) || k.endsWith(key) || key.startsWith(k) || key.endsWith(k);
      // 长度接近（≥0.8）视为同一题；仅有前/后缀关系时要求至少 0.6，
      // 避免「一小截题干」把无关的长题干也拽进来
      related = ratio >= 0.8 || (isAffix && ratio >= 0.6);
    }
    if (!related) continue;

    // 多条相关时，取「更完整」（key 更长）的那条；最长者并列 → 歧义，放弃命中
    if (!best || k.length > best.key.length) {
      best = { key: k, entry };
      ambiguous = false;
    } else if (k.length === best.key.length && k !== best.key) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

/**
 * 写入 / 更新一条题目（按归一化题干去重）。
 * 已存在且新答案为空时，保留旧答案，只累加命中次数。
 * @param {object} bank
 * @param {{stem:string,type?:string,options?:object[],answer?:string,reason?:string}} q
 * @returns {string} 该条目的 key
 */
export function upsertBank(bank, q) {
  if (!bank.entries) bank.entries = {};
  // 残缺识别（题干过短 / 选项不全）不入库，避免污染题库
  if (!isCompleteQuestion(q)) return '';
  const base = stemKey(q.stem);
  if (!base) return '';

  // 同题干但选项不同 → 用签名后缀另存一条，避免两条不同的题互相覆盖答案
  const sig = optionSignature(q);
  const altKey = sig ? `${base}~${shortHash(sig)}` : '';
  let key = base;
  let prev = bank.entries[base];
  const prevSig = prev ? optionSignature(prev) : '';
  if (prev && prevSig && sig && prevSig !== sig) {
    key = altKey;
    prev = bank.entries[altKey];
  } else if (!prev && altKey && bank.entries[altKey]) {
    key = altKey;
    prev = bank.entries[altKey];
  }

  const answer = String(q.answer || '').trim();
  // 空答案不覆盖已有答案（避免"这次没识别出来"把好答案冲掉）
  if (prev && !answer) {
    prev.hits = (prev.hits || 0) + 1;
    prev.updatedAt = Date.now();
    return key;
  }

  bank.entries[key] = {
    stem: String(q.stem || '').replace(/\s+/g, ' ').trim(),
    type: q.type || (prev && prev.type) || 'single',
    options: Array.isArray(q.options) && q.options.length ? q.options : (prev && prev.options) || [],
    answer,
    reason: String(q.reason || (prev && prev.reason) || '').trim(),
    hits: (prev && prev.hits ? prev.hits : 0) + 1,
    updatedAt: Date.now(),
  };
  return key;
}
