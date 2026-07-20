import { app, BrowserWindow, dialog } from "electron";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  const serverPath = pathToFileURL(path.join(__dirname, "..", "server.mjs")).href;
  const { createApp } = await import(serverPath);
  // port = 0 → 系统自动分配端口
  const result = await createApp(undefined, 0);
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
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    backgroundColor: "#0e1a2b",
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on("closed", () => {
    mainWindow = null;
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
