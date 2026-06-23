import assert from "node:assert/strict";
import test from "node:test";

import { buildCommitLogArgs, buildGraphLogArgs, parseCommitGraph } from "../lib/git-graph.mjs";

test("git graph commands use topo order", () => {
  assert.deepEqual(buildGraphLogArgs().slice(0, 3), ["log", "--graph", "--topo-order"]);
  assert.ok(buildCommitLogArgs().includes("--topo-order"));
});

test("parseCommitGraph preserves parents and refs", () => {
  const stdout = [
    "hash1\u001fabc1234\u001fparent1 parent2\u001fHEAD -> main, origin/main\u001fTester\u001fmerge feature\u001f2026-06-23"
  ].join("\n");

  const commits = parseCommitGraph(stdout);

  assert.equal(commits[0].hash, "hash1");
  assert.deepEqual(commits[0].parents, ["parent1", "parent2"]);
  assert.deepEqual(commits[0].refs, ["main", "origin/main"]);
  assert.equal(commits[0].isHead, true);
});
