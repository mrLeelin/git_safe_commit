import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exportBinaryConflict, loadTextConflict, writeTextCandidate } from "../lib/conflict-workbench.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createConflictRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-workbench-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeFile(path.join(repo, "tracked.js"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repo, "data.bytes"), Buffer.from([1, 2, 3, 4]));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["switch", "-c", "feature"]);
  await writeFile(path.join(repo, "tracked.js"), "export const value = 2;\n", "utf8");
  await writeFile(path.join(repo, "data.bytes"), Buffer.from([2, 2, 3, 4]));
  git(repo, ["commit", "-am", "feature edit"]);
  git(repo, ["switch", "main"]);
  await writeFile(path.join(repo, "tracked.js"), "export const value = 3;\n", "utf8");
  await writeFile(path.join(repo, "data.bytes"), Buffer.from([3, 2, 3, 4]));
  git(repo, ["commit", "-am", "main edit"]);
  assert.throws(() => git(repo, ["merge", "feature"]));
  return repo;
}

test("text conflict workbench loads stages and writes a candidate without staging", async () => {
  const repo = await createConflictRepo();

  const loaded = await loadTextConflict({ repoPath: repo, filePath: "tracked.js" });
  const candidate = await writeTextCandidate({
    repoPath: repo,
    filePath: "tracked.js",
    content: "export const value = 5;\n",
    source: "line",
    lineChoices: [{ row: 1, choice: "both" }]
  });

  assert.equal(loaded.ok, true);
  assert.match(loaded.textConflict.base.content, /value = 1/);
  assert.match(loaded.textConflict.ours.content, /value = 3/);
  assert.match(loaded.textConflict.theirs.content, /value = 2/);
  assert.equal(candidate.ok, true);
  assert.match(candidate.textCandidate.candidate, /\.git\/git-safe-commit-backups\/.+\/text-merge-candidates\/tracked\.merged\./);
  assert.equal(await readFile(path.join(repo, candidate.textCandidate.candidate), "utf8"), "export const value = 5;\n");
  const choices = JSON.parse(await readFile(path.join(repo, candidate.textCandidate.choices), "utf8"));
  assert.equal(choices.source, "line");
  assert.deepEqual(choices.lineChoices, [{ row: 1, choice: "both" }]);
  assert.match(git(repo, ["status", "--short"]), /^UU tracked\.js/m);
});

test("binary conflict workbench exports ours and theirs without resolving", async () => {
  const repo = await createConflictRepo();

  const result = await exportBinaryConflict({ repoPath: repo, filePath: "data.bytes" });

  assert.equal(result.ok, true);
  assert.match(result.binaryConflict.ours, /\.git\/git-safe-commit-backups\/.+\/binary-conflicts\/data\.bytes\.ours\.bytes/);
  assert.match(result.binaryConflict.theirs, /\.git\/git-safe-commit-backups\/.+\/binary-conflicts\/data\.bytes\.theirs\.bytes/);
  assert.deepEqual([...await readFile(path.join(repo, result.binaryConflict.ours))], [3, 2, 3, 4]);
  assert.deepEqual([...await readFile(path.join(repo, result.binaryConflict.theirs))], [2, 2, 3, 4]);
  assert.match(git(repo, ["status", "--short"]), /^UU data\.bytes/m);
});
