import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkflowRunner } from "../lib/workflow-runner.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createRepo(prefix = "gsc-runner-") {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

test("workflow runner inspects without AI and emits phase events", async () => {
  const repo = await createRepo();
  const events = [];
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    },
    emit: (event, data) => events.push({ event, data })
  });

  const result = await runner.run("inspect", {});

  assert.equal(result.ok, true);
  assert.equal(result.status.branch, "main");
  assert.deepEqual(events.map((item) => item.event), ["phase", "phase"]);
});
