import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createRepo(prefix = "gsc-server-") {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("server did not become healthy");
}

async function readEventMessage(url) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("websocket event did not arrive"));
    }, 3000);
    socket.on("message", (message) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(message.toString()));
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("server exposes health, config, and inspect action", async () => {
  const repo = await createRepo();
  const temp = await mkdtemp(path.join(os.tmpdir(), "gsc-config-"));
  const configPath = path.join(temp, "config.json");
  const port = 19347 + Math.floor(Math.random() * 1000);
  await writeFile(configPath, JSON.stringify({
    repoPath: repo,
    server: { host: "127.0.0.1", port },
    ai: {
      activeProvider: "codex",
      baseUrl: "https://example.test/v1",
      apiKey: "local-test-secret",
      model: "model-a",
      providers: {
        codex: {
          baseUrl: "https://example.test/v1",
          apiKey: "local-test-secret",
          model: "model-a"
        },
        claude: {
          baseUrl: "https://claude.example/v1",
          apiKey: "claude-test-secret",
          model: "claude-a"
        }
      }
    }
  }), "utf8");

  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      GIT_SAFE_COMMIT_CONFIG: configPath
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(baseUrl);
    assert.equal(health.ok, true);
    assert.equal(health.repoPath, repo);

    const eventMessage = await readEventMessage(`ws://127.0.0.1:${port}/api/events`);
    assert.equal(eventMessage.event, "state");
    assert.equal(eventMessage.data.state.phase, "Idle");
    assert.ok(Array.isArray(eventMessage.data.logs));

    const pageResponse = await fetch(`${baseUrl}/`);
    const page = await pageResponse.text();
    assert.equal(pageResponse.status, 200);
    assert.match(page, /<div id="app"><\/div>/);
    assert.doesNotMatch(page, /\/public\/app\.mjs/);

    const configResponse = await fetch(`${baseUrl}/api/config`);
    const config = await configResponse.json();
    assert.equal(config.ok, true);
    assert.equal(config.config.ai.selected, "codex");
    assert.equal(JSON.stringify(config).includes("local-test-secret"), false);
    assert.equal(JSON.stringify(config).includes("claude-test-secret"), false);

    const installationsResponse = await fetch(`${baseUrl}/api/ai/installations`);
    const installations = await installationsResponse.json();
    assert.equal(installations.ok, true);
    assert.equal(installations.selected, "codex");
    assert.ok(Array.isArray(installations.installations));

    const saveResponse = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          repoPath: repo,
          ai: {
            selected: "claude",
            activeProvider: "claude"
          }
        }
      })
    });
    const saved = await saveResponse.json();
    assert.equal(saved.ok, true);
    assert.equal(saved.config.ai.selected, "claude");
    assert.equal(saved.config.ai.activeProvider, "claude");
    assert.equal(saved.config.ai.baseUrl, "https://claude.example/v1");
    assert.equal(saved.config.ai.model, "claude-a");
    assert.equal(saved.config.ai.providers.claude.baseUrl, "https://claude.example/v1");
    assert.equal(JSON.stringify(saved).includes("local-test-secret"), false);
    assert.equal(JSON.stringify(saved).includes("claude-test-secret"), false);

    const rereadResponse = await fetch(`${baseUrl}/api/config`);
    const reread = await rereadResponse.json();
    assert.equal(reread.config.ai.selected, "claude");
    assert.equal(reread.config.ai.activeProvider, "claude");
    assert.equal(reread.config.ai.baseUrl, "https://claude.example/v1");
    assert.equal(reread.config.ai.providers.claude.baseUrl, "https://claude.example/v1");

    const inspectResponse = await fetch(`${baseUrl}/api/action/inspect`, { method: "POST" });
    const inspect = await inspectResponse.json();
    assert.equal(inspect.ok, true);
    assert.equal(inspect.summary.branch, "main");

    const graphResponse = await fetch(`${baseUrl}/api/git/graph`);
    const graph = await graphResponse.json();
    assert.equal(graph.ok, true);
    assert.ok(Array.isArray(graph.graph));
    assert.match(graph.graph.join("\n"), /initial/);
    assert.match(graph.command, /--topo-order/);

    const suggestResponse = await fetch(`${baseUrl}/api/ai/suggest-message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths: ["tracked.txt"] })
    });
    const suggestText = await suggestResponse.text();
    assert.match(suggestResponse.headers.get("content-type") || "", /application\/json/);
    assert.doesNotThrow(() => JSON.parse(suggestText));

    const localCandidate = path.join(repo, ".git", "git-safe-commit-backups", "candidate.txt");
    await mkdir(path.dirname(localCandidate), { recursive: true });
    await writeFile(localCandidate, "candidate\n", "utf8");
    const openResponse = await fetch(`${baseUrl}/api/system/open-file`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ".git/git-safe-commit-backups/candidate.txt" })
    });
    const opened = await openResponse.json();
    assert.equal(opened.ok, true);
    assert.equal(opened.path, ".git/git-safe-commit-backups/candidate.txt");

    const healthAfterInspect = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthAfterInspect.status, 200);
  } finally {
    child.kill();
  }
});
