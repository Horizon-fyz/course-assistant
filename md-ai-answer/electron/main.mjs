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

import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from '../server/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 内嵌的后端服务实例（全局单例） */
let backend = null;
let backendOrigin = '';
/** 主窗口单例：启动与 activate 复用同一个窗口，避免重复建窗 */
let mainWindow = null;
/** 进程入口时间：启动各阶段日志都带上毫秒数 */
const startedAt = Date.now();

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
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  const win = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 820,
    backgroundColor: '#0f1115',
    title: 'md-ai-answer',
    // 先建窗口壳但不显示：等后端就绪、页面首帧渲染完成再显示，避免白屏/空窗
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // 只允许停留在内嵌后端页面：外部链接交给系统浏览器，
  // 防止窗口被导航到外站后，外站页面继续使用 preload 暴露的文件能力。
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (backendOrigin && String(targetUrl).startsWith(`${backendOrigin}/`)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(String(targetUrl))) shell.openExternal(targetUrl).catch(() => {});
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () =>
    console.log(`[mdai] 页面加载完成（${Date.now() - startedAt} ms）`));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[mdai] 页面加载失败 ${code} ${desc} -> ${url}`);
  });
  // win.webContents.openDevTools({ mode: 'detach' }); // 需要调试时打开
  return win;
}

/** 后端就绪后再加载页面；窗口隐藏等待首帧，避免用户看到白屏 */
function loadApp(win) {
  if (!backendOrigin || !win || win.isDestroyed()) return;
  win.loadURL(`${backendOrigin}/app/`);
  // 兜底：渲染异常时 ready-to-show 可能不触发，最多 4 秒也要把窗口显示出来
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 4000);
}

/* ------------------------------ IPC（仅宿主能力） ------------------------------ */

/** 只信任内嵌后端同源页面发来的 IPC，避免窗口被导航到外站后滥用原生文件能力 */
function assertLocalSender(event) {
  const senderUrl = String(event?.senderFrame?.url || '');
  if (!backendOrigin || !senderUrl.startsWith(`${backendOrigin}/`)) {
    throw new Error('拒绝来自非本机页面的请求');
  }
}

/** 打开题库文件（原生对话框） */
ipcMain.handle('mdai:openBank', async (event) => {
  assertLocalSender(event);
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
ipcMain.handle('mdai:saveText', async (event, payload) => {
  assertLocalSender(event);
  const { defaultPath, content } = payload || {};
  if (typeof content !== 'string') throw new Error('content 必须是字符串');
  const r = await dialog.showSaveDialog({
    title: '保存结果',
    defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await writeFile(r.filePath, content, 'utf8');
  return r.filePath;
});

/* ------------------------------ 生命周期 ------------------------------ */

// 单实例：重复双击时把已有窗口唤到前台，避免起第二个进程（第二个进程还会再占一个随机端口）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    // 首次启动尚未加载页面时不要强行显示，避免闪一下空窗口
    if (backendOrigin) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    // 窗口壳与后端并行：先把 BrowserWindow 建出来（隐藏），再启动内嵌服务，省掉串行等待
    const win = createWindow();
    try {
      await startBackend();
    } catch (e) {
      console.error('[mdai] 后端启动失败：', e.message);
      // 后端没起来时窗口只会加载失败，直接提示并退出，避免留下空白界面
      dialog.showErrorBox('后端启动失败', String(e.message || e));
      app.quit();
      return;
    }
    console.log(`[mdai] 后端就绪（${Date.now() - startedAt} ms）`);
    loadApp(win);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) loadApp(createWindow());
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // 退出时统一停后端；window-all-closed 在 macOS 上不退出应用，不能在那里停服务
  app.on('before-quit', () => {
    backend?.stop().catch(() => {});
  });
}
