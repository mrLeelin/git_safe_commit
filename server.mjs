import express from "express";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import { detectInstalledAi } from "./lib/ai-installations.mjs";
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
import { pathInsideRepo } from "./lib/git-executor.mjs";
import { getGitGraph, getCommitDetail } from "./lib/git-graph.mjs";
import { createWorkflowRunner } from "./lib/workflow-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const toolRoot = path.dirname(__filename);
const configPath = defaultConfigPath();
let config = await loadConfig(configPath, { allowMissing: true });
const eventClients = new Set();
const sessionLogs = [];
let runner = createRunner(config);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, tool: "git-safe-commit-tool", repoPath: config.repoPath });
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

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(toolRoot, "dist")));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(toolRoot, "dist", "index.html")));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({ root: toolRoot, server: { middlewareMode: true }, appType: "spa" });
  app.use(vite.middlewares);
}

app.use((error, _req, res, _next) => {
  appendLog("error", { message: error.message });
  res.status(500).json({ ok: false, error: error.message });
});

const server = app.listen(config.server.port, config.server.host, () => {
  const url = `http://${config.server.host}:${config.server.port}`;
  console.log(`git-safe-commit-tool listening at ${url}`);
  console.log(`repo: ${config.repoPath}`);
});
const eventServer = new WebSocketServer({ server, path: "/api/events" });
eventServer.on("connection", (socket) => {
  eventClients.add(socket);
  writeEvent(socket, "state", { state: runner.state, logs: sessionLogs.slice(-200) });
  socket.on("close", () => eventClients.delete(socket));
  socket.on("error", () => eventClients.delete(socket));
});

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
