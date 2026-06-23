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
