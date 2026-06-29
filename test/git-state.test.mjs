import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectGitState, parseShortStatus, summarizeGitState } from "../lib/git-state.mjs";

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

test("parseShortStatus reports paths that only appear in git status", () => {
  const parsed = parseShortStatus([
    "## main...origin/main",
    " M JellybeanUnity/Assets/_Art/Materials/HomeMainView_Combo_Progress_Effect.mat",
    "M  staged.txt",
    " M \"JellybeanUnity/Assets/Plugins/Easy Save 3/Resources/ES3/ES3Defaults.asset\"",
    "?? new.txt"
  ].join("\n"));

  assert.deepEqual(parsed.unstaged, [
    { status: "M", path: "JellybeanUnity/Assets/_Art/Materials/HomeMainView_Combo_Progress_Effect.mat" },
    { status: "M", path: "JellybeanUnity/Assets/Plugins/Easy Save 3/Resources/ES3/ES3Defaults.asset" }
  ]);
  assert.deepEqual(parsed.staged, [{ status: "M", path: "staged.txt" }]);
  assert.deepEqual(parsed.untracked, ["new.txt"]);
});

test("summarizeGitState does not block whitespace-only diff check failures", () => {
  const summary = summarizeGitState({
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [{ status: "M", path: "tracked.txt" }],
    untracked: [],
    unmerged: [],
    conflictMarkers: [],
    rebaseInProgress: false,
    checks: {
      unstaged: {
        ok: false,
        stdout: "tracked.txt:18: trailing whitespace.\n+            \n"
      },
      staged: { ok: true, stdout: "" }
    }
  });

  assert.deepEqual(summary.blockers, []);
});
