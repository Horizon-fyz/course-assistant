// 交互式读取一行输入（供 zhs.mjs import --prompt 使用）
//
// 为什么不用 powershell Read-Host：它读不了管道输入，脚本化/自动化场景直接卡死。
// 这里优先用 node 自己的 stdin：
//   - 有 TTY：用 raw mode 隐藏回显读密码
//   - 无 TTY（管道/重定向）：按行读取，便于自动化测试
import { createInterface } from 'node:readline';

/** 读一行普通文本 */
export function askLine(question) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY === false) {
      // 管道模式：一行一个输入
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
      process.stdout.write(question);
      rl.once('line', (line) => { rl.close(); resolve(String(line).trim()); });
      rl.once('close', () => resolve(''));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(String(answer).trim()); });
  });
}

/** 读密码：TTY 下不回显；非 TTY 下按行读取 */
export function askSecret(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (stdin.isTTY !== true) {
      // 管道模式无法关回显，按普通行读取
      askLine(question).then(resolve);
      return;
    }
    process.stdout.write(question);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          return resolve(buf);
        }
        if (ch === '\u0003') {           // Ctrl+C
          stdin.setRawMode(wasRaw ?? false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {   // 退格
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
