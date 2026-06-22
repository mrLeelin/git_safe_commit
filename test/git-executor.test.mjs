import assert from "node:assert/strict";
import test from "node:test";

import { normalizeGitArgs, validateGitArgs, validateRepoPath } from "../lib/git-executor.mjs";

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
