// 交互式读取输入（供 zhs.mjs import --prompt 使用）
//
// 为什么不用 powershell Read-Host：它读不了管道输入，脚本化/自动化场景会直接卡死。
//
// 关键实现点（踩过的坑）：**不能每个问题都 new 一个 readline 接口**。
// 每次 close 会把 stdin 置为 paused，下一个接口就再也收不到数据，
// 表现为「只有第一个提示能输入，后面直接卡住」并触发
// "Detected unsettled top-level await"。
// 因此这里共用一个读取器 + 行队列。
import { createInterface } from 'node:readline';

let reader = null;
const pending = [];   // { resolve, question }
const buffered = [];  // 已到达但还没被消费的行
let closed = false;

function ensureReader() {
  if (reader || closed) return;
  reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const onLine = (line) => {
    const v = String(line);
    if (pending.length) pending.shift().resolve(v.trim());
    else buffered.push(v);
  };
  reader.on('line', onLine);
  reader.on('close', () => {
    closed = true;
    // 流结束：把还在等的问题用空串放行，避免永久挂起
    while (pending.length) pending.shift().resolve('');
  });
  process.stdin.on('error', () => {
    closed = true;
    while (pending.length) pending.shift().resolve('');
  });
}

/** 读一行普通文本 */
export function askLine(question = '') {
  ensureReader();
  if (question) process.stdout.write(question);
  if (buffered.length) return Promise.resolve(buffered.shift().trim());
  if (closed) return Promise.resolve('');
  return new Promise((resolve) => pending.push({ resolve, question }));
}

/** 读密码：TTY 下不回显；非 TTY（管道）下按普通行读取 */
export function askSecret(question = '') {
  const stdin = process.stdin;
  if (stdin.isTTY !== true) return askLine(question);

  return new Promise((resolve) => {
    process.stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const finish = (value) => {
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(buf);
        if (ch === '\u0003') {                       // Ctrl+C
          stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {        // 退格
          if (buf.length) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue;
        buf += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}
