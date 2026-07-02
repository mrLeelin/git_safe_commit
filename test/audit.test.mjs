import assert from "node:assert/strict";
import test from "node:test";

import { auditRepositoryState, classifyPathRisk } from "../lib/audit.mjs";

function labelsFor(filePath) {
  return classifyPathRisk(filePath).labels;
}

test("classifyPathRisk labels sensitive and domain-specific files", () => {
  assert.ok(labelsFor("config.json").includes("private-config"));
  assert.ok(labelsFor(".env.local").includes("env"));
  assert.ok(labelsFor("BuildBat/keystore/partygo.keystore").includes("secret"));
  assert.ok(labelsFor("Tools/Datas/Language.xlsx").includes("table"));
  assert.ok(labelsFor("Assets/Foo/Player.prefab").includes("unity-resource"));
  assert.ok(labelsFor("Assets/Foo/GeneratedTags.g.cs").includes("generated"));
  assert.ok(labelsFor("artifacts/archive.zip").includes("binary"));
});

test("auditRepositoryState blocks staged paths outside the selected commit scope", () => {
  const audit = auditRepositoryState({
    action: "commit",
    selectedPaths: ["src/app.js"],
    status: {
      staged: [{ status: "M", path: "config.json" }],
      unstaged: [{ status: "M", path: "src/app.js" }],
      untracked: [],
      unmerged: [],
      conflictMarkers: [],
      rebaseInProgress: false
    },
    summary: {
      cleanWorktree: false,
      blockers: [],
      rebaseInProgress: false,
      unmergedCount: 0
    }
  });

  assert.equal(audit.verdict, "blocked");
  assert.equal(audit.title, "范围不一致");
  assert.deepEqual(
    audit.findings.find((finding) => finding.code === "staged-out-of-scope")?.paths,
    ["config.json"]
  );
  assert.ok(audit.riskFiles.find((file) => file.path === "config.json")?.labels.includes("private-config"));
});

test("auditRepositoryState blocks stale selected paths before git add", () => {
  const audit = auditRepositoryState({
    action: "commit",
    selectedPaths: ["src/deleted-before-commit.js"],
    status: {
      staged: [],
      unstaged: [{ status: "M", path: "src/app.js" }],
      untracked: [],
      unmerged: [],
      conflictMarkers: [],
      rebaseInProgress: false
    },
    summary: {
      cleanWorktree: false,
      blockers: [],
      rebaseInProgress: false,
      unmergedCount: 0
    }
  });

  assert.equal(audit.verdict, "blocked");
  assert.equal(audit.title, "选择已过期");
  assert.deepEqual(
    audit.findings.find((finding) => finding.code === "selected-paths-stale")?.paths,
    ["src/deleted-before-commit.js"]
  );
});

test("auditRepositoryState flags risky selected paths without blocking clean scope", () => {
  const audit = auditRepositoryState({
    action: "commit",
    selectedPaths: ["Tools/Datas/Language.xlsx"],
    status: {
      staged: [],
      unstaged: [{ status: "M", path: "Tools/Datas/Language.xlsx" }],
      untracked: [],
      unmerged: [],
      conflictMarkers: [],
      rebaseInProgress: false
    },
    summary: {
      cleanWorktree: false,
      blockers: [],
      rebaseInProgress: false,
      unmergedCount: 0
    }
  });

  assert.equal(audit.verdict, "needs_confirmation");
  assert.equal(
    audit.findings.find((finding) => finding.code === "risky-selected-files")?.message,
    "选中的文件里包含配置、资源或二进制等需确认类型，请确认后再提交。"
  );
  assert.equal(audit.findings.find((finding) => finding.code === "risky-selected-files")?.count, 1);
});

test("auditRepositoryState treats a resolved rebase as ready to continue during inspect", () => {
  const audit = auditRepositoryState({
    action: "inspect",
    status: {
      staged: [{ status: "M", path: "src/table-conflict.csv" }],
      unstaged: [],
      untracked: [],
      unmerged: [],
      conflictMarkers: [],
      rebaseInProgress: true
    },
    summary: {
      cleanWorktree: false,
      blockers: [],
      rebaseInProgress: true,
      unmergedCount: 0,
      markerCount: 0
    }
  });

  assert.equal(audit.verdict, "needs_confirmation");
  assert.equal(audit.title, "需要确认");
  assert.equal(
    audit.findings.find((finding) => finding.code === "rebase-ready-to-continue")?.severity,
    "warn"
  );
  assert.ok(audit.riskFiles.find((file) => file.path === "src/table-conflict.csv")?.labels.includes("table"));
});

test("auditRepositoryState blocks non-rebase actions while rebase is still active", () => {
  const audit = auditRepositoryState({
    action: "commit",
    selectedPaths: ["src/app.js"],
    status: {
      staged: [{ status: "M", path: "src/app.js" }],
      unstaged: [],
      untracked: [],
      unmerged: [],
      conflictMarkers: [],
      rebaseInProgress: true
    },
    summary: {
      cleanWorktree: false,
      blockers: [],
      rebaseInProgress: true,
      unmergedCount: 0,
      markerCount: 0
    }
  });

  assert.equal(audit.verdict, "blocked");
  assert.equal(
    audit.findings.find((finding) => finding.code === "rebase-ready-to-continue")?.message,
    "当前处于 rebase 流程，请先继续或复位 rebase，不能执行这个动作。"
  );
});

test("auditRepositoryState does not treat unselected unstaged files as audit risks", () => {
  const audit = auditRepositoryState({
    action: "inspect",
    selectedPaths: [],
    status: {
      staged: [],
      unstaged: [
        { status: "M", path: ".claude/settings.local.json" },
        { status: "M", path: "Assets/Foo.prefab" }
      ],
      untracked: ["crash.log"],
      unmerged: [],
      conflictMarkers: [],
      rebaseInProgress: false
    },
    summary: {
      cleanWorktree: false,
      blockers: [],
      rebaseInProgress: false,
      unmergedCount: 0
    }
  });

  assert.equal(audit.counts.dirty, 3);
  assert.equal(audit.counts.risk, 0);
  assert.deepEqual(audit.riskFiles, []);
  assert.equal(audit.verdict, "passed");
});

test("auditRepositoryState returns Chinese audit messages", () => {
  const audit = auditRepositoryState({
    status: {
      staged: [],
      unstaged: [{ status: "M", path: "Assets/Foo.prefab" }],
      untracked: [],
      unmerged: [],
      conflictMarkers: [],
      rebaseInProgress: false
    },
    summary: {
      cleanWorktree: false,
      blockers: [],
      rebaseInProgress: false,
      unmergedCount: 0
    },
    toolStashes: [
      { ref: "stash@{0}", sha: "abc", subject: "On dev: git-safe-commit-tool discard 1", type: "discard" },
      { ref: "stash@{1}", sha: "def", subject: "On dev: git-safe-commit-tool sync 2", type: "sync" }
    ]
  });

  assert.equal(audit.title, "需要确认");
  assert.equal(
    audit.findings.find((finding) => finding.code === "tool-stashes-present")?.message,
    "仍有工具创建的 stash 未处理（2 个，其中可自动恢复 1 个、历史同步 1 个）。历史同步 stash 不会自动恢复。"
  );
  assert.equal(audit.counts.discardStash, 1);
  assert.equal(audit.counts.syncStash, 1);
});

test("auditRepositoryState treats historical sync stashes as low-priority status", () => {
  const audit = auditRepositoryState({
    status: {
      staged: [],
      unstaged: [],
      untracked: [],
      unmerged: [],
      conflictMarkers: [],
      rebaseInProgress: false
    },
    summary: {
      cleanWorktree: true,
      blockers: [],
      rebaseInProgress: false,
      unmergedCount: 0
    },
    toolStashes: [
      { ref: "stash@{0}", sha: "def", subject: "On dev: git-safe-commit-tool sync 2", type: "sync" }
    ]
  });

  assert.equal(audit.verdict, "passed");
  assert.equal(audit.title, "审计通过");
  assert.equal(audit.findings.find((finding) => finding.code === "tool-stashes-present")?.severity, "info");
  assert.equal(audit.counts.toolStash, 1);
  assert.equal(audit.counts.syncStash, 1);
});
