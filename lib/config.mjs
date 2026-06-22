import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const Defaults = {
  server: {
    host: "127.0.0.1",
    port: 8080
  },
  ai: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-5.5",
    temperature: 0.1
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
  return {
    ...merged,
    repoPath: path.resolve(String(merged.repoPath)),
    server: {
      host: String(merged.server.host || "127.0.0.1"),
      port: Number(merged.server.port || 8080)
    },
    ai: {
      baseUrl: String(merged.ai.baseUrl || "").replace(/\/+$/, ""),
      apiKey: String(merged.ai.apiKey || ""),
      model: String(merged.ai.model || "gpt-5.5"),
      temperature: Number(merged.ai.temperature ?? 0.1)
    }
  };
}

export function maskConfig(config) {
  return {
    ...config,
    ai: {
      ...config.ai,
      apiKey: maskSecret(config.ai?.apiKey || "")
    }
  };
}

function mergeForSave(existing, update = {}) {
  const sanitized = stripMaskedSecrets(update);
  const next = deepMerge(existing, sanitized);
  if (!sanitized.ai || !Object.hasOwn(sanitized.ai, "apiKey")) {
    next.ai = { ...next.ai, apiKey: existing.ai?.apiKey || "" };
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

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
