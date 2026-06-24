import { rm } from "node:fs/promises";
import path from "node:path";

import { runAiToolLoopLocal } from "./ai-decider.mjs";
import { runGit, runProcess } from "./git-executor.mjs";
import { collectGitState, summarizeGitState } from "./git-state.mjs";
import { createRecovery } from "./recovery.mjs";
import { GitSafeCommitTools, SystemPrompt } from "./tool-definitions.mjs";

const AiSyncPrompt = `For ai-sync actions, make one sync decision before repository changes.
- Use git_status when you need current repository facts.
- If sync is safe to attempt, call sync_remote exactly once. sync_remote owns fetch, recovery, temporary stash, rebase, restore, and cleanup.
- Do not ask for git_fetch or git_rebase directly in ai-sync.
- If repository state requires human resolution, call escalate_conflict with a concrete reason.
- After sync_remote or escalate_conflict returns, provide a short final summary.`;

const AiSyncTools = [
  toolDefinition("git_status"),
  {
    type: "function",
    function: {
      name: "sync_remote",
      description: "Run the built-in safe remote sync path after AI decides it is appropriate. This performs fetch, recovery, temporary stash, rebase, restore, and cleanup.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  toolDefinition("final_verify"),
  toolDefinition("escalate_conflict")
].filter(Boolean);

const RemoteAdvancedPushMessage = "远端已有新提交。请点击“AI 同步后推送”，工具会先同步远端，自动 rebase 成功后继续推送；如果出现冲突会停下等待处理。本工具不会执行 force push。";

export function createWorkflowRunner({ config, emit = () => {}, fetchImpl, runProcess: runProcessImpl } = {}) {
  const runProcessFn = runProcessImpl || runProcess;
  const state = {
    phase: "Idle",
    activeRecovery: null,
    activeSyncStash: null,
    blockers: [],
    note: ""
  };

  async function run(action, payload = {}) {
    if (action === "inspect") {
      return inspect();
    }
    if (action === "create-recovery") {
      return createRecoveryAction();
    }
    if (action === "fetch") {
      return fetchRemote();
    }
    if (action === "sync") {
      return syncRemote();
    }
    if (action === "commit") {
      return commitSelectedFiles(payload);
    }
    if (action === "continue-rebase-and-push") {
      return continueRebaseAndPush(payload);
    }
    if (action === "abort-rebase") {
      return abortRebase(payload);
    }
    if (action === "push") {
      return pushDirect(payload);
    }
    if (action === "ai-sync-and-push") {
      return syncAndPush(payload);
    }
    if (action === "ai-sync") {
      return runAiSyncAction(payload);
    }
    if (action === "ai-push" || action === "ai-commit") {
      return runAiAction(action, payload);
    }
    throw new Error(`unknown workflow action: ${action}`);
  }

  async function inspect() {
    await setPhase("Inspecting", "reading repository status");
    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    await setPhase("Idle", "status ready");
    return { ok: true, status, summary };
  }

  async function createRecoveryAction() {
    await setPhase("RecoveryCreating", "creating backup branch, patches, and stash");
    const recovery = await createRecovery(config.repoPath);
    state.activeRecovery = recovery;
    await setPhase("RecoveryCreated", `recovery ${recovery.timestamp} ready`);
    return { ok: true, recovery };
  }

  async function fetchRemote() {
    await setPhase("Fetching", "fetching remote refs");
    const fetch = await runGit(config.repoPath, ["fetch", "--prune"]);
    if (!fetch.ok) {
      await setPhase("UserResolutionPending", "git fetch failed");
      throw new Error(fetch.stderr || fetch.stdout || fetch.error || "git fetch failed");
    }
    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    await setPhase("Idle", "fetch complete");
    return { ok: true, fetch, status, summary };
  }

  async function syncRemote() {
    await setPhase("Syncing", "fetching remote refs");
    const fetch = await runGit(config.repoPath, ["fetch", "--prune"]);
    if (!fetch.ok) {
      await setPhase("UserResolutionPending", "git fetch failed");
      throw new Error(fetch.stderr || fetch.stdout || fetch.error || "git fetch failed");
    }

    const fetchedStatus = await collectGitState(config.repoPath);
    const fetchedSummary = summarizeGitState(fetchedStatus);
    state.blockers = fetchedSummary.blockers;
    if (!fetchedStatus.upstream) {
      await setPhase("UserResolutionPending", "upstream is missing");
      throw new Error("sync requires an upstream branch");
    }
    if (fetchedSummary.rebaseInProgress) {
      await setPhase("UserResolutionPending", "rebase already in progress");
      throw new Error("rebase already in progress; resolve conflicts then continue rebase and push");
    }
    if (fetchedSummary.unmergedCount) {
      await setPhase("UserResolutionPending", "sync blocked by repository state");
      throw new Error("sync blocked: unmerged files present");
    }
    if (!fetchedSummary.behind) {
      await setPhase("Idle", "already synced");
      return { ok: true, fetch, rebase: null, recovery: null, status: fetchedStatus, summary: fetchedSummary };
    }

    await setPhase("RecoveryCreating", "creating recovery before rebase");
    const recovery = await createRecovery(config.repoPath);
    state.activeRecovery = recovery;
    const syncStash = fetchedSummary.cleanWorktree ? null : await stashForSync(recovery.timestamp);
    state.activeSyncStash = syncStash;

    await setPhase("Rebasing", "rebasing onto upstream");
    const rebase = await runGit(config.repoPath, ["rebase", "@{u}"]);
    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    if (!rebase.ok) {
      await setPhase("UserResolutionPending", "rebase needs conflict resolution");
      return {
        ok: false,
        blocked: true,
        reason: rebase.stderr || rebase.stdout || rebase.error || "git rebase failed",
        fetch,
        rebase,
        recovery,
        syncStash,
        status,
        summary
      };
    }

    const stashRestore = syncStash ? await restoreSyncStash(syncStash) : null;
    if (stashRestore && !stashRestore.apply.ok) {
      const restoreStatus = await collectGitState(config.repoPath);
      const restoreSummary = summarizeGitState(restoreStatus);
      state.blockers = restoreSummary.blockers;
      await setPhase("UserResolutionPending", "temporary stash restore failed");
      return {
        ok: false,
        blocked: true,
        reason: stashRestore.apply.stderr || stashRestore.apply.stdout || stashRestore.apply.error || "temporary stash restore failed",
        fetch,
        rebase,
        recovery,
        syncStash: { ...syncStash, ...stashRestore },
        status: restoreStatus,
        summary: restoreSummary
      };
    }

    const recoveryCleanup = await cleanupRecovery(recovery);
    state.activeSyncStash = null;
    await setPhase("Idle", "sync complete");
    const finalStatus = stashRestore ? await collectGitState(config.repoPath) : status;
    const finalSummary = stashRestore ? summarizeGitState(finalStatus) : summary;
    state.blockers = finalSummary.blockers;
    return {
      ok: true,
      fetch,
      rebase,
      recovery,
      recoveryCleanup,
      syncStash: syncStash ? { ...syncStash, ...stashRestore } : null,
      status: finalStatus,
      summary: finalSummary
    };
  }

  async function stashForSync(timestamp) {
    await setPhase("Stashing", "saving dirty worktree before rebase");
    const message = `git-safe-commit-tool sync ${timestamp}`;
    const stash = await runGit(config.repoPath, ["stash", "push", "--include-untracked", "--message", message]);
    if (!stash.ok) {
      await setPhase("UserResolutionPending", "temporary stash failed");
      throw new Error(stash.stderr || stash.stdout || stash.error || "temporary stash failed");
    }
    const ref = "stash@{0}";
    const sha = await runGit(config.repoPath, ["rev-parse", "--verify", ref]);
    return { message, ref, sha: sha.ok ? sha.stdout.trim() : "", stash };
  }

  async function restoreSyncStash(syncStash) {
    await setPhase("StashRestoring", "restoring dirty worktree after rebase");
    const apply = await runGit(config.repoPath, ["stash", "apply", "--index", syncStash.ref]);
    if (!apply.ok) {
      return { apply, drop: null };
    }
    const current = await runGit(config.repoPath, ["rev-parse", "--verify", syncStash.ref]);
    if (syncStash.sha && current.ok && current.stdout.trim() !== syncStash.sha) {
      return {
        apply,
        drop: {
          ok: false,
          code: 1,
          stdout: "",
          stderr: "temporary stash ref changed before cleanup",
          error: "temporary stash ref changed before cleanup"
        }
      };
    }
    const drop = await runGit(config.repoPath, ["stash", "drop", syncStash.ref]);
    if (!drop.ok) {
      await setPhase("UserResolutionPending", "temporary stash cleanup failed");
      throw new Error(drop.stderr || drop.stdout || drop.error || "temporary stash cleanup failed");
    }
    return { apply, drop };
  }

  async function cleanupRecovery(recovery) {
    await setPhase("RecoveryCleaning", "removing temporary recovery point after successful sync");
    const branch = await runGit(config.repoPath, ["branch", "-D", recovery.backupBranch]);
    if (!branch.ok) {
      await setPhase("UserResolutionPending", "temporary recovery branch cleanup failed");
      throw new Error(branch.stderr || branch.stdout || branch.error || "temporary recovery branch cleanup failed");
    }
    await rm(path.join(config.repoPath, recovery.backupDir), { recursive: true, force: true });
    if (state.activeRecovery?.backupBranch === recovery.backupBranch) {
      state.activeRecovery = null;
    }
    return { branch, backupDirRemoved: true };
  }

  async function runAiAction(action, payload) {
    await setPhase("Inspecting", `starting ${action}`);
    const result = await runAiToolLoopLocal({
      config,
      messages: [
        { role: "system", content: SystemPrompt },
        { role: "user", content: JSON.stringify({ action, payload }) }
      ],
      tools: GitSafeCommitTools,
      handlers: createToolHandlers({ action, payload }),
      runProcess: runProcessFn,
      onEvent: emit
    });
    await setPhase("Idle", "AI action complete");
    return { ok: true, ...result };
  }

  async function runAiSyncAction(payload) {
    await setPhase("Inspecting", "starting ai-sync decision");
    const result = await runAiToolLoopLocal({
      config,
      messages: [
        { role: "system", content: `${SystemPrompt}\n\n${AiSyncPrompt}` },
        { role: "user", content: JSON.stringify({ action: "ai-sync", payload }) }
      ],
      tools: AiSyncTools,
      handlers: createAiSyncToolHandlers({ payload }),
      runProcess: runProcessFn,
      onEvent: emit
    });
    await setPhase("Idle", "AI sync decision complete");
    return { ok: true, ...result };
  }

  async function commitSelectedFiles(payload = {}) {
    const paths = Array.isArray(payload.paths) ? payload.paths.map(String) : [];
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    if (!paths.length) {
      throw new Error("commit requires a non-empty paths array");
    }
    if (!message) {
      throw new Error("commit requires message");
    }

    await setPhase("Committing", "committing selected files");
    const beforeStatus = await collectGitState(config.repoPath);
    const beforeSummary = summarizeGitState(beforeStatus);
    if (beforeSummary.blockers.length) {
      state.blockers = beforeSummary.blockers;
      await setPhase("UserResolutionPending", "commit blocked by repository state");
      throw new Error(`commit blocked: ${beforeSummary.blockers.join("; ")}`);
    }

    const add = await runGit(config.repoPath, ["add", "--", ...paths]);
    if (!add.ok) {
      await setPhase("UserResolutionPending", "git add failed");
      throw new Error(add.stderr || add.stdout || add.error || "git add failed");
    }
    const commit = await runGit(config.repoPath, ["commit", "-m", message]);
    if (!commit.ok) {
      await setPhase("UserResolutionPending", "git commit failed");
      throw new Error(commit.stderr || commit.stdout || commit.error || "git commit failed");
    }

    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    await setPhase("Idle", "commit complete");
    return { ok: true, add, commit, status, summary };
  }

  async function continueRebaseAndPush(payload = {}) {
    await setPhase("RebaseContinuing", "continuing resolved rebase");
    const beforeStatus = await collectGitState(config.repoPath);
    const beforeSummary = summarizeGitState(beforeStatus);
    if (!beforeSummary.rebaseInProgress) {
      await setPhase("UserResolutionPending", "no active rebase");
      throw new Error("no active rebase to continue");
    }
    if (beforeSummary.blockers.length) {
      state.blockers = beforeSummary.blockers;
      await setPhase("UserResolutionPending", "rebase still has blockers");
      throw new Error(`continue rebase blocked: ${beforeSummary.blockers.join("; ")}`);
    }

    const continueRebase = await runGit(config.repoPath, ["rebase", "--continue"], { env: { GIT_EDITOR: "true" } });
    if (!continueRebase.ok) {
      await setPhase("UserResolutionPending", "git rebase --continue failed");
      throw new Error(continueRebase.stderr || continueRebase.stdout || continueRebase.error || "git rebase --continue failed");
    }

    const afterRebaseStatus = await collectGitState(config.repoPath);
    const afterRebaseSummary = summarizeGitState(afterRebaseStatus);
    state.blockers = afterRebaseSummary.blockers;
    if (afterRebaseSummary.rebaseInProgress || afterRebaseSummary.blockers.length) {
      await setPhase("UserResolutionPending", "rebase needs more resolution");
      return {
        ok: false,
        blocked: true,
        reason: "rebase needs more resolution",
        continueRebase,
        status: afterRebaseStatus,
        summary: afterRebaseSummary
      };
    }

    if (config.workflow?.requireConfirmBeforePush && !payload.confirmed) {
      state.blockers = ["Push requires browser confirmation."];
      await setPhase("UserResolutionPending", "push confirmation required");
      return { ok: false, blocked: true, reason: "push confirmation required", continueRebase, status: afterRebaseStatus, summary: afterRebaseSummary };
    }

    const pushPreflight = await guardPushPreflight();
    if (pushPreflight.blocked) return pushPreflight;

    await setPhase("Pushing", "pushing rebased branch");
    const push = await runGit(config.repoPath, ["push"]);
    if (!push.ok) {
      if (isRemoteAdvancedPushFailure(push)) {
        return remoteAdvancedPushResult({ push });
      }
      await setPhase("UserResolutionPending", "git push failed");
      throw new Error(push.stderr || push.stdout || push.error || "git push failed");
    }

    const syncStash = state.activeSyncStash;
    const stashRestore = syncStash ? await restoreSyncStash(syncStash) : null;
    if (stashRestore && !stashRestore.apply.ok) {
      const restoreStatus = await collectGitState(config.repoPath);
      const restoreSummary = summarizeGitState(restoreStatus);
      state.blockers = restoreSummary.blockers;
      await setPhase("UserResolutionPending", "temporary stash restore failed after push");
      return {
        ok: false,
        blocked: true,
        message: "push succeeded, but temporary stash restore failed",
        reason: stashRestore.apply.stderr || stashRestore.apply.stdout || stashRestore.apply.error || "temporary stash restore failed",
        continueRebase,
        push,
        syncStash: { ...syncStash, ...stashRestore },
        status: restoreStatus,
        summary: restoreSummary
      };
    }
    if (stashRestore) state.activeSyncStash = null;
    const recoveryCleanup = state.activeRecovery ? await cleanupRecovery(state.activeRecovery) : null;

    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    await setPhase("Idle", "rebase continued and pushed");
    return {
      ok: true,
      message: "rebase continued and pushed",
      continueRebase,
      push,
      recoveryCleanup,
      syncStash: syncStash ? { ...syncStash, ...stashRestore } : null,
      status,
      summary
    };
  }

  async function abortRebase(payload = {}) {
    await setPhase("RebaseAborting", "aborting active rebase");
    const beforeStatus = await collectGitState(config.repoPath);
    const beforeSummary = summarizeGitState(beforeStatus);
    if (!beforeSummary.rebaseInProgress) {
      await setPhase("UserResolutionPending", "no active rebase");
      throw new Error("no active rebase to abort");
    }
    if (!payload.confirmed) {
      state.blockers = ["Rebase abort requires browser confirmation."];
      await setPhase("UserResolutionPending", "rebase abort confirmation required");
      return { ok: false, blocked: true, reason: "rebase abort confirmation required", status: beforeStatus, summary: beforeSummary };
    }

    const abortRebase = await runGit(config.repoPath, ["rebase", "--abort"]);
    if (!abortRebase.ok) {
      await setPhase("UserResolutionPending", "git rebase --abort failed");
      throw new Error(abortRebase.stderr || abortRebase.stdout || abortRebase.error || "git rebase --abort failed");
    }

    const syncStash = state.activeSyncStash;
    const stashRestore = syncStash ? await restoreSyncStash(syncStash) : null;
    if (stashRestore && !stashRestore.apply.ok) {
      const restoreStatus = await collectGitState(config.repoPath);
      const restoreSummary = summarizeGitState(restoreStatus);
      state.blockers = restoreSummary.blockers;
      await setPhase("UserResolutionPending", "temporary stash restore failed after rebase abort");
      return {
        ok: false,
        blocked: true,
        message: "rebase aborted, but temporary stash restore failed",
        reason: stashRestore.apply.stderr || stashRestore.apply.stdout || stashRestore.apply.error || "temporary stash restore failed",
        abortRebase,
        syncStash: { ...syncStash, ...stashRestore },
        status: restoreStatus,
        summary: restoreSummary
      };
    }
    if (stashRestore) state.activeSyncStash = null;

    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    await setPhase("Idle", "rebase aborted");
    return {
      ok: true,
      message: "rebase aborted",
      abortRebase,
      syncStash: syncStash ? { ...syncStash, ...stashRestore } : null,
      status,
      summary
    };
  }

  async function pushDirect(payload = {}) {
    await setPhase("Pushing", "checking repository before push");
    const beforeStatus = await collectGitState(config.repoPath);
    const beforeSummary = summarizeGitState(beforeStatus);
    state.blockers = beforeSummary.blockers;

    if (beforeSummary.rebaseInProgress) {
      await setPhase("UserResolutionPending", "rebase must be continued before push");
      throw new Error("rebase is in progress; continue rebase before pushing");
    }
    if (beforeSummary.blockers.length) {
      await setPhase("UserResolutionPending", "push blocked by repository state");
      throw new Error(`push blocked: ${beforeSummary.blockers.join("; ")}`);
    }
    if (!beforeSummary.cleanWorktree) {
      await setPhase("UserResolutionPending", "push requires clean worktree");
      throw new Error(cleanWorktreePushError(beforeStatus));
    }
    if (config.workflow?.requireConfirmBeforePush && !payload.confirmed) {
      state.blockers = ["Push requires browser confirmation."];
      await setPhase("UserResolutionPending", "push confirmation required");
      return { ok: false, blocked: true, reason: "push confirmation required", status: beforeStatus, summary: beforeSummary };
    }

    const pushPreflight = await guardPushPreflight();
    if (pushPreflight.blocked) return pushPreflight;

    await setPhase("Pushing", "pushing branch");
    const push = await runGit(config.repoPath, ["push"]);
    if (!push.ok) {
      if (isRemoteAdvancedPushFailure(push)) {
        return remoteAdvancedPushResult({ push });
      }
      await setPhase("UserResolutionPending", "git push failed");
      throw new Error(push.stderr || push.stdout || push.error || "git push failed");
    }

    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    const recoveryCleanup = state.activeRecovery ? await cleanupRecovery(state.activeRecovery) : null;
    await setPhase("Idle", "push complete");
    return { ok: true, message: "push complete", push, recoveryCleanup, status, summary };
  }

  async function syncAndPush(payload = {}) {
    const syncs = [];
    let lastBlocked = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pushed = await pushDirect(payload);
      if (pushed.ok) {
        return {
          ok: true,
          message: "AI sync and push complete",
          push: pushed.push,
          recoveryCleanup: pushed.recoveryCleanup,
          status: pushed.status,
          summary: pushed.summary,
          syncs,
          attempts: attempt + 1
        };
      }
      if (pushed.reason !== "remote advanced before push") {
        return { ...pushed, syncs, attempts: attempt + 1 };
      }

      lastBlocked = pushed;
      const sync = await syncRemote();
      syncs.push(sync);
      if (!sync.ok) {
        return {
          ...sync,
          syncs,
          attempts: attempt + 1,
          message: sync.message || sync.reason || "AI sync blocked before push"
        };
      }
    }

    await setPhase("UserResolutionPending", "remote advanced too frequently");
    return {
      ok: false,
      blocked: true,
      reason: "remote advanced too frequently",
      message: "远端更新太频繁，本次自动推送已暂停。稍后刷新状态后再试。",
      error: "远端更新太频繁，本次自动推送已暂停。稍后刷新状态后再试。",
      recommendedAction: "inspect",
      syncs,
      status: lastBlocked?.status,
      summary: lastBlocked?.summary
    };
  }

  function createToolHandlers({ action = "", payload = {} } = {}) {
    return {
      git_status: async () => {
        const status = await collectGitState(config.repoPath);
        return { status, summary: summarizeGitState(status) };
      },
      create_recovery: async () => {
        const recovery = await createRecovery(config.repoPath);
        state.activeRecovery = recovery;
        return recovery;
      },
      git_fetch: async () => runGit(config.repoPath, ["fetch", "--prune"]),
      git_add: async ({ paths } = {}) => {
        const addPaths = action === "ai-commit" ? payload.paths : paths;
        if (!Array.isArray(addPaths) || !addPaths.length) {
          throw new Error("git_add requires a non-empty paths array");
        }
        return runGit(config.repoPath, ["add", "--", ...addPaths.map(String)]);
      },
      git_commit: async ({ message } = {}) => {
        const commitMessage = action === "ai-commit" ? payload.message : message;
        if (!commitMessage || typeof commitMessage !== "string") {
          throw new Error("git_commit requires message");
        }
        return runGit(config.repoPath, ["commit", "-m", commitMessage]);
      },
      git_rebase: async ({ onto = "@{u}" } = {}) => {
        if (!state.activeRecovery) {
          throw new Error("recovery is required before git_rebase");
        }
        return runGit(config.repoPath, ["rebase", onto]);
      },
      git_push: async ({ confirmed = false } = {}) => {
        const status = await collectGitState(config.repoPath);
        const summary = summarizeGitState(status);
        if (summary.blockers.length) {
          throw new Error(`push blocked: ${summary.blockers.join("; ")}`);
        }
        if (!summary.cleanWorktree) {
          throw new Error(cleanWorktreePushError(status));
        }
        if (config.workflow?.requireConfirmBeforePush && !confirmed) {
          state.blockers = ["Push requires browser confirmation."];
          await setPhase("UserResolutionPending", "push confirmation required");
          return { blocked: true, reason: "push confirmation required" };
        }
        const pushPreflight = await guardPushPreflight();
        if (pushPreflight.blocked) throw new Error(pushPreflight.message);
        const push = await runGit(config.repoPath, ["push"]);
        if (!push.ok && isRemoteAdvancedPushFailure(push)) {
          const blocked = await remoteAdvancedPushResult({ push });
          throw new Error(blocked.message);
        }
        return push;
      },
      final_verify: async () => {
        const status = await collectGitState(config.repoPath);
        return { status, summary: summarizeGitState(status) };
      },
      escalate_conflict: async ({ path, reason }) => {
        state.blockers = [`${path}: ${reason}`];
        await setPhase("UserResolutionPending", reason);
        return { escalated: true, path, reason };
      }
    };
  }

  function createAiSyncToolHandlers({ payload = {} } = {}) {
    const baseHandlers = createToolHandlers({ action: "ai-sync", payload });
    return {
      git_status: baseHandlers.git_status,
      sync_remote: async () => syncRemote(),
      final_verify: baseHandlers.final_verify,
      escalate_conflict: baseHandlers.escalate_conflict
    };
  }

  async function setPhase(phase, note = "") {
    state.phase = phase;
    state.note = note;
    emit("phase", { phase, note });
  }

  async function guardPushPreflight() {
    await setPhase("Pushing", "AI checking remote freshness before push");
    const fetch = await runGit(config.repoPath, ["fetch", "--prune"]);
    if (!fetch.ok) {
      await setPhase("UserResolutionPending", "git fetch failed before push");
      throw new Error(fetch.stderr || fetch.stdout || fetch.error || "git fetch failed before push");
    }
    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    if (summary.behind > 0) {
      return remoteAdvancedPushResult({ fetch, status, summary });
    }
    return { ok: true, fetch, status, summary };
  }

  async function remoteAdvancedPushResult({ fetch = null, push = null, status = null, summary = null } = {}) {
    const latestFetch = fetch || await runGit(config.repoPath, ["fetch", "--prune"]);
    const latestStatus = status || await collectGitState(config.repoPath);
    const latestSummary = summary || summarizeGitState(latestStatus);
    state.blockers = ["remote advanced before push"];
    await setPhase("UserResolutionPending", "remote advanced before push");
    return {
      ok: false,
      blocked: true,
      reason: "remote advanced before push",
      message: RemoteAdvancedPushMessage,
      error: RemoteAdvancedPushMessage,
      recommendedAction: "ai-sync-and-push",
      fetch: latestFetch,
      push,
      status: latestStatus,
      summary: latestSummary
    };
  }

  return {
    run,
    state
  };
}

function cleanWorktreePushError(status) {
  const paths = dirtyPaths(status);
  const suffix = paths.length ? ` Dirty paths: ${paths.join(", ")}` : "";
  return `push requires clean worktree; commit or resolve local changes before pushing.${suffix}`;
}

function dirtyPaths(status) {
  return [
    ...(status.staged || []).map((item) => item.path),
    ...(status.unstaged || []).map((item) => item.path),
    ...(status.untracked || []),
    ...(status.unmerged || [])
  ].filter(Boolean);
}

function isRemoteAdvancedPushFailure(result = {}) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}\n${result.error || ""}`;
  return /fetch first|non-fast-forward|rejected|remote contains work|updates were rejected/i.test(text);
}

function toolDefinition(name) {
  return GitSafeCommitTools.find((tool) => tool.function?.name === name);
}
