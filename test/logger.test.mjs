import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Logger, generateTraceId } from "../lib/logger.mjs";

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
