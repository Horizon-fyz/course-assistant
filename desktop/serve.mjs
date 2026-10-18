// desktop/serve.mjs —— 桌面版后端入口
//
// 由外壳（智慧树助手.exe）用内置 node.exe 拉起：
//   环境变量 PORT            —— 外壳指定的监听端口
//   环境变量 ZHS_CONFIG      —— 配置文件路径（在 exe 同目录）
//   环境变量 ZHS_PORTABLE_DIR—— 便携根目录
//
// 兼容两种目录布局：
//   打包后：<exe>\app\serve.mjs + <exe>\app\md-ai-answer\server\index.mjs
//           + <exe>\app\desktop\ui\index.html   → /desktop/ui/index.html
//   源码中：<repo>\desktop\serve.mjs + <repo>\md-ai-answer\server\index.mjs
//           + <repo>\desktop\ui\index.html      → /ui/index.html
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const APP_ROOT = import.meta.dirname;

function pickPort() {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 8790;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`PORT 不合法：${raw}\n`);
    process.exit(1);
  }
  return port;
}

const PORT = pickPort();
const CONFIG = process.env.ZHS_CONFIG || path.join(APP_ROOT, '..', 'config.json');
// 数据目录（本地题库 bank.json）与配置文件同级的 data/
const DATA_DIR = path.join(path.dirname(CONFIG), 'data');

// 后端模块在“打包布局”与“源码布局”下的位置不同，按存在性选择
const SERVER_ENTRY = [
  path.join(APP_ROOT, 'md-ai-answer', 'server', 'index.mjs'),
  path.join(APP_ROOT, '..', 'md-ai-answer', 'server', 'index.mjs'),
].find((p) => existsSync(p));

if (!SERVER_ENTRY) {
  process.stderr.write('找不到后端模块：md-ai-answer/server/index.mjs\n');
  process.exit(1);
}

const { createServer } = await import(pathToFileURL(SERVER_ENTRY).href);

// 静态资源以 APP_ROOT 为根；界面路径随布局不同（打包后多一层 desktop/）
const UI_PREFIX = existsSync(path.join(APP_ROOT, 'desktop', 'ui', 'index.html'))
  ? '/desktop/ui/'
  : '/ui/';

const server = createServer({
  host: '127.0.0.1',
  port: PORT,
  configFile: CONFIG,
  staticRoot: APP_ROOT,
  dataDir: DATA_DIR,
});

try {
  const { port, host } = await server.start();
  const h = host === '::' || host === '0.0.0.0' ? '127.0.0.1' : host;
  process.stdout.write(`READY http://${h}:${port}${UI_PREFIX}index.html\n`);
} catch (e) {
  process.stderr.write(`后端启动失败：${e && e.message ? e.message : e}\n`);
  process.exit(1);
}
