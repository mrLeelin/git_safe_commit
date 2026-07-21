import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectGitState, mergeUntrackedPaths, parseShortStatus, summarizeGitState } from "../lib/git-state.mjs";

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
  assert.deepEqual(state.branches, ["main"]);
  assert.equal(state.cleanWorktree, false);
  assert.deepEqual(state.unstaged.map((item) => item.path), ["tracked.txt"]);
  assert.deepEqual(state.untracked, ["new.txt"]);
  assert.equal(state.unmerged.length, 0);
});

test("mergeUntrackedPaths ignores stale collapsed status directories when ls-files succeeds", () => {
  assert.deepEqual(mergeUntrackedPaths({ ok: true, stdout: "" }, [".omc/"]), []);
  assert.deepEqual(mergeUntrackedPaths({ ok: true, stdout: "real.txt\n" }, ["stale-dir/"]), ["real.txt"]);
});

test("mergeUntrackedPaths falls back to short status when ls-files fails", () => {
  assert.deepEqual(mergeUntrackedPaths({ ok: false, stdout: "" }, ["fallback-dir/"]), ["fallback-dir/"]);
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
    excel: { files: [] },
    rebaseTarget: { paths: [], excelPaths: [], highRiskPaths: [] },
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

test("summarizeGitState exposes Git's pending Merge message", () => {
  const summary = summarizeGitState({
    branch: "feature/login2",
    branches: [],
    upstream: "",
    ahead: 0,
    behind: 0,
    cleanWorktree: false,
    staged: [{ status: "M", path: "src/Constant.xlsx" }],
    unstaged: [],
    untracked: [],
    unmerged: [],
    conflictMarkers: [],
    rebaseInProgress: false,
    mergeInProgress: true,
    mergeMessage: "Merge branch 'feature/login' into feature/login2\n\n# Conflicts:\n#\tsrc/Constant.xlsx\n",
    excel: { files: [] },
    rebaseTarget: { paths: [], excelPaths: [], highRiskPaths: [] }
  });

  assert.equal(summary.mergeInProgress, true);
  assert.match(summary.mergeMessage, /Merge branch 'feature\/login' into feature\/login2/);
  assert.match(summary.mergeMessage, /#\t?src\/Constant\.xlsx/);
});

test("summarizeGitState blocks rebase target Excel files that cannot be opened exclusively", () => {
  const summary = summarizeGitState({
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 1,
    staged: [],
    unstaged: [],
    untracked: [],
    unmerged: [],
    conflictMarkers: [],
    rebaseInProgress: false,
    excel: {
      files: [{
        path: "Tables/Config.xlsx",
        reasons: ["rebase-target"],
        lockedExclusive: true,
        openInExcel: false
      }]
    },
    rebaseTarget: {
      paths: ["Tables/Config.xlsx"],
      excelPaths: ["Tables/Config.xlsx"],
      highRiskPaths: ["Tables/Config.xlsx"]
    },
    checks: {
      unstaged: { ok: true, stdout: "" },
      staged: { ok: true, stdout: "" }
    }
  });

  assert.equal(summary.openExcelCount, 1);
  assert.equal(summary.rebaseTargetExcelCount, 1);
  assert.deepEqual(summary.blockers, ["请先关闭即将被 rebase 覆盖的 Excel 文件再继续: Tables/Config.xlsx"]);
});
