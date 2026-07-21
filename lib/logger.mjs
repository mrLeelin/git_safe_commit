import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, audit: 4 };
const LogFilePattern = /^(?:operations|errors)-\d{4}-\d{2}-\d{2}\.log$|^audit\.jsonl$/;
const DefaultMaxFileBytes = 10 * 1024 * 1024;
const DefaultRetentionDays = 14;
const traceContext = new AsyncLocalStorage();

let _instance = null;

export async function initLogger(options = {}) {
  const previous = _instance;
  const next = new Logger(options);
  await next.ready();
  _instance = next;
  if (previous && previous !== next) await previous.close();
  return next;
}

export function getLogger() {
  return _instance;
}

export function generateTraceId() {
  return crypto.randomUUID().slice(0, 8);
}

export function runWithTraceId(traceId, callback) {
  return traceContext.run({ traceId: String(traceId || "") }, callback);
}

export function currentTraceId() {
  return traceContext.getStore()?.traceId || "";
}

export function resolveLogDirectory(repoPath, configuredDirectory = "", portableLogRoot = process.env.GIT_SAFE_COMMIT_LOG_ROOT) {
  portableLogRoot = String(portableLogRoot || "").trim();
  if (portableLogRoot) return path.join(path.resolve(portableLogRoot), projectLogName(repoPath));

  const root = path.resolve(String(repoPath), ".git", "git-safe-commit-tool-logs");
  if (!configuredDirectory) return root;
  const candidate = path.resolve(String(configuredDirectory));
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? candidate : root;
}

function projectLogName(repoPath) {
  const name = path.basename(path.resolve(String(repoPath)))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return name || "project";
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

function oneLine(value) {
  return String(value ?? "").replace(/[\r\n\u0000-\u001f\u007f]+/g, " ").trim();
}

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return String(item);
      if (item instanceof Error) return { name: item.name, message: item.message };
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });
  } catch {
    return "[Unserializable]";
  }
}

function formatEntry(level, category, traceId, message) {
  return `${nowISO()} [${level.toUpperCase()}] [${oneLine(category)}] [${oneLine(traceId) || "-"}] ${oneLine(message)}`;
}

export class Logger {
  #directory;
  #levelRank;
  #queue = [];
  #flushTimer = null;
  #flushPromise = null;
  #readyPromise;
  #accepting = true;
  #maxFileBytes;
  #retentionMs;

  constructor({ directory, level = "info", maxFileBytes = DefaultMaxFileBytes, retentionDays = DefaultRetentionDays } = {}) {
    this.#directory = path.resolve(directory || path.join(process.cwd(), ".git", "git-safe-commit-tool-logs"));
    this.#levelRank = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.#maxFileBytes = Math.max(1, Number(maxFileBytes) || DefaultMaxFileBytes);
    this.#retentionMs = Math.max(1, Number(retentionDays) || DefaultRetentionDays) * 24 * 60 * 60 * 1000;
    this.#readyPromise = mkdir(this.#directory, { recursive: true }).then(() => this.#removeStaleFiles());
    this.#flushTimer = setInterval(() => { void this.flush(); }, 2000);
    this.#flushTimer.unref();
  }

  async ready() {
    await this.#readyPromise;
  }

  #fileName(level, date) {
    if (level === "audit") return "audit.jsonl";
    if (level === "error") return `errors-${date}.log`;
    return `operations-${date}.log`;
  }

  async #removeStaleFiles() {
    const cutoff = Date.now() - this.#retentionMs;
    const files = await readdir(this.#directory, { withFileTypes: true });
    await Promise.all(files
      .filter((file) => file.isFile() && LogFilePattern.test(file.name))
      .map(async (file) => {
        const filePath = path.join(this.#directory, file.name);
        const metadata = await stat(filePath);
        if (metadata.mtimeMs < cutoff) await rm(filePath, { force: true });
      }));
  }

  async #appendWithinLimit(filePath, lines) {
    let existingSize = 0;
    try {
      existingSize = (await stat(filePath)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let remaining = this.#maxFileBytes - existingSize;
    if (remaining <= 0) return;
    const accepted = [];
    for (const line of lines) {
      const bytes = Buffer.byteLength(`${line}\n`, "utf8");
      if (bytes > remaining) break;
      accepted.push(line);
      remaining -= bytes;
    }
    if (accepted.length) await appendFile(filePath, `${accepted.join("\n")}\n`, "utf8");
  }

  async #drain() {
    await this.ready();
    while (this.#queue.length) {
      const batch = this.#queue.splice(0);
      try {
        const groups = new Map();
        for (const entry of batch) {
          const fileName = this.#fileName(entry.level, entry.date);
          groups.set(fileName, [...(groups.get(fileName) || []), entry.line]);
        }
        for (const [fileName, lines] of groups) {
          await this.#appendWithinLimit(path.join(this.#directory, fileName), lines);
        }
      } catch {
        this.#queue.unshift(...batch);
        return false;
      }
    }
    return true;
  }

  #write(level, category, traceId, message, extra = null) {
    if (!this.#accepting) return;
    if (LOG_LEVELS[level] == null || LOG_LEVELS[level] < this.#levelRank) return;
    const resolvedTraceId = traceId || currentTraceId();
    const serialized = extra == null ? "" : ` ${safeStringify(extra)}`;
    const line = `${formatEntry(level, category, resolvedTraceId, message)}${serialized}`;
    this.#queue.push({ level, line, date: todayUTC() });
    if (level === "error" || level === "audit") setImmediate(() => { void this.flush(); });
  }

  debug(category, traceId, message, extra) { this.#write("debug", category, traceId, message, extra); }
  info(category, traceId, message, extra) { this.#write("info", category, traceId, message, extra); }
  warn(category, traceId, message, extra) { this.#write("warn", category, traceId, message, extra); }
  error(category, traceId, message, extra, err) {
    const stack = err?.stack?.split("\n").slice(0, 6).join(" | ") || "";
    const errorExtra = { ...(extra || {}), ...(err ? { errorMessage: err.message, stack } : {}) };
    this.#write("error", category, traceId, message, errorExtra);
  }

  audit(action, verdict, findings = [], traceId = "") {
    if (!this.#accepting) return;
    const safeFindings = (findings || []).filter(Boolean).map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: oneLine(finding.message)
    }));
    const line = safeStringify({
      time: nowISO(),
      traceId: traceId || currentTraceId() || "",
      action,
      verdict,
      findingCount: safeFindings.length,
      findings: safeFindings
    });
    this.#queue.push({ level: "audit", line, date: todayUTC() });
    setImmediate(() => { void this.flush(); });
  }

  async flush() {
    if (!this.#flushPromise) {
      this.#flushPromise = this.#drain().finally(() => { this.#flushPromise = null; });
    }
    const drained = await this.#flushPromise;
    if (drained && this.#queue.length) await this.flush();
  }

  async close() {
    this.#accepting = false;
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    this.#flushTimer = null;
    await this.flush();
  }

  destroy() {
    void this.close();
  }

  get directory() { return this.#directory; }

  async listFiles() {
    await this.ready();
    const files = await readdir(this.#directory, { withFileTypes: true });
    return files
      .filter((file) => file.isFile() && LogFilePattern.test(file.name))
      .map((file) => ({ name: file.name, path: path.join(this.#directory, file.name) }));
  }
}
