import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSettingsPayload,
  createDefaultSettingsForm,
  fillSettingsFormFromConfig,
  hasConfiguredAiKey
} from "../src/settings-model.js";

test("settings form fills selected AI from saved config", () => {
  const form = createDefaultSettingsForm();

  fillSettingsFormFromConfig(form, {
    repoPath: "C:/repo",
    ai: { selected: "claude", activeProvider: "codex" },
    workflow: { requireConfirmBeforePush: false }
  });

  assert.equal(form.repoPath, "C:/repo");
  assert.deepEqual(form.repositories, ["C:/repo"]);
  assert.equal(form.selectedAi, "claude");
  assert.equal(form.requireConfirmBeforePush, false);
});

test("settings form exposes saved repositories for quick switching", () => {
  const form = createDefaultSettingsForm();

  fillSettingsFormFromConfig(form, {
    repoPath: "C:/active",
    repositories: ["C:/old", "C:/active", "C:/old"]
  });

  assert.deepEqual(form.repositories, ["C:/active", "C:/old"]);
});

test("settings form maps legacy active provider into selected AI", () => {
  const form = createDefaultSettingsForm();

  fillSettingsFormFromConfig(form, {
    repoPath: "C:/repo",
    ai: { activeProvider: "gemini" },
    workflow: { requireConfirmBeforePush: true }
  });

  assert.equal(form.selectedAi, "gemini");
  assert.equal(form.requireConfirmBeforePush, true);
});

test("settings payload only saves selected AI and workflow fields", () => {
  const form = createDefaultSettingsForm();
  form.repoPath = " C:/repo ";
  form.selectedAi = "claude";
  form.requireConfirmBeforePush = false;

  const payload = buildSettingsPayload(form);

  assert.deepEqual(payload, {
    repoPath: "C:/repo",
    repositories: ["C:/repo"],
    ai: {
      selected: "claude",
      activeProvider: "claude"
    },
    workflow: {
      requireConfirmBeforePush: false
    }
  });
  assert.equal(Object.hasOwn(payload.ai, "providers"), false);
  assert.equal(Object.hasOwn(payload.ai, "baseUrl"), false);
  assert.equal(Object.hasOwn(payload.ai, "model"), false);
  assert.equal(Object.hasOwn(payload.ai, "temperature"), false);
  assert.equal(Object.hasOwn(payload.ai, "apiKey"), false);
});

test("invalid AI values fall back to Codex", () => {
  const form = createDefaultSettingsForm();

  fillSettingsFormFromConfig(form, {
    repoPath: "C:/repo",
    ai: { selected: "cursor" }
  });

  assert.equal(form.selectedAi, "codex");
  form.selectedAi = "unknown";
  assert.equal(buildSettingsPayload(form).ai.selected, "codex");
});

test("hasConfiguredAiKey treats selected AI as readiness for the simplified UI", () => {
  assert.equal(hasConfiguredAiKey(null), false);
  assert.equal(hasConfiguredAiKey(undefined), false);
  assert.equal(hasConfiguredAiKey({ ai: {} }), false);
  assert.equal(hasConfiguredAiKey({ ai: { selected: "codex" } }), true);
  assert.equal(hasConfiguredAiKey({ ai: { activeProvider: "claude" } }), true);
});
