const KNOWN_AI = ["codex", "claude", "gemini"];

export function createDefaultSettingsForm() {
  return {
    repoPath: "",
    repositories: [],
    selectedAi: "codex",
    requireConfirmBeforePush: true
  };
}

export function fillSettingsFormFromConfig(form, config = {}) {
  form.repoPath = config?.repoPath || "";
  form.repositories = normalizeRepositories(config?.repoPath, config?.repositories);
  form.selectedAi = normalizeAiId(config?.ai?.selected || config?.ai?.activeProvider);
  form.requireConfirmBeforePush = config?.workflow?.requireConfirmBeforePush ?? true;
  return form;
}

export function buildSettingsPayload(form) {
  const selected = normalizeAiId(form.selectedAi);
  const repoPath = String(form.repoPath || "").trim();
  return {
    repoPath,
    repositories: normalizeRepositories(repoPath, form.repositories),
    ai: {
      selected,
      activeProvider: selected
    },
    workflow: {
      requireConfirmBeforePush: Boolean(form.requireConfirmBeforePush)
    }
  };
}

export function hasConfiguredAiKey(config = {}) {
  return Boolean(config?.ai?.selected || config?.ai?.activeProvider);
}

function normalizeAiId(value) {
  return KNOWN_AI.includes(value) ? value : "codex";
}

function normalizeRepositories(activeRepoPath, repositories = []) {
  const active = String(activeRepoPath || "").trim();
  const seen = new Set();
  const result = [];
  for (const repo of [active, ...repositories]) {
    const value = String(repo || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
