# git-safe-commit-tool Electron 改造设计文档

## 概述

将 Git Safe Commit Tool 从「本地 Express 服务 + 浏览器」架构改造为 Electron 桌面应用，
用户双击一个 exe 即可使用，不再依赖外部浏览器。

## 设计决策

| 决策项 | 结论 |
|--------|------|
| 桌面框架 | **Electron**（行业标准，Node.js 原生兼容） |
| 启动方式 | **内嵌启动**（Electron 主进程直接加载 Express 后端，同进程） |
| 配置路径 | **`%APPDATA%/git-safe-commit-tool/config.json`**（Windows 标准） |
| 交付形态 | **便携版 exe**（electron-builder portable） |

## 架构

```
git-safe-commit.exe
│
├── Electron Main Process
│   ├── 初始化 %APPDATA%/git-safe-commit-tool/ 目录与配置
│   ├── 启动 Express 后端
│   ├── Express 监听 127.0.0.1:随机端口
│   ├── 创建 BrowserWindow，加载 http://127.0.0.1:{port}
│   └── 窗口关闭 → 退出进程
│
├── Express Backend（现有 server.mjs + lib/）
│   ├── API 路由（Git操作、AI调用、冲突处理）
│   ├── WebSocket/SSE 事件推送
│   └── 全部保持不动
│
├── Vue Frontend（现有 src/ 构建后 dist/）
│   ├── 所有 UI、组件、样式 保持不动
│   └── API 请求通过 origin 相对路径
│
└── electron-builder 打包
    └── 产出: git-safe-commit-{version}.exe（便携版）
```

## 新增文件

### `electron/main.mjs` — Electron 主进程入口

- 初始化 `app.getPath('userData')` 下的 `config.json`（不存在则从默认模板创建）
- 导入 `server.mjs` 的 `createApp()`，启动 Express
- 创建 `BrowserWindow`，构造参数：
  - `width: 1280, height: 800`
  - `webPreferences: { preload: path.join(__dirname, 'preload.mjs') }`
  - `icon: path.join(__dirname, '..', 'public', 'icon.png')`（可选）
- BrowserWindow 加载 `http://127.0.0.1:{port}`
- 监听 `window.on('closed')` → `app.quit()`

### `electron/preload.mjs` — Preload 脚本（可选）

- 通过 `contextBridge` 暴露少量 API（如有需要）
- 默认空实现，按需扩展

## 现有文件的修改

### `server.mjs` — 小幅度重构

```mjs
// 新增导出的 createApp 函数
export async function createApp(customConfig) {
  const cfg = customConfig || config;
  const app = express();
  // ... 所有现有路由注册保持不变 ...
  const server = app.listen(0, '127.0.0.1'); // 端口 0 = 系统自动分配
  const port = server.address().port;
  return { app, server, port };
}

// 保留直接启动路径（npm start / npm dev 照常可用）
if (process.argv[1] && process.argv[1].includes('server.mjs')) {
  const { server, port } = await createApp();
  console.log(`git-safe-commit-tool listening at http://127.0.0.1:${port}`);
}
```

### `package.json` — 依赖与构建配置

```json
{
  "main": "electron/main.mjs",
  "scripts": {
    "electron:dev": "electron .",
    "package": "npm run build && electron-builder"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0"
  }
}
```

### `lib/config.mjs` — 配置路径优先顺序

1. `%APPDATA%/git-safe-commit-tool/config.json`（Electron 模式）
2. 项目目录下的 `config.json`（向后兼容 dev 模式）
3. `config.example.json`（首次创建模板）

## 打包输出

使用 `electron-builder` portable 目标：

```yaml
appId: com.git-safe-commit-tool
productName: Git Safe Commit Tool
directories:
  output: release
win:
  target:
    - target: portable
      arch: [x64]
portable:
  artifactName: "git-safe-commit-${version}.exe"
extraResources:
  - from: "lib"
    to: "lib"
  - from: ".agents"
    to: ".agents"
```

产出单个 `git-safe-commit-{version}.exe`，双击即用。

## 不做的事情

| 模块 | 原因 |
|------|------|
| `lib/` 所有模块 | Git、AI、冲突处理逻辑完全不变 |
| `src/` Vue 前端 | UI 代码完全不变 |
| `dist/` 构建产物 | 依然是 `vite build` |
| `test/` 测试 | 原有测试继续有效 |
| Git 调用方式 | 仍然调用系统 Git |
| AI API 调用 | 不变 |

## 开发与调试流程

1. `npm run dev` — 现有方式（Vite + Express），纯浏览器开发前端
2. `npm run electron:dev` — Electron 窗口加载前端，调试桌面集成
3. `npm run package` — 构建前端 + 打包为便携 exe

测试路径不变：`npm test` 继续有效。

## 验证标准

1. 双击 exe 正常启动，不弹出 cmd 窗口
2. 自动打开 Electron 窗口，显示完整 UI
3. 所有 Git 操作（commit/push/rebase/conflict resolve）正常工作
4. AI 调用（commit message suggestion / audit review）正常工作
5. 配置持久化到 `%APPDATA%/git-safe-commit-tool/config.json`
6. 关闭窗口后进程完全退出
