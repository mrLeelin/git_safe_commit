import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  Logger,
  currentTraceId,
  generateTraceId,
  getLogger,
  initLogger,
  resolveLogDirectory,
  runWithTraceId
} from "../lib/logger.mjs";

test("generateTraceId returns 8-char hex", () => {
  const id = generateTraceId();
  assert.equal(id.length, 8);
  assert(/^[0-9a-f]{8}$/.test(id));
});

test("Logger writes an info entry to the operations file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "logger-"));
  const logger = new Logger({ directory: dir, level: "debug" });
  logger.info("test-cat", "trace-1", "hello world", { key: "val" });
  await logger.flush();
  const files = await logger.listFiles();
  const opFile = files.find((f) => f.name.startsWith("operations-"));
  assert.ok(opFile, "operations log file should exist");
  const content = await readFile(opFile.path, "utf8");
  assert.ok(content.includes("[INFO]"));
  assert.ok(content.includes("[test-cat]"));
  assert.ok(content.includes("[trace-1]"));
  assert.ok(content.includes("hello world"));
  assert.ok(content.includes("key"));
  assert.ok(content.includes("val"));
  logger.destroy();
});

test("Logger filters out debug entries at info level", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "logger-"));
  const logger = new Logger({ directory: dir, level: "info" });
  logger.debug("test", "t1", "should-not-appear");
  logger.info("test", "t1", "should-appear");
  await logger.flush();
  const files = await logger.listFiles();
  const opFile = files.find((f) => f.name.startsWith("operations-"));
  const content = opFile ? await readFile(opFile.path, "utf8") : "";
  assert.ok(!content.includes("should-not-appear"));
  assert.ok(content.includes("should-appear"));
  logger.destroy();
});

test("Logger writes audit entries to audit.jsonl", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "logger-"));
  const logger = new Logger({ directory: dir });
  logger.audit("commit", "blocked", [{ code: "test-code", severity: "blocked", message: "test message" }]);
  await logger.flush();
  const files = await logger.listFiles();
  const auditFile = files.find((f) => f.name === "audit.jsonl");
  assert.ok(auditFile, "audit.jsonl should exist");
  const content = await readFile(auditFile.path, "utf8");
  const parsed = JSON.parse(content.trim());
  assert.equal(parsed.action, "commit");
  assert.equal(parsed.verdict, "blocked");
  assert.equal(parsed.findingCount, 1);
  assert.equal(parsed.findings[0].code, "test-code");
  logger.destroy();
});

test("Logger writes errors to the errors file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "logger-"));
  const logger = new Logger({ directory: dir, level: "debug" });
  const err = new Error("test-error-message");
  logger.error("test-cat", "t1", "something failed", { attempts: 3 }, err);
  await logger.flush();
  const files = await logger.listFiles();
  const errorFile = files.find((f) => f.name.startsWith("errors-"));
  assert.ok(errorFile, "errors log file should exist");
  const errorContent = await readFile(errorFile.path, "utf8");
  assert.ok(errorContent.includes("test-error-message"));
  assert.ok(errorContent.includes("something failed"));
  logger.destroy();
});

test("Logger lists only files created by the logging subsystem", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "logger-whitelist-"));
  const logger = new Logger({ directory: dir, level: "debug" });
  await writeFile(path.join(dir, "secret-config.json"), "secret", "utf8");
  logger.info("test", "t1", "visible log");
  await logger.flush();

  const files = await logger.listFiles();

  assert.ok(files.some((file) => file.name.startsWith("operations-")));
  assert.ok(!files.some((file) => file.name === "secret-config.json"));
  await logger.close();
});

test("Logger close flushes queued entries before shutdown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "logger-close-"));
  const logger = new Logger({ directory: dir, level: "debug" });
  logger.info("test", "close-trace", "flush before close");

  await logger.close();

  const files = await logger.listFiles();
  const operations = files.find((file) => file.name.startsWith("operations-"));
  assert.ok(operations);
  assert.match(await readFile(operations.path, "utf8"), /flush before close/);
});

test("initLogger flushes the previous instance before replacing it", async () => {
  const firstDir = await mkdtemp(path.join(os.tmpdir(), "logger-first-"));
  const secondDir = await mkdtemp(path.join(os.tmpdir(), "logger-second-"));
  const first = await initLogger({ directory: firstDir, level: "debug" });
  first.info("test", "replace-trace", "written by first logger");

  const second = await initLogger({ directory: secondDir, level: "info" });

  assert.equal(getLogger(), second);
  const firstFile = (await first.listFiles()).find((file) => file.name.startsWith("operations-"));
  assert.ok(firstFile);
  assert.match(await readFile(firstFile.path, "utf8"), /written by first logger/);
  await second.close();
});

test("resolveLogDirectory keeps logging inside the dedicated repository log root", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "logger-repo-"));
  const allowed = path.join(repo, ".git", "git-safe-commit-tool-logs", "session-a");

  assert.equal(resolveLogDirectory(repo, allowed), path.resolve(allowed));
  assert.equal(
    resolveLogDirectory(repo, path.join(repo, "..", "outside")),
    path.join(path.resolve(repo), ".git", "git-safe-commit-tool-logs")
  );
});

test("trace context remains isolated across concurrent asynchronous operations", async () => {
  const seen = await Promise.all([
    runWithTraceId("trace-a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentTraceId();
    }),
    runWithTraceId("trace-b", async () => currentTraceId())
  ]);

  assert.deepEqual(seen, ["trace-a", "trace-b"]);
  assert.equal(currentTraceId(), "");
});

test("Logger flush returns without spinning when the log directory becomes unwritable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "logger-write-failure-"));
  const directory = path.join(root, "logs");
  const logger = new Logger({ directory, level: "debug" });
  await logger.ready();
  await rm(directory, { recursive: true, force: true });
  await writeFile(directory, "not a directory", "utf8");
  logger.info("test", "failure-trace", "must be retained for retry");

  const result = await Promise.race([
    logger.flush().then(() => "flushed"),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100))
  ]);

  assert.equal(result, "flushed");
  logger.destroy();
});

test("Logger caps each managed log file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "logger-size-cap-"));
  const logger = new Logger({ directory, level: "debug", maxFileBytes: 256 });
  for (let index = 0; index < 20; index += 1) {
    logger.info("test", "size-trace", `entry-${index}-${"x".repeat(40)}`);
  }

  await logger.flush();

  const operations = (await logger.listFiles()).find((file) => file.name.startsWith("operations-"));
  assert.ok(operations);
  assert.ok((await stat(operations.path)).size <= 256);
  await logger.close();
});

test("Logger removes stale managed files during initialization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "logger-retention-"));
  const staleFile = path.join(directory, "audit.jsonl");
  await writeFile(staleFile, "stale\n", "utf8");
  await utimes(staleFile, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));

  const logger = new Logger({ directory, retentionDays: 14 });
  await logger.ready();

  assert.ok(!(await logger.listFiles()).some((file) => file.name === "audit.jsonl"));
  await logger.close();
});
