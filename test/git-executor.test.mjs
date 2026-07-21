import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { normalizeGitArgs, runGit, runProcess, summarizeGitInvocation, validateGitArgs, validateRepoPath } from "../lib/git-executor.mjs";
import { initLogger, runWithTraceId } from "../lib/logger.mjs";

test("validateGitArgs rejects destructive git commands", () => {
  const forbidden = [
    ["pull"],
    ["reset", "--hard"],
    ["clean", "-fd"],
    ["push", "--force"],
    ["push", "-f"],
    ["stash", "pop"]
  ];

  for (const args of forbidden) {
    assert.throws(() => validateGitArgs(args), /forbidden/i, args.join(" "));
  }
});

test("validateGitArgs accepts allowlisted commands", () => {
  const allowed = [
    ["status", "--short", "--branch"],
    ["fetch", "--prune"],
    ["rebase", "@{u}"],
    ["rebase", "--continue"],
    ["rebase", "--abort"],
    ["push"],
    ["add", "--", "file.txt"],
    ["check-ignore", "--", "file.txt"],
    ["commit", "-m", "Update file"],
    ["stash", "apply", "--index", "stash@{0}"]
  ];

  for (const args of allowed) {
    assert.deepEqual(validateGitArgs(args), args, args.join(" "));
  }
});

test("normalizeGitArgs rejects shell-like input", () => {
  assert.throws(() => normalizeGitArgs("status && git clean -fd"), /array/i);
  assert.deepEqual(normalizeGitArgs(["status"]), ["status"]);
});

test("validateRepoPath requires absolute paths", () => {
  assert.throws(() => validateRepoPath("relative/path"), /absolute/i);
});

test("git log summaries never include argument values", () => {
  const summary = summarizeGitInvocation(["commit", "-m", "private release token"]);

  assert.deepEqual(summary, { command: "git commit", argCount: 2 });
  assert.doesNotMatch(JSON.stringify(summary), /private release token/);
});

test("runProcess can pass input through stdin", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
    input: "hello from stdin"
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "hello from stdin");
});

test("runProcess can resolve after stdout becomes idle", async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, ["-e", "console.log('ready'); setTimeout(() => {}, 5000)"], {
    resolveOnStdoutIdleMs: 50,
    timeout: 5000
  });

  assert.equal(result.ok, true);
  assert.equal(result.stdout.trim(), "ready");
  assert.ok(Date.now() - started < 1000);
});

test("runGit inherits the active trace context", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "git-trace-"));
  const logDirectory = path.join(cwd, ".git-safe-logs");
  const logger = await initLogger({ directory: logDirectory, level: "debug" });

  await runWithTraceId("trace-git", async () => runGit(cwd, ["status", "--short"]));
  await logger.flush();

  const file = (await logger.listFiles()).find((entry) => entry.name.startsWith("operations-"));
  assert.ok(file);
  assert.match(await readFile(file.path, "utf8"), /\[trace-git\]/);
  await logger.close();
});
