// desktop/serve.mjs —— 桌面版后端入口
//
// 由外壳（智慧树助手.exe）用内置 node.exe 拉起：
//   环境变量 PORT            —— 外壳指定的监听端口
//   环境变量 ZHS_CONFIG      —— 配置文件路径（在 exe 同目录）
//   环境变量 ZHS_PORTABLE_DIR—— 便携根目录
//
// 静态资源以 desktop 目录为根，因此界面地址是 /desktop/ui/index.html。
import path from 'node:path';
import { createServer } from './md-ai-answer/server/index.mjs';

const APP_ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT || 8790);
const CONFIG = process.env.ZHS_CONFIG || path.join(APP_ROOT, '..', 'config.json');
// 数据目录（本地题库 bank.json）与配置文件同级的 data/
const DATA_DIR = path.join(path.dirname(CONFIG), 'data');

const server = createServer({
  host: '127.0.0.1',
  port: PORT,
  configFile: CONFIG,
  staticRoot: APP_ROOT,
  dataDir: DATA_DIR,
});

const { port, host } = await server.start();
const h = host === '::' ? '127.0.0.1' : host;
process.stdout.write(`READY http://${h}:${port}/desktop/ui/index.html\n`);
