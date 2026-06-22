import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("server exposes health, config, and inspect action", async () => {
  const repo = await createRepo();
  const temp = await mkdtemp(path.join(os.tmpdir(), "gsc-config-"));
  const configPath = path.join(temp, "config.json");
  const port = 18080 + Math.floor(Math.random() * 1000);
  await writeFile(configPath, JSON.stringify({
    repoPath: repo,
    server: { host: "127.0.0.1", port },
    ai: {
      baseUrl: "https://example.test/v1",
      apiKey: "local-test-secret",
      model: "model-a"
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

    const configResponse = await fetch(`${baseUrl}/api/config`);
    const config = await configResponse.json();
    assert.equal(config.ok, true);
    assert.equal(JSON.stringify(config).includes("local-test-secret"), false);

    const saveResponse = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config: {
          repoPath: repo,
          ai: {
            baseUrl: "https://updated.example/v1",
            model: "model-b",
            apiKey: ""
          }
        }
      })
    });
    const saved = await saveResponse.json();
    assert.equal(saved.ok, true);
    assert.equal(saved.config.ai.baseUrl, "https://updated.example/v1");
    assert.equal(saved.config.ai.model, "model-b");
    assert.equal(JSON.stringify(saved).includes("local-test-secret"), false);

    const inspectResponse = await fetch(`${baseUrl}/api/action/inspect`, { method: "POST" });
    const inspect = await inspectResponse.json();
    assert.equal(inspect.ok, true);
    assert.equal(inspect.summary.branch, "main");
  } finally {
    child.kill();
  }
});
