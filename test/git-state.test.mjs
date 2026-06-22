import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectGitState } from "../lib/git-state.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createRepo(prefix = "gsc-state-") {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

test("collectGitState reports branch and dirty paths", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  await writeFile(path.join(repo, "new.txt"), "new\n", "utf8");

  const state = await collectGitState(repo);

  assert.equal(state.branch, "main");
  assert.equal(state.cleanWorktree, false);
  assert.deepEqual(state.unstaged.map((item) => item.path), ["tracked.txt"]);
  assert.deepEqual(state.untracked, ["new.txt"]);
  assert.equal(state.unmerged.length, 0);
});
