/**
 * library-usage.mjs —— 把 md-ai-answer 当作「库」嵌入更大程序的示例
 *
 * 演示三件事：
 *   1. 只从公共出口 import，不依赖命令行；
 *   2. 注入自定义 AI 客户端（此处用假客户端，完全离线，可直接 `npm run example:lib` 运行）；
 *   3. 通过 hooks 接入宿主自己的进度/日志。
 *
 * 真实宿主接入时，把 fakeClient 换成 createClient({ baseUrl, apiKey, model }) 即可。
 */

import { readFile } from 'node:fs/promises';
import {
  parseQuestionBank,
  answerQuestions,
  renderAnswerMarkdown,
} from '../src/index.mjs';

/**
 * 自造的假 AI 客户端，满足 AIClient 接口：{ chat, chatJson, model }。
 * 作用：证明「AI 调用」可被宿主整体替换（换服务商 / 加缓存 / 走代理 / 测试）。
 */
const fakeClient = {
  model: 'fake-model',
  async chat(messages) {
    // 从 user 消息里粗略取题号，返回一个合法的 JSON 答案数组
    const user = messages.find((m) => m.role === 'user')?.content || '';
    const numbers = [...user.matchAll(/^\[#(\d+)\]/gm)].map((m) => m[1]);
    const arr = numbers.map((n) => ({
      number: n,
      answer: 'A',
      reason: '由假客户端生成',
      confidence: 0.99,
    }));
    return JSON.stringify(arr);
  },
  async chatJson(messages) {
    return JSON.parse(await this.chat(messages));
  },
};

async function run() {
  const bankText = await readFile(new URL('./sample-bank.md', import.meta.url), 'utf8');

  // 1) 解析
  const questions = parseQuestionBank(bankText);
  console.log(`解析出 ${questions.length} 道题`);

  // 2) 作答（注入假客户端 + 进度钩子）
  const answers = await answerQuestions({
    questions,
    config: { batchSize: 2, concurrency: 2 }, // 仅用于分批并发，不用于建客户端
    client: fakeClient,
    hooks: {
      onProgress: (loaded, total) => console.log(`  进度 ${loaded}/${total}`),
      onError: (e) => console.warn('  某批失败：', e.message),
    },
  });

  // 3) 渲染（宿主可自行决定写入文件 / 塞进 DOM / 回传接口）
  const md = renderAnswerMarkdown({
    questions,
    answers,
    meta: { source: 'sample-bank.md', model: fakeClient.model },
  });

  console.log('\n===== 渲染结果（前 12 行）=====');
  console.log(md.split('\n').slice(0, 12).join('\n'));
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
