import assert from "node:assert/strict";
import test from "node:test";

import { buildCommitGraphRows } from "../src/graph-layout.js";

test("commit graph layout keeps rebased linear history on one mainline", () => {
  const rows = buildCommitGraphRows([
    { hash: "c3", parents: ["c2"], subject: "after rebase" },
    { hash: "c2", parents: ["c1"], subject: "middle" },
    { hash: "c1", parents: [], subject: "root" }
  ]);

  assert.deepEqual(rows.map((row) => row.nodeLane), [0, 0, 0]);
  assert.deepEqual(rows.map((row) => row.branchLines), [[], [], []]);
  assert.equal(rows.some((row) => row.isMerge), false);
  assert.equal(rows.some((row) => row.showMergeJoin), false);
});

test("commit graph layout shows temporary branch and join for merge commits", () => {
  const rows = buildCommitGraphRows([
    { hash: "merge", parents: ["main-parent", "feature-tip"], subject: "merge feature" },
    { hash: "main-parent", parents: ["base"], subject: "main work" },
    { hash: "feature-tip", parents: ["base"], subject: "feature work" },
    { hash: "base", parents: [], subject: "base" }
  ]);

  assert.equal(rows[0].isMerge, true);
  assert.equal(rows[0].showMergeJoin, true);
  assert.deepEqual(rows[0].branchLines, [1]);
  assert.equal(rows[0].nodeLane, 0);

  assert.deepEqual(rows[1].branchLines, [1]);
  assert.equal(rows[1].nodeLane, 0);

  assert.deepEqual(rows[2].branchLines, [1]);
  assert.equal(rows[2].nodeLane, 1);
  assert.equal(rows[2].endsBranch, true);

  assert.deepEqual(rows[3].branchLines, [1]);
  assert.equal(rows[3].nodeLane, 0);
  assert.equal(rows[3].showBranchSplit, true);
  assert.deepEqual(rows[3].branchSplitLanes, [1]);
});

test("commit graph layout gives unmerged branch tips their own lane", () => {
  const rows = buildCommitGraphRows([
    { hash: "main-new", parents: ["main-old"], refs: ["dev"], subject: "main work" },
    { hash: "main-old", parents: ["base"], subject: "older main" },
    { hash: "backup-tip", parents: ["backup-old"], refs: ["backup/safety"], subject: "side branch tip" },
    { hash: "backup-old", parents: ["base"], subject: "side branch work" },
    { hash: "base", parents: [], subject: "shared base" }
  ]);

  assert.deepEqual(rows.map((row) => row.nodeLane), [0, 0, 1, 1, 0]);
  assert.equal(rows[0].startsLane, true);
  assert.equal(rows[2].startsLane, true);
  assert.equal(rows[3].startsLane, false);
  assert.deepEqual(rows[2].branchLines, [1]);
  assert.deepEqual(rows[3].branchLines, [1]);
  assert.equal(rows[4].showBranchSplit, true);
  assert.deepEqual(rows[4].branchSplitLanes, [1]);
});

test("commit graph layout hides stash internal merge parents", () => {
  const rows = buildCommitGraphRows([
    { hash: "main-new", parents: ["stash", "other-parent"], subject: "merge work" },
    { hash: "stash", parents: ["main-old", "stash-index", "stash-untracked"], refs: ["refs/stash"], subject: "stash" },
    { hash: "stash-untracked", parents: [], subject: "untracked files on branch" },
    { hash: "stash-index", parents: ["main-old"], subject: "index on branch" },
    { hash: "main-old", parents: ["base"], subject: "main work" },
    { hash: "base", parents: [], subject: "base" }
  ]);

  assert.equal(rows[1].isStash, true);
  assert.deepEqual(rows.map((row) => row.hash), ["main-new", "stash", "main-old", "base"]);
  assert.deepEqual(rows[1].mergeJoinLanes, []);
  assert.equal(rows[1].showMergeJoin, false);
  assert.deepEqual(rows[1].branchLines, [1]);
  assert.equal(rows[2].nodeLane, 0);
});
