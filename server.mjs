import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectInstalledAi } from "./lib/ai-installations.mjs";
import { suggestCommitMessage } from "./lib/commit-message-suggester.mjs";
import { defaultConfigPath, loadConfig, maskConfig, saveConfig } from "./lib/config.mjs";
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

app.get("/api/events", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
    "access-control-allow-origin": "*"
  });
  eventClients.add(res);
  writeEvent(res, "state", { state: runner.state, logs: sessionLogs.slice(-200) });
  req.on("close", () => eventClients.delete(res));
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

app.listen(config.server.port, config.server.host, () => {
  const url = `http://${config.server.host}:${config.server.port}`;
  console.log(`git-safe-commit-tool listening at ${url}`);
  console.log(`repo: ${config.repoPath}`);
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

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
