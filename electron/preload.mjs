import { contextBridge } from "electron";

// 简单壳层，所有业务通信走 HTTP API + WebSocket
// 不需要暴露 Node.js 能力到渲染进程
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
  },
});
