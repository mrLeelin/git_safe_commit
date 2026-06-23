const KNOWN_AI = ["codex", "claude", "gemini"];

export function createDefaultSettingsForm() {
  return {
    repoPath: "",
    selectedAi: "codex",
    requireConfirmBeforePush: true
  };
}

export function fillSettingsFormFromConfig(form, config = {}) {
  form.repoPath = config?.repoPath || "";
  form.selectedAi = normalizeAiId(config?.ai?.selected || config?.ai?.activeProvider);
  form.requireConfirmBeforePush = config?.workflow?.requireConfirmBeforePush ?? true;
  return form;
}

export function buildSettingsPayload(form) {
  const selected = normalizeAiId(form.selectedAi);
  return {
    repoPath: String(form.repoPath || "").trim(),
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
