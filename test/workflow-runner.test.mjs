import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

test("workflow runner commits selected files directly without AI", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  let fetchCalled = false;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("AI should not be called for direct commit");
    }
  });

  const result = await runner.run("commit", { paths: ["tracked.txt"], message: "Commit selected file directly" });

  assert.equal(result.ok, true);
  assert.equal(fetchCalled, false);
  assert.match(git(repo, ["log", "-1", "--pretty=%s"]).trim(), /^Commit selected file directly$/);
  assert.match(git(repo, ["show", "--name-only", "--pretty=", "HEAD"]).trim(), /^tracked\.txt$/);
});

test("workflow runner discards only selected working tree paths", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  await writeFile(path.join(repo, "other.txt"), "other\n", "utf8");
  git(repo, ["add", "other.txt"]);
  git(repo, ["commit", "-m", "add other"]);
  await writeFile(path.join(repo, "other.txt"), "keep this change\n", "utf8");
  await writeFile(path.join(repo, "new.txt"), "remove me\n", "utf8");
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  const result = await runner.run("discard-selected", { paths: ["tracked.txt", "new.txt"], confirmed: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.discarded.sort(), ["new.txt", "tracked.txt"]);
  assert.equal((await readFile(path.join(repo, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"), "one\n");
  await assert.rejects(() => access(path.join(repo, "new.txt")));
  assert.equal(await readFile(path.join(repo, "other.txt"), "utf8"), "keep this change\n");
  assert.match(git(repo, ["status", "--short"]), /^ M other\.txt/m);
});

test("workflow runner fetches remote refs directly without AI and refreshes status", async () => {
  const repo = await createRepo();
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-remote-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
  let fetchCalled = false;
  const events = [];
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    },
    emit: (event, data) => events.push({ event, data }),
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("AI should not be called for direct fetch");
    }
  });

  const result = await runner.run("fetch", {});

  assert.equal(result.ok, true);
  assert.equal(fetchCalled, false);
  assert.equal(result.status.branch, "main");
  assert.equal(result.summary.branch, "main");
  assert.match(git(repo, ["rev-parse", "--verify", "refs/remotes/origin/main"]).trim(), /^[0-9a-f]{40}$/);
  assert.deepEqual(events.map((item) => item.data.phase), ["Fetching", "Idle"]);
});

test("workflow runner syncs remote directly with fetch and rebase without AI", async () => {
  const repo = await createRepo("gsc-sync-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-sync-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-sync-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);

  await writeFile(path.join(repo, "local.txt"), "local\n", "utf8");
  git(repo, ["add", "local.txt"]);
  git(repo, ["commit", "-m", "local change"]);
  await writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
  git(other, ["add", "remote.txt"]);
  git(other, ["commit", "-m", "remote change"]);
  git(other, ["push"]);
  let fetchCalled = false;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("AI should not be called for direct sync");
    }
  });

  const result = await runner.run("sync", {});

  assert.equal(result.ok, true);
  assert.equal(fetchCalled, false);
  assert.equal(result.fetch.ok, true);
  assert.equal(result.rebase.ok, true);
  assert.equal(result.summary.behind, 0);
  assert.equal(result.summary.ahead, 1);
  assert.equal(result.summary.cleanWorktree, true);
  assert.equal(git(repo, ["log", "-1", "--pretty=%s"]).trim(), "local change");
  assert.match(git(repo, ["log", "--pretty=%s", "--max-count=2"]), /remote change/);
});

test("workflow runner ai-sync lets AI decide once before using the safe sync path", async () => {
  const repo = await createRepo("gsc-ai-sync-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-ai-sync-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-ai-sync-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);

  await writeFile(path.join(repo, "local.txt"), "local\n", "utf8");
  git(repo, ["add", "local.txt"]);
  git(repo, ["commit", "-m", "local change"]);
  await writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
  git(other, ["add", "remote.txt"]);
  git(other, ["commit", "-m", "remote change"]);
  git(other, ["push"]);

  const cliOutputs = [
    JSON.stringify({ tool: "sync_remote", args: {} }),
    "sync decided and completed"
  ];
  let callIndex = 0;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: { selected: "claude" }
    },
    runProcess: async () => ({
      ok: true, code: 0, stdout: cliOutputs[callIndex++] || "", stderr: "", command: "claude --print"
    })
  });

  const result = await runner.run("ai-sync", {});

  assert.equal(result.ok, true);
  assert.equal(callIndex, 2);
  assert.equal(result.finalText, "sync decided and completed");
  assert.equal(result.toolResults[0].tool, "sync_remote");
  assert.equal(result.toolResults[0].result.ok, true);
  assert.equal(result.toolResults[0].result.rebase.ok, true);
  assert.equal(result.toolResults[0].result.summary.behind, 0);
  assert.equal(result.toolResults[0].result.summary.ahead, 1);
  assert.equal(git(repo, ["log", "-1", "--pretty=%s"]).trim(), "local change");
  assert.match(git(repo, ["log", "--pretty=%s", "--max-count=2"]), /remote change/);
});

test("workflow runner pushes directly without AI after browser confirmation", async () => {
  const repo = await createRepo("gsc-push-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-push-remote-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  git(repo, ["commit", "-am", "local push change"]);
  let fetchCalled = false;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error("AI should not be called for direct push");
    }
  });

  const result = await runner.run("push", { confirmed: true });

  assert.equal(result.ok, true);
  assert.equal(fetchCalled, false);
  assert.equal(result.push.ok, true);
  assert.equal(result.message, "push complete");
  assert.equal(result.summary.ahead, 0);
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), git(repo, ["rev-parse", "@{u}"]).trim());
});

test("workflow runner blocks push when remote advanced after the last inspect", async () => {
  const repo = await createRepo("gsc-push-race-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-push-race-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-push-race-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);
  await writeFile(path.join(repo, "tracked.txt"), "local\n", "utf8");
  git(repo, ["commit", "-am", "local push change"]);
  await writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
  git(other, ["add", "remote.txt"]);
  git(other, ["commit", "-m", "remote race change"]);
  git(other, ["push"]);

  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  const result = await runner.run("push", { confirmed: true });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "remote advanced before push");
  assert.equal(result.recommendedAction, "ai-sync-and-push");
  assert.equal(result.summary.behind, 1);
  assert.match(result.message, /AI 同步后推送/);
  assert.match(result.message, /远端已有新提交/);
  assert.notEqual(git(repo, ["rev-parse", "HEAD"]).trim(), git(repo, ["rev-parse", "@{u}"]).trim());
});

test("workflow runner syncs and pushes from the single AI push recovery action", async () => {
  const repo = await createRepo("gsc-sync-push-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-sync-push-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-sync-push-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);
  await writeFile(path.join(repo, "local.txt"), "local\n", "utf8");
  git(repo, ["add", "local.txt"]);
  git(repo, ["commit", "-m", "local push change"]);
  await writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
  git(other, ["add", "remote.txt"]);
  git(other, ["commit", "-m", "remote race change"]);
  git(other, ["push"]);

  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  const result = await runner.run("ai-sync-and-push", { confirmed: true });

  assert.equal(result.ok, true);
  assert.equal(result.message, "AI sync and push complete");
  assert.equal(result.syncs.length, 1);
  assert.equal(result.push.ok, true);
  assert.equal(result.summary.behind, 0);
  assert.equal(result.summary.ahead, 0);
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), git(repo, ["rev-parse", "@{u}"]).trim());
  assert.equal(git(other, ["rev-parse", "HEAD"]).trim(), git(other, ["rev-parse", "origin/main"]).trim());
  assert.match(git(repo, ["log", "--pretty=%s", "--max-count=2"]), /local push change/);
  assert.match(git(repo, ["log", "--pretty=%s", "--max-count=2"]), /remote race change/);
});

test("workflow runner temporarily stashes dirty worktree while AI sync-and-push pushes committed work", async () => {
  const repo = await createRepo("gsc-sync-push-dirty-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-sync-push-dirty-remote-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "committed\n", "utf8");
  git(repo, ["commit", "-am", "local push change"]);
  const committedHead = git(repo, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(repo, "tracked.txt"), "dirty after commit\n", "utf8");
  await writeFile(path.join(repo, "scratch.txt"), "scratch\n", "utf8");

  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  const result = await runner.run("ai-sync-and-push", { confirmed: true });

  assert.equal(result.ok, true);
  assert.equal(result.push.ok, true);
  assert.equal(result.syncStash.stash.ok, true);
  assert.equal(result.syncStash.apply.ok, true);
  assert.equal(result.syncStash.drop.ok, true);
  assert.equal(result.summary.ahead, 0);
  assert.equal(result.summary.cleanWorktree, false);
  assert.equal(git(repo, ["rev-parse", "@{u}"]).trim(), committedHead);
  assert.equal(normalizeNewlines(await readFile(path.join(repo, "tracked.txt"), "utf8")), "dirty after commit\n");
  assert.equal(normalizeNewlines(await readFile(path.join(repo, "scratch.txt"), "utf8")), "scratch\n");
  assert.equal(git(repo, ["stash", "list"]).trim(), "");
});

test("workflow runner blocks direct push without browser confirmation", async () => {
  const repo = await createRepo("gsc-push-confirm-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-push-confirm-remote-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  const result = await runner.run("push", {});

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "push confirmation required");
});

test("workflow runner blocks direct push when worktree has local changes", async () => {
  const repo = await createRepo("gsc-push-dirty-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-push-dirty-remote-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  git(repo, ["commit", "-am", "local push change"]);
  await writeFile(path.join(repo, "scratch.txt"), "scratch\n", "utf8");
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  await assert.rejects(
    () => runner.run("push", { confirmed: true }),
    /push requires clean worktree;.*scratch\.txt/
  );
});

test("workflow runner stashes dirty worktree during sync, restores it, and removes temporary recovery", async () => {
  const repo = await createRepo("gsc-sync-dirty-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-sync-dirty-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-sync-dirty-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);
  await writeFile(path.join(repo, "local.txt"), "local\n", "utf8");
  git(repo, ["add", "local.txt"]);
  git(repo, ["commit", "-m", "local change"]);
  await writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
  git(other, ["add", "remote.txt"]);
  git(other, ["commit", "-m", "remote change"]);
  git(other, ["push"]);
  await writeFile(path.join(repo, "tracked.txt"), "dirty\n", "utf8");
  await writeFile(path.join(repo, "scratch.txt"), "scratch\n", "utf8");
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  const result = await runner.run("sync", {});

  assert.equal(result.ok, true);
  assert.equal(result.rebase.ok, true);
  assert.equal(result.syncStash.stash.ok, true);
  assert.equal(result.syncStash.apply.ok, true);
  assert.equal(result.syncStash.drop.ok, true);
  assert.equal(result.recoveryCleanup.branch.ok, true);
  assert.equal(result.recoveryCleanup.backupDirRemoved, true);
  assert.equal(result.summary.behind, 0);
  assert.equal(result.summary.ahead, 1);
  assert.equal(result.summary.cleanWorktree, false);
  assert.equal(normalizeNewlines(await readFile(path.join(repo, "tracked.txt"), "utf8")), "dirty\n");
  assert.equal(normalizeNewlines(await readFile(path.join(repo, "scratch.txt"), "utf8")), "scratch\n");
  assert.equal(git(repo, ["stash", "list"]).trim(), "");
  assert.equal(git(repo, ["branch", "--list", result.recovery.backupBranch]).trim(), "");
  await assert.rejects(access(path.join(repo, result.recovery.backupDir)));
});

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

test("workflow runner continues a resolved rebase conflict and pushes without creating a new commit", async () => {
  const repo = await createRepo("gsc-rebase-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-rebase-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-rebase-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);

  await writeFile(path.join(repo, "tracked.txt"), "local\n", "utf8");
  git(repo, ["commit", "-am", "local change"]);
  await writeFile(path.join(other, "tracked.txt"), "remote\n", "utf8");
  git(other, ["commit", "-am", "remote change"]);
  git(other, ["push"]);
  git(repo, ["fetch", "--prune"]);
  assert.throws(() => git(repo, ["rebase", "origin/main"]));
  await writeFile(path.join(repo, "tracked.txt"), "local\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  const localCommitBeforeContinue = git(repo, ["rev-parse", "REBASE_HEAD"]).trim();

  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });
  const result = await runner.run("continue-rebase-and-push", { confirmed: true });

  assert.equal(result.ok, true);
  assert.equal(result.continueRebase.ok, true);
  assert.equal(result.push.ok, true);
  assert.equal(result.summary.rebaseInProgress, false);
  assert.equal(result.summary.cleanWorktree, true);
  assert.equal(git(repo, ["log", "-1", "--pretty=%s"]).trim(), "local change");
  assert.notEqual(git(repo, ["rev-parse", "HEAD"]).trim(), localCommitBeforeContinue);
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), git(repo, ["rev-parse", "@{u}"]).trim());
});

test("workflow runner cleans pending sync recovery and stash after resolved rebase push", async () => {
  const repo = await createRepo("gsc-rebase-cleanup-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-rebase-cleanup-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-rebase-cleanup-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);

  await writeFile(path.join(repo, "tracked.txt"), "local\n", "utf8");
  git(repo, ["commit", "-am", "local change"]);
  await writeFile(path.join(other, "tracked.txt"), "remote\n", "utf8");
  git(other, ["commit", "-am", "remote change"]);
  git(other, ["push"]);
  await writeFile(path.join(repo, "scratch.txt"), "scratch\n", "utf8");

  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  const sync = await runner.run("sync", {});

  assert.equal(sync.ok, false);
  assert.equal(sync.blocked, true);
  assert.ok(sync.recovery);
  assert.ok(sync.syncStash);
  assert.notEqual(git(repo, ["stash", "list"]).trim(), "");

  await writeFile(path.join(repo, "tracked.txt"), "local\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  const result = await runner.run("continue-rebase-and-push", { confirmed: true });

  assert.equal(result.ok, true);
  assert.equal(result.message, "rebase continued and pushed");
  assert.equal(result.recoveryCleanup.branch.ok, true);
  assert.equal(result.recoveryCleanup.backupDirRemoved, true);
  assert.equal(result.syncStash.apply.ok, true);
  assert.equal(result.syncStash.drop.ok, true);
  assert.equal(normalizeNewlines(await readFile(path.join(repo, "scratch.txt"), "utf8")), "scratch\n");
  assert.equal(git(repo, ["stash", "list"]).trim(), "");
  assert.equal(git(repo, ["branch", "--list", sync.recovery.backupBranch]).trim(), "");
  await assert.rejects(access(path.join(repo, sync.recovery.backupDir)));
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), git(repo, ["rev-parse", "@{u}"]).trim());
});

test("workflow runner refuses continue-and-push outside an active rebase", async () => {
  const repo = await createRepo("gsc-no-rebase-runner-");
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  await assert.rejects(
    () => runner.run("continue-rebase-and-push", { confirmed: true }),
    /no active rebase/
  );
});

test("workflow runner aborts an active rebase back to the pre-rebase state", async () => {
  const repo = await createRepo("gsc-rebase-abort-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-rebase-abort-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-rebase-abort-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);

  await writeFile(path.join(repo, "tracked.txt"), "local\n", "utf8");
  git(repo, ["commit", "-am", "local change"]);
  const localHeadBeforeRebase = git(repo, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(other, "tracked.txt"), "remote\n", "utf8");
  git(other, ["commit", "-am", "remote change"]);
  git(other, ["push"]);
  git(repo, ["fetch", "--prune"]);
  assert.throws(() => git(repo, ["rebase", "origin/main"]));

  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });
  const result = await runner.run("abort-rebase", { confirmed: true });

  assert.equal(result.ok, true);
  assert.equal(result.abortRebase.ok, true);
  assert.equal(result.summary.rebaseInProgress, false);
  assert.equal(result.summary.cleanWorktree, true);
  assert.equal(git(repo, ["rev-parse", "HEAD"]).trim(), localHeadBeforeRebase);
  assert.equal(normalizeNewlines(await readFile(path.join(repo, "tracked.txt"), "utf8")), "local\n");
});

test("workflow runner refuses rebase abort outside an active rebase", async () => {
  const repo = await createRepo("gsc-no-rebase-abort-runner-");
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    }
  });

  await assert.rejects(
    () => runner.run("abort-rebase", { confirmed: true }),
    /no active rebase/
  );
});

test("workflow runner accepts ai-commit payload and exposes commit tools", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  const cliOutputs = [
    JSON.stringify({ tool: "git_status", args: {} }),
    JSON.stringify({ tool: "git_add", args: { paths: ["tracked.txt"] } }),
    JSON.stringify({ tool: "git_commit", args: { message: "Explain narrow commit path" } }),
    JSON.stringify({ tool: "final_verify", args: {} }),
    "committed"
  ];
  let callIndex = 0;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: { selected: "claude" }
    },
    runProcess: async () => ({
      ok: true, code: 0, stdout: cliOutputs[callIndex++] || "", stderr: "", command: "claude --print"
    })
  });

  const result = await runner.run("ai-commit", { paths: ["tracked.txt"], message: "Explain narrow commit path" });

  assert.equal(result.ok, true);
  assert.equal(result.finalText, "committed");
  assert.match(git(repo, ["log", "-1", "--pretty=%s"]).trim(), /^Explain narrow commit path$/);
});

test("workflow runner blocks AI push when worktree has local changes", async () => {
  const repo = await createRepo("gsc-ai-push-dirty-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-ai-push-dirty-remote-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  git(repo, ["commit", "-am", "local push change"]);
  await writeFile(path.join(repo, "scratch.txt"), "scratch\n", "utf8");
  const cliOutputs = [
    JSON.stringify({ tool: "git_push", args: { confirmed: true } })
  ];
  let callIndex = 0;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: { selected: "claude" }
    },
    runProcess: async () => ({
      ok: true, code: 0, stdout: cliOutputs[callIndex++] || "", stderr: "", command: "claude --print"
    })
  });

  await assert.rejects(
    () => runner.run("ai-push", { confirmed: true }),
    /push requires clean worktree;.*scratch\.txt/
  );
});

test("workflow runner blocks AI push when remote advanced before the AI tool pushes", async () => {
  const repo = await createRepo("gsc-ai-push-race-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-ai-push-race-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-ai-push-race-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);
  await writeFile(path.join(repo, "tracked.txt"), "local\n", "utf8");
  git(repo, ["commit", "-am", "local push change"]);
  await writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
  git(other, ["add", "remote.txt"]);
  git(other, ["commit", "-m", "remote race change"]);
  git(other, ["push"]);
  const cliOutputs = [
    JSON.stringify({ tool: "git_push", args: { confirmed: true } })
  ];
  let callIndex = 0;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: { selected: "claude" }
    },
    runProcess: async () => ({
      ok: true, code: 0, stdout: cliOutputs[callIndex++] || "", stderr: "", command: "claude --print"
    })
  });

  await assert.rejects(
    () => runner.run("ai-push", { confirmed: true }),
    /远端已有新提交/
  );
});

test("workflow runner blocks AI git_rebase when dirty worktree needs safe sync stash", async () => {
  const repo = await createRepo("gsc-ai-rebase-dirty-runner-");
  const remote = await mkdtemp(path.join(os.tmpdir(), "gsc-ai-rebase-dirty-remote-"));
  const other = await mkdtemp(path.join(os.tmpdir(), "gsc-ai-rebase-dirty-other-"));
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  git(other, ["clone", remote, "."]);
  git(other, ["config", "user.email", "remote@example.test"]);
  git(other, ["config", "user.name", "Remote Test"]);
  await writeFile(path.join(repo, "local.txt"), "local\n", "utf8");
  git(repo, ["add", "local.txt"]);
  git(repo, ["commit", "-m", "local change"]);
  await writeFile(path.join(other, "remote.txt"), "remote\n", "utf8");
  git(other, ["add", "remote.txt"]);
  git(other, ["commit", "-m", "remote change"]);
  git(other, ["push"]);
  await writeFile(path.join(repo, "tracked.txt"), "dirty\n", "utf8");

  const cliOutputs = [
    JSON.stringify({ tool: "create_recovery", args: {} }),
    JSON.stringify({ tool: "git_rebase", args: { onto: "@{u}" } })
  ];
  let callIndex = 0;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: { selected: "claude" }
    },
    runProcess: async () => ({
      ok: true, code: 0, stdout: cliOutputs[callIndex++] || "", stderr: "", command: "claude --print"
    })
  });

  await assert.rejects(
    () => runner.run("ai-push", { confirmed: true }),
    /Use the built-in sync_remote path/
  );
  await assert.rejects(() => access(path.join(repo, ".git", "rebase-merge")));
  await assert.rejects(() => access(path.join(repo, ".git", "rebase-apply")));
});

test("workflow runner uses the UI commit message even when AI tool args differ", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  const cliOutputs = [
    JSON.stringify({ tool: "git_add", args: { paths: ["tracked.txt"] } }),
    JSON.stringify({ tool: "git_commit", args: { message: "AI ignored the UI prompt" } }),
    JSON.stringify({ tool: "final_verify", args: {} }),
    "committed"
  ];
  let callIndex = 0;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: { selected: "claude" }
    },
    runProcess: async () => ({
      ok: true, code: 0, stdout: cliOutputs[callIndex++] || "", stderr: "", command: "claude --print"
    })
  });

  await runner.run("ai-commit", { paths: ["tracked.txt"], message: "Use this UI prompt exactly" });

  assert.match(git(repo, ["log", "-1", "--pretty=%s"]).trim(), /^Use this UI prompt exactly$/);
});

test("workflow runner stages only UI selected paths even when AI tool args differ", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  await writeFile(path.join(repo, "other.txt"), "other\n", "utf8");
  git(repo, ["add", "other.txt"]);
  git(repo, ["commit", "-m", "add other"]);
  await writeFile(path.join(repo, "tracked.txt"), "three\n", "utf8");
  await writeFile(path.join(repo, "other.txt"), "changed other\n", "utf8");
  const cliOutputs = [
    JSON.stringify({ tool: "git_add", args: { paths: ["other.txt"] } }),
    JSON.stringify({ tool: "git_commit", args: { message: "Commit selected file" } }),
    JSON.stringify({ tool: "final_verify", args: {} }),
    "committed"
  ];
  let callIndex = 0;
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: { selected: "claude" }
    },
    runProcess: async () => ({
      ok: true, code: 0, stdout: cliOutputs[callIndex++] || "", stderr: "", command: "claude --print"
    })
  });

  await runner.run("ai-commit", { paths: ["tracked.txt"], message: "Commit selected file" });

  assert.match(git(repo, ["show", "--name-only", "--pretty=", "HEAD"]).trim(), /^tracked\.txt$/);
  assert.match(git(repo, ["status", "--short"]), /^ M other\.txt/m);
});
