/**
 * electron/main.mjs —— Electron 主进程（桌面壳）
 *
 * 桌面版不再自己实现一套“后端逻辑”，而是**内嵌** server/index.mjs 的本机服务：
 *   1. 进程内启动后端（随机端口，仅监听 127.0.0.1）；
 *   2. 窗口直接加载 http://127.0.0.1:<port>/app/ —— 与 API 同源，天然免 CORS；
 *   3. 仅保留“原生文件对话框”这类必须由宿主提供的能力（IPC）。
 *
 * 这样桌面端与浏览器端/将来的插件、安卓共用同一套后端 API。
 */

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from '../server/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 内嵌的后端服务实例（全局单例） */
let backend = null;
let backendOrigin = '';

/**
 * 启动内嵌后端：端口传 0 让系统分配空闲端口，仅本机可访问。
 * @returns {Promise<string>} 形如 http://127.0.0.1:xxxxx
 */
async function startBackend() {
  backend = createServer({ host: '127.0.0.1', port: 0 });
  const { port, host } = await backend.start();
  const displayHost = host === '::' ? '127.0.0.1' : host;
  backendOrigin = `http://${displayHost}:${port}`;
  console.log(`[mdai] 内嵌后端已启动：${backendOrigin}`);
  return backendOrigin;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 820,
    backgroundColor: '#0f1115',
    title: 'md-ai-answer',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadURL(`${backendOrigin}/app/`);

  win.webContents.on('did-finish-load', () => console.log('[mdai] 页面加载完成'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[mdai] 页面加载失败 ${code} ${desc} -> ${url}`);
  });
  // win.webContents.openDevTools({ mode: 'detach' }); // 需要调试时打开
}

/* ------------------------------ IPC（仅宿主能力） ------------------------------ */

/** 打开题库文件（原生对话框） */
ipcMain.handle('mdai:openBank', async () => {
  const r = await dialog.showOpenDialog({
    title: '选择题库 Markdown 文件',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { path: p, name: path.basename(p), text: await readFile(p, 'utf8') };
});

/** 保存文本到用户选择的位置 */
ipcMain.handle('mdai:saveText', async (_e, { defaultPath, content }) => {
  const r = await dialog.showSaveDialog({
    title: '保存结果',
    defaultPath,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, content, 'utf8');
  return r.filePath;
});

/* ------------------------------ 生命周期 ------------------------------ */

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (e) {
    console.error('[mdai] 后端启动失败：', e.message);
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  await backend?.stop().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});
