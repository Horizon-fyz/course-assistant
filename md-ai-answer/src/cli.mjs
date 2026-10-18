#!/usr/bin/env node
/**
 * cli.mjs —— 命令行外壳（薄层）
 *
 * 只做三件「环境相关」的事：解析命令行、读写文件、打印日志；
 * 其余逻辑全部委托给 parser / answer / render / config，便于这些层被更大程序复用。
 *
 * 用法：
 *   node src/cli.mjs --input 题库.md [选项]
 *
 * 选项：
 *   -i, --input       题库 Markdown 文件（必填）
 *   -o, --out         答案输出文件（默认 题库.answers.md）
 *   -c, --config      配置文件路径（默认 ./config.json，存在即读取）
 *       --fill        额外生成回填答案的题库副本 题库.answered.md
 *       --mock        离线模拟，不调用 AI 接口
 *       --limit N     只处理前 N 题
 *       --base-url    覆盖接口地址
 *       --api-key     覆盖接口密钥
 *       --model       覆盖模型名
 *       --concurrency 并发请求数
 *       --batch-size  每批题目数
 *   -h, --help        显示帮助
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseQuestionBank } from './parser.mjs';
import { answerQuestions } from './answer.mjs';
import { renderAnswerMarkdown, renderFilledMarkdown } from './render.mjs';
import { resolveConfig, validateConfig } from './config.mjs';

/**
 * 极简参数解析：支持 `--key value`、`--key=value`、`-x value` 与布尔开关。
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseArgs(argv) {
  const args = { _: [] };
  const alias = { i: 'input', o: 'out', c: 'config' };
  const flags = new Set(['fill', 'mock', 'help', 'h']);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (flags.has(k)) args[k] = v === undefined ? true : v !== 'false';
      else if (v !== undefined) args[k] = v;
      else args[k] = argv[++i];
    } else if (a.startsWith('-') && a.length === 2) {
      const k = alias[a[1]] || a[1];
      args[k] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

const HELP = `用法: node src/cli.mjs --input 题库.md [--out 答案.md] [--fill] [--mock]

选项:
  -i, --input       题库 Markdown 文件（必填）
  -o, --out         答案输出文件
  -c, --config      配置文件（默认 ./config.json）
      --fill        额外生成回填答案的题库副本
      --answers-json <path>  结构化答案 JSON（默认 <题库>.answers.json，--answers-json=false 关闭）
      --mock        离线模拟，不调用 AI 接口
      --limit N     只处理前 N 题
      --base-url    覆盖接口地址
      --api-key     覆盖接口密钥
      --model       覆盖模型名
      --concurrency 并发数
      --batch-size  每批题目数`;

/**
 * 命令主流程。
 * @param {string[]} [argv] 参数（默认取 process.argv）
 * @returns {Promise<number>} 退出码
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(HELP);
    return 0;
  }

  const input = args.input || args._[0];
  if (!input) {
    console.log(HELP);
    return 1;
  }
  if (!existsSync(input)) {
    console.error(`找不到题库文件：${input}`);
    return 1;
  }

  // 1) 读取 + 解析
  const sourceText = await readFile(input, 'utf8');
  let questions = parseQuestionBank(sourceText);
  if (args.limit) questions = questions.slice(0, Number(args.limit));
  if (questions.length === 0) {
    console.error('未解析出任何题目，请检查题库格式（详见 README.md 的格式说明）。');
    return 1;
  }

  // 2) 合成配置
  const mock = Boolean(args.mock);
  const config = await resolveConfig({ configFile: args.config || 'config.json', args });
  if (!mock) {
    const missing = validateConfig(config);
    if (missing.length) {
      console.error(`配置不完整，缺少：${missing.join('、')}。请编辑 config.json 或使用 --mock。`);
      return 1;
    }
  }

  console.log(`题库：${input}`);
  console.log(`解析出题目：${questions.length} 题`);
  console.log(mock ? '模式：离线 mock（不调用 AI）' : `模式：${config.reasonModel} @ ${config.reasonBaseUrl}`);

  // 3) 编排答题（进度直接打印）
  const answers = await answerQuestions({
    questions,
    config,
    mock,
    hooks: { onProgress: (loaded, total) => process.stdout.write(`\r已作答 ${loaded}/${total}    `) },
  });
  process.stdout.write('\n');

  // 4) 渲染并落盘
  const outPath = args.out || `${input.replace(/\.md$/i, '')}.answers.md`;
  const meta = { source: path.basename(input), model: mock ? 'mock' : config.reasonModel };
  await writeFile(outPath, renderAnswerMarkdown({ questions, answers, meta }), 'utf8');
  console.log(`答案已写入：${outPath}`);

  if (args.fill) {
    const filledPath = `${input.replace(/\.md$/i, '')}.answered.md`;
    await writeFile(filledPath, renderFilledMarkdown({ sourceText, questions, answers }), 'utf8');
    console.log(`回填题库已写入：${filledPath}`);
  }

  // 结构化答案：供「自动回填网页」使用（按题干匹配，不依赖题号顺序）
  const jsonOut = typeof args['answers-json'] === 'string' && args['answers-json']
    ? args['answers-json']
    : `${input.replace(/\.md$/i, '')}.answers.json`;
  if (args['answers-json'] !== 'false') {
    const packed = {
      meta: { ...meta, generatedAt: new Date().toISOString(), count: questions.length },
      questions: questions.map((q) => {
        const a = answers.get(q.id) || {};
        return {
          id: q.id,
          number: q.number,
          section: q.section,
          type: q.type,
          stem: q.stem,
          options: q.options.map((o) => ({ key: o.key, text: o.text })),
          answer: a.answer || '',
          reason: a.reason || '',
          confidence: typeof a.confidence === 'number' ? a.confidence : null,
        };
      }),
    };
    await writeFile(jsonOut, JSON.stringify(packed, null, 2), 'utf8');
    console.log(`结构化答案：${jsonOut}`);
  }

  return 0;
}

/* 仅在被直接执行时运行，被 import（作为库复用）时不会触发任何副作用。 */
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error('运行失败：', e.message);
      process.exitCode = 1;
    });
}
