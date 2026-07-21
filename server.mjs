import express from "express";
import path from "node:path";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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
import { getLogger, initLogger, resolveLogDirectory } from "./lib/logger.mjs";

const __filename = fileURLToPath(import.meta.url);
const toolRoot = path.dirname(__filename);
const packageInfo = JSON.parse(await readFile(path.join(toolRoot, "package.json"), "utf8"));
const toolVersion = packageInfo.version || "0.0.0";
const configPath = defaultConfigPath();
let config = null;
let runner = null;
const eventClients = new Set();
const sessionLogs = [];

export async function createApp(customConfig, userPort) {
  const cfg = customConfig || await loadConfig(configPath, { allowMissing: true });
  config = cfg;
  await initLogger({
    directory: resolveLogDirectory(config.repoPath, config.log?.directory),
    level: config.log?.level || "info"
  });
  runner = createRunner(cfg);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // 使用指定端口，或配置端口，或 0（自动分配）

function allowLogApi(res) {
  const host = String(config.server?.host || "").toLowerCase();
  if (["127.0.0.1", "::1", "[::1]", "localhost"].includes(host)) return true;
  res.status(403).json({ ok: false, error: "log API is available only on a loopback-bound server" });
  return false;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, tool: "git-safe-commit-tool", version: toolVersion, repoPath: config.repoPath });
});

app.get("/api/logs", async (_req, res, next) => {
  try {
    if (!allowLogApi(res)) return;
    const logger = getLogger();
    const files = await logger.listFiles();
    const sorted = files.sort((a, b) => b.name.localeCompare(a.name));
    res.json({ ok: true, files: sorted.map((f) => ({ name: f.name })) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/logs/download/:fileName", async (req, res, next) => {
  try {
    if (!allowLogApi(res)) return;
    const logger = getLogger();
    const files = await logger.listFiles();
    const file = files.find((f) => f.name === req.params.fileName);
    if (!file) { res.status(404).json({ ok: false, error: "file not found" }); return; }
    const metadata = await stat(file.path);
    if (!metadata.isFile()) { res.status(404).json({ ok: false, error: "file not found" }); return; }
    if (metadata.size > 10 * 1024 * 1024) {
      res.status(413).json({ ok: false, error: "log file exceeds the 10 MB download limit" });
      return;
    }
    res.type("text/plain");
    createReadStream(file.path)
      .on("error", (error) => res.headersSent ? res.destroy(error) : next(error))
      .pipe(res);
  } catch (error) {
    next(error);
  }
});

app.get("/api/config", (_req, res) => {
  res.json({ ok: true, config: maskConfig(config) });
});

app.get("/api/ai/installations", (_req, res) => {
  res.json({
    ok: true,
    selected: config.ai.selected,
    installations: detectInstalledAi()
  });
});

app.post("/api/config", async (req, res, next) => {
  try {
    config = await saveConfig(req.body.config || req.body, configPath, { currentConfig: config });
    await initLogger({
      directory: resolveLogDirectory(config.repoPath, config.log?.directory),
      level: config.log?.level || "info"
    });
    runner = createRunner(config);
    appendLog("config-saved", { repoPath: config.repoPath, selectedAi: config.ai.selected });
    broadcast("state", { state: runner.state, logs: sessionLogs.slice(-200) });
    res.json({ ok: true, config: maskConfig(config), state: runner.state });
  } catch (error) {
    next(error);
  }
});

app.get("/api/state", (_req, res) => {
  res.json({ ok: true, state: runner.state, logs: sessionLogs.slice(-200) });
});

app.get("/api/audit/refresh", async (_req, res, next) => {
  try {
    res.json(await runner.inspectSnapshot());
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/pick-folder", async (_req, res, next) => {
  try {
    const result = await pickFolder();
    appendLog("folder-picked", { cancelled: result.cancelled, path: result.path || "" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/system/open-file", async (req, res, next) => {
  try {
    const relativePath = String(req.body.path || "");
    const target = pathInsideRepo(config.repoPath, relativePath);
    openLocalFile(target.fullPath);
    appendLog("file-opened", { path: target.relative });
    res.json({ ok: true, path: target.relative });
  } catch (error) {
    next(error);
  }
});

app.get("/api/git/graph", async (_req, res, next) => {
  try {
    const graph = await getGitGraph(config.repoPath);
    res.json(graph);
  } catch (error) {
    next(error);
  }
});

app.get("/api/git/commit/:hash", async (req, res, next) => {
  try {
    const detail = await getCommitDetail(config.repoPath, req.params.hash);
    res.json(detail);
  } catch (error) {
    next(error);
  }
});

app.post("/api/git/file-diff", async (req, res, next) => {
  try {
    const diff = await loadFileDiff({
      repoPath: config.repoPath,
      filePath: req.body.path,
      sectionId: req.body.sectionId
    });
    res.json({ ok: true, ...diff });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/suggest-message", async (req, res, next) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    const { message } = await suggestCommitMessage({ config, paths });
    appendLog("ai-suggest-message", { paths, messageLength: message.length });
    res.json({ ok: true, message });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/audit-review", async (req, res, next) => {
  try {
    const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
    const risks = Array.isArray(req.body.risks) ? req.body.risks : [];
    const diffScope = req.body.diffScope === "combined" ? "combined" : "staged";
    const result = await reviewAuditWithAi({ config, paths, risks, diffScope });
    appendLog("ai-audit-review", { paths: result.paths, reviewLength: result.review.length, diffScope });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/conflict/text/load", async (req, res, next) => {
  try {
    const result = await loadTextConflict({ repoPath: config.repoPath, filePath: req.body.path });
    appendLog("text-conflict-load", { path: req.body.path });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/conflict/text/candidate", async (req, res, next) => {
  try {
    const result = await writeTextCandidate({
      repoPath: config.repoPath,
      filePath: req.body.path,
      content: req.body.content,
      source: req.body.source,
      lineChoices: req.body.lineChoices
    });
    appendLog("text-conflict-candidate", { path: req.body.path, candidate: result.textCandidate?.candidate });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/conflict/table/load", async (req, res, next) => {
  try {
    const result = await loadTableConflict({ repoPath: config.repoPath, filePath: req.body.path });
    appendLog("table-conflict-load", { path: req.body.path, conflicts: result.tableConflict?.merge?.conflictCount || 0 });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/conflict/table/candidate", async (req, res, next) => {
  try {
    const result = await writeTableCandidate({
      repoPath: config.repoPath,
      filePath: req.body.path,
      content: req.body.content,
      source: req.body.source,
      cellChoices: req.body.cellChoices
    });
    appendLog("table-conflict-candidate", { path: req.body.path, candidate: result.tableCandidate?.candidate });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/conflict/binary/load", async (req, res, next) => {
  try {
    const result = await loadBinaryConflict({ repoPath: config.repoPath, filePath: req.body.path });
    appendLog("binary-conflict-load", { path: req.body.path });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/conflict/binary/candidate", async (req, res, next) => {
  try {
    const result = await writeBinaryCandidate({
      repoPath: config.repoPath,
      filePath: req.body.path,
      choice: req.body.choice
    });
    appendLog("binary-conflict-candidate", { path: req.body.path, choice: result.binaryCandidate?.choice, candidate: result.binaryCandidate?.candidate });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/conflict/binary/export", async (req, res, next) => {
  try {
    const result = await exportBinaryConflict({ repoPath: config.repoPath, filePath: req.body.path });
    appendLog("binary-conflict-export", { path: req.body.path, ours: result.binaryConflict?.ours, theirs: result.binaryConflict?.theirs });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/conflict/candidate/apply", async (req, res, next) => {
  try {
    const result = await applyConflictCandidate({
      repoPath: config.repoPath,
      filePath: req.body.path,
      candidatePath: req.body.candidate
    });
    appendLog("conflict-candidate-applied", { path: result.appliedConflict?.path, candidate: result.appliedConflict?.candidate });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/action/:action", async (req, res, next) => {
  try {
    const result = await runner.run(req.params.action, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/git/file-diff-view", async (req, res, next) => {
  try {
    const diff = await loadFileDiff({
      repoPath: config.repoPath,
      filePath: req.query.path,
      sectionId: req.query.sectionId
    });
    res.type("html").send(renderDiffHtml(diff));
  } catch (error) {
    next(error);
  }
});

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

app.use((error, _req, res, _next) => {
  appendLog("error", { message: error.message });
  res.status(500).json({
    ok: false,
    error: error.message,
    audit: error.audit || null
  });
});

  const listenPort = userPort !== undefined ? userPort : (cfg.server.port || 0);
  const server = app.listen(listenPort, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  console.log(`git-safe-commit-tool listening at http://127.0.0.1:${port}`);
  console.log(`repo: ${cfg.repoPath}`);

  const eventServer = new WebSocketServer({ server, path: "/api/events" });
  eventServer.on("connection", (socket) => {
    eventClients.add(socket);
    writeEvent(socket, "state", { state: runner.state, logs: sessionLogs.slice(-200) });
    socket.on("close", () => eventClients.delete(socket));
    socket.on("error", () => eventClients.delete(socket));
  });

  server.once("close", () => { void getLogger()?.close(); });
  return { app, server, port, eventServer };
}

// 保持直接运行 server.mjs 的兼容性（npm start / npm run dev）
const isDirectRun = process.argv[1] && (
  process.argv[1].replace(/\\/g, "/").includes("server.mjs")
  || process.argv[1].replace(/\\/g, "/").includes("server")
);
let directRuntime = null;
if (isDirectRun) directRuntime = await createApp();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}; flushing logs before shutdown`);
  for (const socket of eventClients) socket.terminate();
  if (directRuntime) {
    await new Promise((resolve) => directRuntime.eventServer.close(resolve));
    await new Promise((resolve) => directRuntime.server.close(resolve));
  }
  await getLogger()?.close();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(`shutdown failed: ${error.message}`);
        process.exit(1);
      });
  });
}

function createRunner(nextConfig) {
  return createWorkflowRunner({
    config: nextConfig,
    emit: (event, data) => {
      appendLog(event, data);
      broadcast(event, data);
    }
  });
}

function appendLog(event, data) {
  sessionLogs.push({ time: new Date().toISOString(), event, data });
}

function broadcast(event, data) {
  for (const client of eventClients) {
    try {
      writeEvent(client, event, data);
    } catch {
      eventClients.delete(client);
    }
  }
}

function writeEvent(socket, event, data) {
  if (socket.readyState !== WebSocket.OPEN) {
    eventClients.delete(socket);
    return;
  }
  socket.send(JSON.stringify({ event, data }));
}

function openLocalFile(filePath) {
  if (!filePath || typeof filePath !== "string") throw new Error("file path is required");
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

async function loadFileDiff({ repoPath, filePath, sectionId }) {
  const target = pathInsideRepo(repoPath, String(filePath || ""));
  const normalizedSectionId = String(sectionId || "");
  if (normalizedSectionId === "untracked") {
    const content = await readFile(target.fullPath, "utf8");
    return {
      path: target.relative,
      sectionId: normalizedSectionId,
      command: "read untracked file",
      diff: untrackedDiffPreview(target.relative, content)
    };
  }

  const args = normalizedSectionId === "staged"
    ? ["diff", "--cached", "--", target.relative]
    : ["diff", "--", target.relative];
  const diff = await runGit(repoPath, args);
  if (!diff.ok) throw new Error(diff.stderr || diff.error || `git diff failed for ${target.relative}`);
  return {
    path: target.relative,
    sectionId: normalizedSectionId,
    command: diff.command,
    diff: diff.stdout
  };
}

function untrackedDiffPreview(relativePath, content) {
  const lines = content.split(/\r?\n/);
  const body = lines.map((line) => `+${line}`).join("\n");
  return `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relativePath}\n${body}`;
}

function renderDiffHtml({ path: filePath, sectionId, command, diff }) {
  const lines = String(diff || "").split(/\r?\n/);
  const renderedLines = lines.map((line) => {
    const kind = diffLineKind(line);
    return `<div class="diff-line ${kind}"><span>${htmlEscape(line || " ")}</span></div>`;
  }).join("");
  const stateLabel = sectionId === "staged" ? "已暂存" : sectionId === "untracked" ? "未跟踪" : "未暂存";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(filePath)} - 文件变更</title>
  <style>
    :root { color-scheme: dark; --bg: #07111f; --panel: #0e1a2b; --line: #26374d; --ink: #e5edf7; --muted: #93a4b7; --blue: #67e8f9; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 "Microsoft YaHei", "Segoe UI", system-ui, sans-serif; }
    main { min-height: 100vh; display: grid; grid-template-rows: auto minmax(0, 1fr); }
    header { position: sticky; top: 0; z-index: 1; display: grid; gap: 8px; padding: 16px 18px; border-bottom: 1px solid var(--line); background: rgba(7, 17, 31, .96); }
    h1 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 12px; }
    .pill { border: 1px solid rgba(103, 232, 249, .28); border-radius: 999px; padding: 3px 8px; color: var(--blue); }
    .diff { overflow: auto; margin: 0; padding: 14px 0 24px; background: #0a1423; }
    .diff-line { min-height: 19px; padding: 1px 18px; font: 12px/1.45 Consolas, "Cascadia Mono", "SFMono-Regular", monospace; white-space: pre; }
    .diff-line.header, .diff-line.hunk { color: #93c5fd; background: rgba(37, 99, 235, .16); }
    .diff-line.added { color: #bbf7d0; background: rgba(22, 101, 52, .42); }
    .diff-line.removed { color: #fecaca; background: rgba(127, 29, 29, .42); }
    .empty { margin: 18px; padding: 20px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${htmlEscape(filePath)}</h1>
      <div class="meta">
        <span class="pill">${htmlEscape(stateLabel)}</span>
        <span>${htmlEscape(command || "")}</span>
      </div>
    </header>
    ${diff ? `<section class="diff" aria-label="${htmlEscape(filePath)} diff">${renderedLines}</section>` : `<div class="empty">这个路径当前没有可显示的 diff。</div>`}
  </main>
</body>
</html>`;
}

function diffLineKind(line) {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) return "header";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

function htmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
