# Electron 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Git Safe Commit Tool 从本地 Server+浏览器架构改造为 Electron 桌面应用，双击便携 exe 即用

**Architecture:** Electron 主进程内嵌启动 Express 后端，通过 localhost 加载 Vue 前端到 BrowserWindow。所有业务代码 (lib/、server.mjs、Vue 前端) 保持不动，只新增 Electron 壳层代码。

**Tech Stack:** Electron 33, electron-builder 25, Express 5, Vue 3

## Global Constraints

- 便携版 exe，不写注册表，不在开始菜单创建快捷方式
- 配置文件存储在 `%APPDATA%/git-safe-commit-tool/config.json`
- 保留 `npm start` / `npm run dev` 纯浏览器开发路径不变
- 不要新增任何运行时依赖（devDependencies 可以加）
- 关闭窗口 = 退出整个进程

---

### Task 1: 安装 Electron 工具链

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安装 Electron 和 electron-builder**

```powershell
npm install --save-dev electron@^33.0.0 electron-builder@^25.0.0
```

- [ ] **Step 2: 验证安装成功**

Run: `npx electron --version`
Expected: 输出类似 `v33.x.x`

- [ ] **Step 3: 提交**

```powershell
git add package.json package-lock.json
git commit -m "[Config] -- 新增 Electron 和 electron-builder 开发依赖"
```

---

### Task 2: 重构 server.mjs — 导出 createApp()

**Files:**
- Modify: `server.mjs:1-307`
- Test: `test/server-test.mjs`（如果存在则验证通过）

**Interfaces:**
- Produces: `export async function createApp(customConfig?)` — 返回 `{ app, server, port }`

- [ ] **Step 1: 将配置加载和 app 创建抽为 createApp 函数**

**关键设计：** 所有路由闭包引用了模块级的 `config` 和 `runner` 变量。`createApp` 加载配置后赋值给模块级变量，路由自然生效。

原 `server.mjs:1-39`（模块顶部）改为：

```mjs
import express from "express";
import path from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import { detectInstalledAi } from "./lib/ai-installations.mjs";
import { reviewAuditWithAi } from "./lib/ai-audit-review.mjs";
import { suggestCommitMessage } from "./lib/commit-message-suggester.mjs";
import { defaultConfigPath, loadConfig, maskConfig, saveConfig } from "./lib/config.mjs";
import {
  applyConflictCandidate,
  exportBinaryConflict,
  loadBinaryConflict,
  loadTableConflict,
  loadTextConflict,
  writeBinaryCandidate,
  writeTableCandidate,
  writeTextCandidate
} from "./lib/conflict-workbench.mjs";
import { pickFolder } from "./lib/folder-picker.mjs";
import { pathInsideRepo, runGit } from "./lib/git-executor.mjs";
import { getGitGraph, getCommitDetail } from "./lib/git-graph.mjs";
import { createWorkflowRunner } from "./lib/workflow-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const toolRoot = path.dirname(__filename);
const packageInfo = JSON.parse(await readFile(path.join(toolRoot, "package.json"), "utf8"));
const toolVersion = packageInfo.version || "0.0.0";

// 模块级变量：config 和 runner 被路由闭包引用
let config = null;
let runner = null;
const eventClients = new Set();
const sessionLogs = [];

export async function createApp(customConfig) {
  const configPath = defaultConfigPath();
  const cfg = customConfig || await loadConfig(configPath, { allowMissing: true });
  // 更新模块级变量供路由闭包使用
  config = cfg;
  runner = createRunner(cfg);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // ---- 以下所有路由注册代码保持原样不变 ----
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, tool: "git-safe-commit-tool", version: toolVersion, repoPath: config.repoPath });
  });
  app.get("/api/config", (_req, res) => {
    res.json({ ok: true, config: maskConfig(config) });
  });
  // ... 所有 app.get/app.post/app.use 从原文件中复制，完全不变 ...

  // 静态文件服务（保持不变）
  const distRoot = path.join(toolRoot, "dist");
  const srcRoot = path.join(toolRoot, "src");
  const useBuiltFrontend = process.env.NODE_ENV === "production" || (existsSync(distRoot) && !existsSync(srcRoot));
  if (useBuiltFrontend) {
    app.use(express.static(distRoot));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(distRoot, "index.html")));
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({ root: toolRoot, server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  }

  // 错误处理中间件
  app.use((error, _req, res, _next) => {
    appendLog("error", { message: error.message });
    res.status(500).json({ ok: false, error: error.message, audit: error.audit || null });
  });

  // 启动服务器（端口 0 = 系统自动分配）
  const server = app.listen(0, "127.0.0.1");
  const port = server.address().port;
  console.log(`git-safe-commit-tool listening at http://127.0.0.1:${port}`);
  console.log(`repo: ${cfg.repoPath}`);

  // WebSocket 事件服务器
  const eventServer = new WebSocketServer({ server, path: "/api/events" });
  eventServer.on("connection", (socket) => {
    eventClients.add(socket);
    writeEvent(socket, "state", { state: runner.state, logs: sessionLogs.slice(-200) });
    socket.on("close", () => eventClients.delete(socket));
    socket.on("error", () => eventClients.delete(socket));
  });

  return { app, server, port, eventServer };
}

// 保持直接运行 server.mjs 的兼容性（npm start / npm run dev）
const isDirectRun = process.argv[1] && (
  process.argv[1].replace(/\\/g, "/").includes("server.mjs")
  || process.argv[1].replace(/\\/g, "/").includes("server")
);
if (isDirectRun) {
  const { port } = await createApp();
  // 直接运行时 config 已经在 createApp 中被赋值
}

// ---- 以下辅助函数保持完全不变 ----
function createRunner(nextConfig) { ... }
function appendLog(event, data) { ... }
function broadcast(event, data) { ... }
function writeEvent(socket, event, data) { ... }
function openLocalFile(filePath) { ... }
async function loadFileDiff(...) { ... }
// ... renderDiffHtml, diffLineKind, htmlEscape ...
```

实际操作时，留意图中标记 "保持不变" / "完全不变" 的代码块，直接从原文件复制。

- [ ] **Step 2: 运行测试验证**

```powershell
npm test
```

Expected: 所有测试通过

- [ ] **Step 3: 手动验证 dev 模式**

```powershell
npm run dev
```
在浏览器中打开 `http://127.0.0.1:19348`（或你的配置端口），确认页面和所有功能正常。

- [ ] **Step 4: 提交**

```powershell
git add server.mjs
git commit -m "[Refactor] -- server.mjs 导出 createApp() 供 Electron 主进程调用
新增 createApp 函数，返回 { app, server, port }，保留直接启动兼容性"
```

---

### Task 3: 创建 electron/main.mjs — Electron 主进程

**Files:**
- Create: `electron/main.mjs`

**Interfaces:**
- Consumes: `server.mjs` 的 `createApp(customConfig)`；`lib/config.mjs` 的 `defaultConfigPath()`
- Produces: Electron 主进程入口，无导出

- [ ] **Step 1: 创建 electron/ 目录**

```powershell
mkdir electron
```

- [ ] **Step 2: 编写 electron/main.mjs**

```mjs
import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. 初始化配置路径
const userDataPath = app.getPath("userData");
const configDir = userDataPath;
if (!existsSync(configDir)) {
  mkdirSync(configDir, { recursive: true });
}

// 设置环境变量，让 config.mjs 的 defaultConfigPath() 能找到 AppData 路径
process.env.GIT_SAFE_COMMIT_CONFIG = path.join(configDir, "config.json");

let mainWindow = null;
let backendServer = null;

async function startBackend() {
  // 动态导入 server.mjs（它在项目根目录）
  const { createApp } = await import(path.join(__dirname, "..", "server.mjs"));
  const result = await createApp();
  backendServer = result.server;
  return result.port;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Git 安全提交工具",
    icon: undefined, // 可以选择添加图标
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false, // 等 ready-to-show 再显示，避免白屏闪烁
    backgroundColor: "#0e1a2b",
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
    // 关闭 Express 服务器
    if (backendServer) {
      backendServer.close();
      backendServer = null;
    }
  });
}

app.whenReady().then(async () => {
  try {
    const port = await startBackend();
    createWindow(port);
  } catch (err) {
    console.error("Failed to start backend:", err);
    dialog.showErrorBox("启动失败", `后端服务启动失败：${err.message}`);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (backendServer) {
    backendServer.close();
    backendServer = null;
  }
});
```

- [ ] **Step 3: 提交**

```powershell
git add electron/main.mjs
git commit -m "[Feature] -- 新增 Electron 主进程入口
主进程：启动 Express 后端 → 等待就绪 → 创建 BrowserWindow 加载 UI → 窗口关闭退出"
```

---

### Task 4: 创建 electron/preload.mjs

**Files:**
- Create: `electron/preload.mjs`

**Interfaces:**
- Produces: 通过 `contextBridge` 暴露给渲染进程的 API（当前为空壳，按需扩展）

- [ ] **Step 1: 编写 preload.mjs**

```mjs
const { contextBridge } = require("electron");

// 简单壳层，所有业务通信走 HTTP API + WebSocket
// 不需要暴露 Node.js 能力到渲染进程
contextBridge.exposeInMainWorld("electronAPI", {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
  },
});
```

- [ ] **Step 2: 验证文件存在**

```powershell
Test-Path electron/preload.mjs
```

Expected: `True`

- [ ] **Step 3: 提交**

```powershell
git add electron/preload.mjs
git commit -m "[Feature] -- 新增 Electron preload 脚本
通过 contextBridge 暴露平台信息和版本号，保持 contextIsolation 启用"
```

---

### Task 5: 更新 package.json — 添加 Electron 脚本和配置

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 修改 package.json**

当前：
```json
{
  "name": "git-safe-commit-tool",
  "version": "0.1.13",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node server.mjs",
    "build": "vite build",
    "preview": "node server.mjs",
    "start": "node server.mjs",
    "test": "node --test"
  },
  "dependencies": { ... },
  "engines": { "node": ">=18" }
}
```

改为：
```json
{
  "name": "git-safe-commit-tool",
  "version": "0.1.13",
  "private": true,
  "type": "module",
  "main": "electron/main.mjs",
  "scripts": {
    "dev": "node server.mjs",
    "build": "vite build",
    "preview": "node server.mjs",
    "start": "node server.mjs",
    "electron:dev": "electron .",
    "package": "vite build && electron-builder --win portable",
    "test": "node --test"
  },
  "dependencies": { ... },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0"
  },
  "engines": { "node": ">=18" }
}
```

- [ ] **Step 2: 确认改动正确**

```powershell
node -e "const p = require('./package.json'); console.log(p.main, p.scripts.package)"
```

Expected: `electron/main.mjs vite build && electron-builder --win portable`

- [ ] **Step 3: 提交**

```powershell
git add package.json
git commit -m "[Config] -- 新增 Electron 启动和打包脚本
electron:dev 用于开发调试，package 用于构建便携 exe"
```

---

### Task 6: 创建 electron-builder.yml

**Files:**
- Create: `electron-builder.yml`

- [ ] **Step 1: 编写构建配置**

```yaml
appId: com.git-safe-commit-tool
productName: Git Safe Commit Tool
copyright: "Copyright © 2026"

directories:
  output: release
  buildResources: build

files:
  - electron/**/*
  - server.mjs
  - lib/**/*
  - dist/**/*
  - config.example.json
  - package.json

extraResources:
  - from: "lib"
    to: "lib"
    filter:
      - "**/*"

win:
  target:
    - target: portable
      arch:
        - x64

portable:
  artifactName: "git-safe-commit-${version}.exe"

asar: true
compression: normal
```

- [ ] **Step 2: 验证配置文件格式**

```powershell
node -e "const yaml = require('node:fs').readFileSync('electron-builder.yml', 'utf8'); console.log('Config exists, length:', yaml.length)"
```

- [ ] **Step 3: 提交**

```powershell
git add electron-builder.yml
git commit -m "[Config] -- 新增 electron-builder 便携版打包配置"
```

---

### Task 7: 构建前端 + 打包验证

**Files:**
- 无（打包流程验证）

- [ ] **Step 1: 构建前端**

```powershell
npm run build
```

Expected: `dist/` 目录生成，包含 `index.html` 和打包后的 JS/CSS

- [ ] **Step 2: 打包为便携 exe**

```powershell
npm run package
```

Expected: `release/` 目录下生成 `git-safe-commit-0.1.13.exe`（约 150-200MB）

- [ ] **Step 3: 功能验证**

双击生成的 exe，验证：
1. ✅ 应用窗口正常打开（无 cmd 窗口）
2. ✅ 页面正常加载，UI 完整显示
3. ✅ Git 状态正常显示
4. ✅ 配置存储到 `%APPDATA%/git-safe-commit-tool/config.json`
5. ✅ 关闭窗口后，任务管理器中没有残留进程

- [ ] **Step 4: 提交剩余变动**

```powershell
git add -A
git commit -m "[Build] -- 生成 Electron 便携版 exe 并验证功能正常"
```

---

### 回退方案

如果需要回退某个任务的改动：

```powershell
# 回退单个任务
git revert <commit-hash> --no-edit

# 完全回退所有 Electron 改动（保留设计文档）
git revert HEAD~6..HEAD --no-edit
```
