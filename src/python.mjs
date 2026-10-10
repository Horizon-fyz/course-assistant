// 定位可用的 Python 解释器 —— 不写死用户名与盘符
//
// 顺序：
//   1) 环境变量 PYTHON
//   2) DSH 自带运行时（$DSH_HOME/dsh-runtimes/.../python/python.exe，DSH_HOME 缺省为 ~/.dsh）
//   3) 退回 PATH 上的 python
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';

const DSH_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh');

const CANDIDATES = [
  process.env.PYTHON,
  join(DSH_HOME, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
];

/** 绝对路径候选里第一个真实存在的；都不存在则退回 PATH 上的 `python` */
export const PY = CANDIDATES.find((p) => p && p.includes(sep) && existsSync(p)) || 'python';
