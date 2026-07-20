import { appendFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3, audit: 4 };

let _instance = null;

export function initLogger(options = {}) {
  _instance = new Logger(options);
  return _instance;
}

export function getLogger() {
  return _instance;
}

export function generateTraceId() {
  return crypto.randomUUID().slice(0, 8);
}

function today() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nowISO() {
  return new Date().toISOString();
}

function formatEntry(level, category, traceId, message) {
  return `${nowISO()} [${level.toUpperCase()}] [${category}] [${traceId || "-"}] ${message}`;
}

export class Logger {
  #directory;
  #levelRank;
  #queue = [];
  #flushTimer = null;
  #flushing = false;

  constructor({ directory, level = "info" } = {}) {
    this.#directory = directory || path.join(process.cwd(), ".git", "git-safe-commit-tool-logs");
    this.#levelRank = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    this.#ensureDir();
    this.#startFlushTimer();
  }

  #ensureDir() {
    if (!existsSync(this.#directory)) {
      mkdir(this.#directory, { recursive: true }).catch(() => {});
    }
  }

  #startFlushTimer() {
    this.#flushTimer = setInterval(() => this.#flush(), 2000);
    this.#flushTimer.unref();
  }

  async #flush() {
    if (this.#flushing || !this.#queue.length) return;
    this.#flushing = true;
    const batch = this.#queue.splice(0);
    try {
      const date = today();
      for (const entry of batch) {
        const filePath = path.join(this.#directory, this.#fileName(entry.level, date));
        await appendFile(filePath, entry.line + "\n", "utf8");
      }
    } catch {
      // 静默失败 — 日志不应影响主流程
    } finally {
      this.#flushing = false;
    }
  }

  #fileName(level, date) {
    if (level === "audit") return "audit.jsonl";
    if (level === "error") return `errors-${date}.log`;
    if (level === "debug" || level === "info" || level === "warn") return `operations-${date}.log`;
    return `operations-${date}.log`;
  }

  #write(level, category, traceId, message, extra = null) {
    if (LOG_LEVELS[level] == null || LOG_LEVELS[level] < this.#levelRank) return;
    const line = extra != null
      ? `${formatEntry(level, category, traceId, message)} ${JSON.stringify(extra)}`
      : `${formatEntry(level, category, traceId, message)}`;
    this.#queue.push({ level, line });
    if (level === "error" || level === "audit") {
      setImmediate(() => this.#flush());
    }
  }

  debug(category, traceId, message, extra) { this.#write("debug", category, traceId, message, extra); }
  info(category, traceId, message, extra) { this.#write("info", category, traceId, message, extra); }
  warn(category, traceId, message, extra) { this.#write("warn", category, traceId, message, extra); }
  error(category, traceId, message, extra, err) {
    const stack = err?.stack?.split("\n").slice(0, 6).join("\n") || "";
    const errorExtra = { ...(extra || {}), ...(err ? { errorMessage: err.message, stack } : {}) };
    this.#write("error", category, traceId, message, errorExtra);
  }

  audit(action, verdict, findings = []) {
    const safeFindings = (findings || []).filter((f) => f).map((f) => ({ code: f.code, severity: f.severity, message: f.message }));
    const line = JSON.stringify({
      time: nowISO(),
      action,
      verdict,
      findingCount: safeFindings.length,
      findings: safeFindings
    });
    this.#queue.push({ level: "audit", line });
    setImmediate(() => this.#flush());
  }

  async flush() {
    await this.#flush();
  }

  get directory() { return this.#directory; }

  destroy() {
    if (this.#flushTimer) clearInterval(this.#flushTimer);
    this.#flushTimer = null;
  }

  async listFiles() {
    try {
      const files = await readdir(this.#directory, { withFileTypes: true });
      return files.filter((f) => f.isFile()).map((f) => ({ name: f.name, path: path.join(this.#directory, f.name) }));
    } catch {
      return [];
    }
  }
}
