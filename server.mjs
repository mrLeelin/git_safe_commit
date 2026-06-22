import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultConfigPath, loadConfig, maskConfig, saveConfig } from "./lib/config.mjs";
import { createWorkflowRunner } from "./lib/workflow-runner.mjs";

const __filename = fileURLToPath(import.meta.url);
const toolRoot = path.dirname(__filename);
const publicDir = path.join(toolRoot, "public");
const configPath = defaultConfigPath();
let config = await loadConfig(configPath, { allowMissing: true });
const eventClients = new Set();
const sessionLogs = [];

let runner = createRunner(config);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${config.server.host}:${config.server.port}`);
    if (req.method === "OPTIONS") {
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      await sendAsset(res, "index.html");
      return;
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      await sendAsset(res, url.pathname.slice("/public/".length));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      json(res, 200, { ok: true, tool: "git-safe-commit-tool", repoPath: config.repoPath });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      json(res, 200, { ok: true, config: maskConfig(config) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJson(req);
      config = await saveConfig(body.config || body, configPath, { currentConfig: config });
      runner = createRunner(config);
      appendLog("config-saved", { repoPath: config.repoPath, aiBaseUrl: config.ai.baseUrl, model: config.ai.model });
      broadcast("state", { state: runner.state, logs: sessionLogs.slice(-200) });
      json(res, 200, { ok: true, config: maskConfig(config), state: runner.state });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      json(res, 200, { ok: true, state: runner.state, logs: sessionLogs.slice(-200) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      openEventStream(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/action/")) {
      const action = url.pathname.slice("/api/action/".length);
      const body = await readJson(req);
      const result = await runner.run(action, body);
      json(res, 200, result);
      return;
    }

    json(res, 404, { ok: false, error: `not found: ${url.pathname}` });
  } catch (error) {
    appendLog("error", { message: error.message });
    json(res, 500, { ok: false, error: error.message });
  }
});

server.listen(config.server.port, config.server.host, () => {
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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function sendAsset(res, relativeAsset) {
  if (relativeAsset.includes("..") || path.isAbsolute(relativeAsset)) {
    json(res, 404, { ok: false, error: "not found" });
    return;
  }
  const fullPath = path.join(publicDir, relativeAsset);
  const extension = path.extname(relativeAsset);
  const contentType = extension === ".css"
    ? "text/css; charset=utf-8"
    : extension === ".mjs" || extension === ".js"
      ? "text/javascript; charset=utf-8"
      : extension === ".html"
        ? "text/html; charset=utf-8"
        : "application/octet-stream";
  res.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
  res.end(await readFile(fullPath));
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body, null, 2));
}

function openEventStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    "connection": "keep-alive",
    "access-control-allow-origin": "*"
  });
  eventClients.add(res);
  writeEvent(res, "state", { state: runner.state, logs: sessionLogs.slice(-200) });
  req.on("close", () => eventClients.delete(res));
}

function appendLog(event, data) {
  sessionLogs.push({
    time: new Date().toISOString(),
    event,
    data
  });
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
