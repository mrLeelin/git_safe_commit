import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRecovery } from "../lib/recovery.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createRepo(prefix = "gsc-recovery-") {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

test("createRecovery writes evidence and stashes dirty work", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  await writeFile(path.join(repo, "new.txt"), "new\n", "utf8");

  const recovery = await createRecovery(repo, { timestamp: "20260622-120000" });

  assert.equal(recovery.timestamp, "20260622-120000");
  assert.match(recovery.backupBranch, /^backup\/git-safe-commit-tool\//);
  assert.ok(existsSync(path.join(repo, recovery.backupDir, "status.txt")));
  assert.ok(existsSync(path.join(repo, recovery.backupDir, "head.txt")));
  assert.ok(existsSync(path.join(repo, recovery.backupDir, "unstaged.patch")));
  assert.ok(existsSync(path.join(repo, recovery.backupDir, "untracked-manifest.txt")));
  assert.ok(recovery.stashRef);

  const status = git(repo, ["status", "--short"]);
  assert.equal(status.trim(), "");
});
