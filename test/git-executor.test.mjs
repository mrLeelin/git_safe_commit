import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import { normalizeGitArgs, runProcess, validateGitArgs, validateRepoPath } from "../lib/git-executor.mjs";

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
