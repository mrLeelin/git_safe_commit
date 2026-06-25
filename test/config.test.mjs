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
  assert.equal(config.ai.selected, "codex");
  assert.equal(config.ai.activeProvider, "codex");
  assert.equal(config.ai.providers.codex.baseUrl, "https://example.test/v1");
  assert.equal(config.ai.providers.codex.apiKey, "local-test-secret");
  assert.equal(config.ai.providers.claude.model, "claude-sonnet-4-5");
  assert.deepEqual(config.repositories, [path.resolve(dir)]);
  assert.equal(config.workflow.requireConfirmBeforePush, true);
});

test("loadConfig accepts UTF-8 config files with a byte order mark", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gsc-config-bom-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, `\uFEFF${JSON.stringify({ repoPath: dir })}`, "utf8");

  const config = await loadConfig(configPath);

  assert.equal(config.repoPath, path.resolve(dir));
});

test("saveConfig records unique repositories with the active repo first", async () => {
  const firstRepo = await mkdtemp(path.join(os.tmpdir(), "gsc-repo-first-"));
  const secondRepo = await mkdtemp(path.join(os.tmpdir(), "gsc-repo-second-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "gsc-config-repos-"));
  const configPath = path.join(configDir, "config.json");
  await writeFile(configPath, JSON.stringify({
    repoPath: firstRepo,
    repositories: [firstRepo]
  }), "utf8");

  const saved = await saveConfig({
    repoPath: secondRepo,
    repositories: [firstRepo]
  }, configPath);

  assert.deepEqual(saved.repositories, [path.resolve(secondRepo), path.resolve(firstRepo)]);

  const raw = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(raw.repositories, [path.resolve(secondRepo), path.resolve(firstRepo)]);
});

test("maskConfig never exposes apiKey", () => {
  const masked = maskConfig({
    repoPath: "C:/repo",
    server: { host: "127.0.0.1", port: 19347 },
    ai: {
      activeProvider: "claude",
      baseUrl: "https://example.test/v1",
      apiKey: "local-test-secret",
      model: "model-a",
      temperature: 0.1,
      providers: {
        codex: {
          baseUrl: "https://example.test/v1",
          apiKey: "local-test-secret",
          model: "model-a",
          temperature: 0.1
        },
        claude: {
          baseUrl: "https://claude.example/v1",
          apiKey: "claude-test-secret",
          model: "claude-a",
          temperature: 0.2
        }
      }
    },
    git: {},
    workflow: {}
  });

  assert.equal(masked.ai.apiKey, "loca...cret");
  assert.equal(masked.ai.providers.codex.apiKey, "loca...cret");
  assert.equal(masked.ai.providers.claude.apiKey, "clau...cret");
  assert.equal(JSON.stringify(masked).includes("local-test-secret"), false);
  assert.equal(JSON.stringify(masked).includes("claude-test-secret"), false);
});

test("saveConfig writes config and preserves apiKey when update leaves it blank", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gsc-config-save-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    repoPath: dir,
    ai: {
      activeProvider: "codex",
      baseUrl: "https://old.example/v1",
      apiKey: "local-test-secret",
      model: "model-a",
      providers: {
        codex: {
          baseUrl: "https://old.example/v1",
          apiKey: "local-test-secret",
          model: "model-a"
        },
        claude: {
          baseUrl: "https://old-claude.example/v1",
          apiKey: "claude-test-secret",
          model: "claude-a"
        }
      }
    }
  }), "utf8");

  const saved = await saveConfig({
    repoPath: dir,
    ai: {
      activeProvider: "claude",
      providers: {
        codex: {
          baseUrl: "https://new.example/v1",
          apiKey: "",
          model: "model-b",
          temperature: 0.2
        },
        claude: {
          baseUrl: "https://new-claude.example/v1",
          apiKey: "",
          model: "claude-b",
          temperature: 0.3
        }
      }
    },
    workflow: {
      requireConfirmBeforePush: false
    }
  }, configPath);

  assert.equal(saved.ai.activeProvider, "claude");
  assert.equal(saved.ai.selected, "claude");
  assert.equal(saved.ai.baseUrl, "https://new-claude.example/v1");
  assert.equal(saved.ai.apiKey, "claude-test-secret");
  assert.equal(saved.ai.model, "claude-b");
  assert.equal(saved.ai.providers.codex.apiKey, "local-test-secret");
  assert.equal(saved.ai.providers.claude.apiKey, "claude-test-secret");
  assert.equal(saved.workflow.requireConfirmBeforePush, false);

  const raw = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(raw.ai.providers.codex.apiKey, "local-test-secret");
  assert.equal(raw.ai.providers.claude.apiKey, "claude-test-secret");
});

test("saveConfig preserves selected provider and URLs after masked config round trip", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gsc-config-roundtrip-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    repoPath: dir,
    ai: {
      activeProvider: "codex",
      providers: {
        codex: {
          baseUrl: "https://codex.old/v1",
          apiKey: "codex-test-secret",
          model: "codex-old",
          temperature: 0.1
        },
        claude: {
          baseUrl: "https://claude.old/v1",
          apiKey: "claude-test-secret",
          model: "claude-old",
          temperature: 0.1
        }
      }
    }
  }), "utf8");

  const loaded = await loadConfig(configPath);
  const masked = maskConfig(loaded);
  const saved = await saveConfig({
    repoPath: masked.repoPath,
    ai: {
      activeProvider: "claude",
      providers: {
        codex: {
          baseUrl: "https://codex.new/v1",
          apiKey: "",
          model: "codex-new",
          temperature: 0.2
        },
        claude: {
          baseUrl: "https://claude.new/v1",
          apiKey: "",
          model: "claude-new",
          temperature: 0.3
        }
      }
    }
  }, configPath, { currentConfig: loaded });

  assert.equal(saved.ai.activeProvider, "claude");
  assert.equal(saved.ai.selected, "claude");
  assert.equal(saved.ai.baseUrl, "https://claude.new/v1");
  assert.equal(saved.ai.providers.codex.baseUrl, "https://codex.new/v1");
  assert.equal(saved.ai.providers.claude.baseUrl, "https://claude.new/v1");
  assert.equal(saved.ai.providers.codex.apiKey, "codex-test-secret");
  assert.equal(saved.ai.providers.claude.apiKey, "claude-test-secret");
});

test("loadConfig migrates legacy active Claude fields into Claude provider", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gsc-config-legacy-claude-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    repoPath: dir,
    ai: {
      activeProvider: "claude",
      baseUrl: "https://legacy-claude.example/v1",
      apiKey: "legacy-claude-secret",
      model: "legacy-claude-model",
      temperature: 0.4
    }
  }), "utf8");

  const config = await loadConfig(configPath);

  assert.equal(config.ai.activeProvider, "claude");
  assert.equal(config.ai.selected, "claude");
  assert.equal(config.ai.baseUrl, "https://legacy-claude.example/v1");
  assert.equal(config.ai.apiKey, "legacy-claude-secret");
  assert.equal(config.ai.model, "legacy-claude-model");
  assert.equal(config.ai.temperature, 0.4);
  assert.equal(config.ai.providers.claude.baseUrl, "https://legacy-claude.example/v1");
  assert.equal(config.ai.providers.claude.apiKey, "legacy-claude-secret");
  assert.equal(config.ai.providers.claude.model, "legacy-claude-model");
  assert.equal(config.ai.providers.codex.baseUrl, "https://api.openai.com/v1");
});

test("loadConfig infers Claude provider from legacy Anthropic config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gsc-config-infer-claude-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    repoPath: dir,
    ai: {
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "anthropic-secret",
      model: "claude-sonnet-4-5",
      temperature: 0.1
    }
  }), "utf8");

  const config = await loadConfig(configPath);

  assert.equal(config.ai.activeProvider, "claude");
  assert.equal(config.ai.selected, "claude");
  assert.equal(config.ai.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(config.ai.apiKey, "anthropic-secret");
  assert.equal(config.ai.model, "claude-sonnet-4-5");
  assert.equal(config.ai.providers.claude.baseUrl, "https://api.anthropic.com/v1");
  assert.equal(config.ai.providers.claude.apiKey, "anthropic-secret");
});

test("saveConfig preserves simplified selected AI updates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gsc-config-selected-ai-"));
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({
    repoPath: dir,
    ai: {
      selected: "codex",
      activeProvider: "codex"
    }
  }), "utf8");

  const saved = await saveConfig({
    repoPath: dir,
    ai: {
      selected: "gemini",
      activeProvider: "gemini"
    }
  }, configPath);

  assert.equal(saved.ai.selected, "gemini");
  assert.equal(saved.ai.activeProvider, "gemini");

  const reread = await loadConfig(configPath);
  assert.equal(reread.ai.selected, "gemini");
  assert.equal(reread.ai.activeProvider, "gemini");
});
