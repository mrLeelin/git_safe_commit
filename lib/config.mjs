import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const Defaults = {
  server: {
    host: "127.0.0.1",
    port: 19347
  },
  ai: {
    selected: "codex",
    activeProvider: "codex",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-5.5",
    temperature: 0.1,
    providers: {
      codex: {
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-5.5",
        temperature: 0.1
      },
      claude: {
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "",
        model: "claude-sonnet-4-5",
        temperature: 0.1
      },
      gemini: {
        baseUrl: "",
        apiKey: "",
        model: "gemini",
        temperature: 0.1
      }
    }
  },
  git: {
    mainBranch: "master",
    defaultBranch: "dev",
    autoFetch: true
  },
  workflow: {
    autoCreateRecovery: true,
    requireConfirmBeforePush: true,
    maxAutoResolveAttempts: 2
  }
};

export async function loadConfig(configPath = defaultConfigPath(), options = {}) {
  if (!existsSync(configPath)) {
    if (options.allowMissing) {
      return normalizeConfig({ repoPath: process.cwd() });
    }
    throw new Error(`config file not found: ${configPath}`);
  }

  const raw = JSON.parse(await readFile(configPath, "utf8"));
  return normalizeConfig(raw);
}

export async function saveConfig(update, configPath = defaultConfigPath(), options = {}) {
  const existing = options.currentConfig
    || (existsSync(configPath) ? await loadConfig(configPath) : normalizeConfig({ repoPath: process.cwd() }));
  const merged = normalizeConfig(mergeForSave(existing, update));
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(serializeConfig(merged), null, 2)}\n`, "utf8");
  return merged;
}

export function defaultConfigPath() {
  return process.env.GIT_SAFE_COMMIT_CONFIG
    ? path.resolve(process.env.GIT_SAFE_COMMIT_CONFIG)
    : path.resolve("config.json");
}

export function normalizeConfig(raw) {
  if (!raw?.repoPath) {
    throw new Error("repoPath is required");
  }

  const merged = deepMerge(Defaults, raw);
  const ai = normalizeAiConfig(merged.ai, raw.ai || {});
  return {
    ...merged,
    repoPath: path.resolve(String(merged.repoPath)),
    server: {
      host: String(merged.server.host || "127.0.0.1"),
      port: Number(merged.server.port || 19347)
    },
    ai
  };
}

export function maskConfig(config) {
  return {
    ...config,
    ai: {
      ...config.ai,
      apiKey: maskSecret(config.ai?.apiKey || ""),
      providers: Object.fromEntries(Object.entries(config.ai?.providers || {}).map(([name, provider]) => [
        name,
        { ...provider, apiKey: maskSecret(provider?.apiKey || "") }
      ]))
    }
  };
}

function mergeForSave(existing, update = {}) {
  const sanitized = stripMaskedSecrets(update);
  const next = deepMerge(existing, sanitized);
  if (sanitized.ai?.selected && !sanitized.ai?.activeProvider) {
    next.ai.activeProvider = sanitized.ai.selected;
  }
  if (sanitized.ai?.activeProvider && !sanitized.ai?.selected) {
    next.ai.selected = sanitized.ai.activeProvider;
  }
  if (!sanitized.ai || !Object.hasOwn(sanitized.ai, "apiKey")) {
    next.ai = { ...next.ai, apiKey: existing.ai?.apiKey || "" };
  }
  for (const name of ["codex", "claude", "gemini"]) {
    if (!sanitized.ai?.providers?.[name] || !Object.hasOwn(sanitized.ai.providers[name], "apiKey")) {
      next.ai.providers = next.ai.providers || {};
      next.ai.providers[name] = {
        ...(next.ai.providers[name] || {}),
        apiKey: existing.ai?.providers?.[name]?.apiKey || ""
      };
    }
  }
  return next;
}

function stripMaskedSecrets(update) {
  const next = deepMerge({}, update || {});
  if (next.ai && typeof next.ai.apiKey === "string") {
    const value = next.ai.apiKey.trim();
    if (!value || value.includes("...") || value === "***") {
      delete next.ai.apiKey;
    } else {
      next.ai.apiKey = value;
    }
  }
  for (const provider of Object.values(next.ai?.providers || {})) {
    if (typeof provider.apiKey !== "string") continue;
    const value = provider.apiKey.trim();
    if (!value || value.includes("...") || value === "***") {
      delete provider.apiKey;
    } else {
      provider.apiKey = value;
    }
  }
  return next;
}

function serializeConfig(config) {
  return {
    repoPath: config.repoPath,
    server: config.server,
    ai: config.ai,
    git: config.git,
    workflow: config.workflow
  };
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (isPlainObject(value) && isPlainObject(base[key])) {
      result[key] = deepMerge(base[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function normalizeAiConfig(ai = {}, rawAi = {}) {
  const selected = resolveSelectedAi(ai, rawAi);
  const activeProvider = selected;
  const legacyActiveProvider = {
    baseUrl: ai.baseUrl,
    apiKey: ai.apiKey,
    model: ai.model,
    temperature: ai.temperature
  };
  const rawProviders = rawAi.providers || {};
  const providers = {
    codex: normalizeProvider(providerSource(ai, rawProviders, "codex", activeProvider, legacyActiveProvider), Defaults.ai.providers.codex),
    claude: normalizeProvider(providerSource(ai, rawProviders, "claude", activeProvider, legacyActiveProvider), Defaults.ai.providers.claude),
    gemini: normalizeProvider(providerSource(ai, rawProviders, "gemini", activeProvider, legacyActiveProvider), Defaults.ai.providers.gemini)
  };
  const active = providers[activeProvider];
  return {
    selected,
    activeProvider,
    baseUrl: active.baseUrl,
    apiKey: active.apiKey,
    model: active.model,
    temperature: active.temperature,
    providers
  };
}

function resolveSelectedAi(ai, rawAi = {}) {
  if (["codex", "claude", "gemini"].includes(rawAi.selected)) return rawAi.selected;
  if (["codex", "claude", "gemini"].includes(rawAi.activeProvider)) return rawAi.activeProvider;
  const legacyText = `${rawAi.baseUrl || ""} ${rawAi.model || ""}`.toLowerCase();
  if (legacyText.includes("anthropic") || legacyText.includes("claude")) return "claude";
  if (legacyText.includes("gemini")) return "gemini";
  if (["codex", "claude", "gemini"].includes(ai.selected)) return ai.selected;
  if (["codex", "claude", "gemini"].includes(ai.activeProvider)) return ai.activeProvider;
  return "codex";
}

function providerSource(ai, rawProviders, providerName, activeProvider, legacyActiveProvider) {
  if (hasProviderValues(rawProviders?.[providerName])) {
    return ai.providers?.[providerName] || {};
  }
  if (activeProvider === providerName && hasProviderValues(legacyActiveProvider)) {
    return legacyActiveProvider;
  }
  if (!rawProviders || Object.keys(rawProviders).length === 0) {
    return {};
  }
  return ai.providers?.[providerName] || {};
}

function normalizeProvider(provider, fallback) {
  return {
    baseUrl: String(provider.baseUrl || fallback.baseUrl || "").replace(/\/+$/, ""),
    apiKey: String(provider.apiKey || ""),
    model: String(provider.model || fallback.model || ""),
    temperature: Number(provider.temperature ?? fallback.temperature ?? 0.1)
  };
}

function hasProviderValues(provider) {
  return Boolean(provider && (
    provider.baseUrl
    || provider.apiKey
    || provider.model
    || provider.temperature !== undefined
  ));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
