import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, maskConfig, saveConfig } from "../lib/config.mjs";

test("loadConfig applies defaults and preserves explicit values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gsc-config-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    repoPath: dir,
    ai: {
      baseUrl: "https://example.test/v1",
      apiKey: "local-test-secret",
      model: "model-a"
    }
  }), "utf8");

  const config = await loadConfig(configPath);

  assert.equal(config.repoPath, path.resolve(dir));
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.server.port, 19347);
  assert.equal(config.ai.baseUrl, "https://example.test/v1");
  assert.equal(config.ai.apiKey, "local-test-secret");
  assert.equal(config.ai.model, "model-a");
  assert.equal(config.workflow.requireConfirmBeforePush, true);
});

test("maskConfig never exposes apiKey", () => {
  const masked = maskConfig({
    repoPath: "C:/repo",
    server: { host: "127.0.0.1", port: 19347 },
    ai: {
      baseUrl: "https://example.test/v1",
      apiKey: "local-test-secret",
      model: "model-a",
      temperature: 0.1
    },
    git: {},
    workflow: {}
  });

  assert.equal(masked.ai.apiKey, "loca...cret");
  assert.equal(JSON.stringify(masked).includes("local-test-secret"), false);
});

test("saveConfig writes config and preserves apiKey when update leaves it blank", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gsc-config-save-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    repoPath: dir,
    ai: {
      baseUrl: "https://old.example/v1",
      apiKey: "local-test-secret",
      model: "model-a"
    }
  }), "utf8");

  const saved = await saveConfig({
    repoPath: dir,
    ai: {
      baseUrl: "https://new.example/v1",
      apiKey: "",
      model: "model-b",
      temperature: 0.2
    },
    workflow: {
      requireConfirmBeforePush: false
    }
  }, configPath);

  assert.equal(saved.ai.baseUrl, "https://new.example/v1");
  assert.equal(saved.ai.apiKey, "local-test-secret");
  assert.equal(saved.ai.model, "model-b");
  assert.equal(saved.workflow.requireConfirmBeforePush, false);

  const raw = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(raw.ai.apiKey, "local-test-secret");
});
