/**
 * electron/preload.cjs —— 预加载脚本（安全桥）
 *
 * 运行在「渲染进程与主进程之间」，是唯一允许同时触达两边的胶水。
 * 这里只暴露极小的白名单 API，不暴露任何 Node 能力，保证 contextIsolation 下的安全。
 *
 * 采用 CommonJS（.cjs）而非 ESM：Electron 的 preload 对 CJS 支持最稳。
 *
 * 暴露对象：window.mdai
 *   isElectron : true
 *   openBank() : Promise<{path,name,text}|null>   打开题库文件
 *   saveText({defaultPath,content}) : Promise<string|null>  保存文本
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mdai', {
  isElectron: true,
  openBank: () => ipcRenderer.invoke('mdai:openBank'),
  saveText: (payload) => ipcRenderer.invoke('mdai:saveText', payload),
});
