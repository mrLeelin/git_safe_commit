import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAiToolLoopLocal } from "./ai-decider.mjs";
import { auditRepositoryState } from "./audit.mjs";
import { pathInsideRepo, runGit, runProcess } from "./git-executor.mjs";
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
    pendingDiscardStashes: [],
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
    if (action === "discard-selected") {
      return discardSelectedFiles(payload);
    }
    if (action === "restore-tool-stashes") {
      return restoreToolStashesAction(payload);
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
    const snapshot = await inspectSnapshot();
    await setPhase("Idle", "status ready");
    return snapshot;
  }

  async function inspectSnapshot() {
    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    const activeSyncStash = await getActiveSyncStash();
    const toolStashes = await listToolStashes();
    const audit = auditRepositoryState({
      action: "inspect",
      status,
      summary,
      activeRecovery: state.activeRecovery,
      activeSyncStash,
      toolStashes
    });
    state.blockers = summary.blockers;
    return { ok: true, status, summary, audit, toolStashes };
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
    const syncStash = fetchedSummary.cleanWorktree ? null : await stashForSync(recovery.timestamp, recovery);
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

  async function stashForSync(timestamp, recovery = null) {
    await setPhase("Stashing", "saving dirty worktree before rebase");
    const message = `git-safe-commit-tool sync ${timestamp}`;
    const stash = await runGit(config.repoPath, ["stash", "push", "--include-untracked", "--message", message]);
    if (!stash.ok) {
      await setPhase("UserResolutionPending", "temporary stash failed");
      throw new Error(stash.stderr || stash.stdout || stash.error || "temporary stash failed");
    }
    const ref = "stash@{0}";
    const sha = await runGit(config.repoPath, ["rev-parse", "--verify", ref]);
    const syncStash = { message, ref, sha: sha.ok ? sha.stdout.trim() : "", stash, timestamp };
    await persistSyncStash(syncStash, recovery);
    return syncStash;
  }

  async function restoreSyncStash(syncStash) {
    await setPhase("StashRestoring", "restoring dirty worktree after rebase");
    const resolved = await resolveSyncStashRef(syncStash);
    const restoreRef = syncStash.sha ? resolved.ref : (resolved.ref || syncStash.ref);
    const expectedSha = resolved.sha || syncStash.sha;
    if (!restoreRef) {
      return {
        apply: {
          ok: false,
          code: 1,
          stdout: "",
          stderr: "temporary stash ref is unavailable",
          error: "temporary stash ref is unavailable"
        },
        drop: null
      };
    }
    const apply = await runGit(config.repoPath, ["stash", "apply", "--index", restoreRef]);
    if (!apply.ok) {
      return { apply, drop: null };
    }
    const current = await runGit(config.repoPath, ["rev-parse", "--verify", restoreRef]);
    if (expectedSha && current.ok && current.stdout.trim() !== expectedSha) {
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
    const drop = await runGit(config.repoPath, ["stash", "drop", restoreRef]);
    if (!drop.ok) {
      await setPhase("UserResolutionPending", "temporary stash cleanup failed");
      throw new Error(drop.stderr || drop.stdout || drop.error || "temporary stash cleanup failed");
    }
    const remaining = expectedSha ? await resolveSyncStashRef({ sha: expectedSha }) : { ref: "" };
    return {
      apply,
      drop,
      ref: restoreRef,
      sha: expectedSha,
      verified: {
        restoreApplied: apply.ok,
        stashDropped: !remaining.ref
      }
    };
  }

  async function persistSyncStash(syncStash, recovery) {
    if (!syncStash?.timestamp) return;
    const metadataPath = syncStashMetadataPath(syncStash.timestamp);
    const metadata = {
      version: 1,
      timestamp: syncStash.timestamp,
      recovery,
      syncStash: {
        message: syncStash.message,
        ref: syncStash.ref,
        sha: syncStash.sha,
        timestamp: syncStash.timestamp
      }
    };
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  async function getActiveSyncStash() {
    if (state.activeSyncStash) return state.activeSyncStash;
    const loaded = await loadPendingSyncStash();
    if (!loaded) return null;
    state.activeSyncStash = loaded;
    if (!state.activeRecovery && loaded.recovery) state.activeRecovery = loaded.recovery;
    return loaded;
  }

  async function loadPendingSyncStash() {
    const root = path.join(config.repoPath, ".git", "git-safe-commit-tool-backups");
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return null;
    }
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const directory of directories) {
      const metadataPath = path.join(root, directory, "sync-stash.json");
      try {
        const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
        const syncStash = metadata.syncStash;
        if (!syncStash) continue;
        const resolved = await resolveSyncStashRef(syncStash);
        if (!resolved.ref) continue;
        return {
          ...syncStash,
          ref: resolved.ref,
          sha: resolved.sha || syncStash.sha,
          recovery: metadata.recovery || null,
          metadataPath
        };
      } catch {
        // Ignore stale or partial metadata and keep looking for an older pending sync stash.
      }
    }
    return null;
  }

  async function resolveSyncStashRef(syncStash) {
    if (syncStash?.sha) {
      const list = await runGit(config.repoPath, ["stash", "list", "--format=%gd%x00%H"]);
      if (list.ok) {
        for (const line of list.stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const [ref, sha] = line.split("\0");
          if (sha === syncStash.sha) return { ref, sha };
        }
        return { ref: "", sha: syncStash.sha };
      }
    }
    return { ref: syncStash?.ref || "", sha: syncStash?.sha || "" };
  }

  function syncStashMetadataPath(timestamp) {
    return path.join(config.repoPath, ".git", "git-safe-commit-tool-backups", timestamp, "sync-stash.json");
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
    const activeSyncStash = await getActiveSyncStash();
    const beforeToolStashes = await listToolStashes();
    const beforeAudit = auditRepositoryState({
      action: "commit",
      selectedPaths: paths,
      status: beforeStatus,
      summary: beforeSummary,
      activeRecovery: state.activeRecovery,
      activeSyncStash,
      toolStashes: beforeToolStashes
    });
    if (beforeAudit.verdict === "blocked") {
      state.blockers = beforeAudit.findings
        .filter((finding) => finding.severity === "blocked")
        .map((finding) => finding.message);
      await setPhase("UserResolutionPending", "commit blocked by audit");
      throw auditError("staged files outside selected commit scope; inspect staged files before committing", beforeAudit);
    }
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

    const pendingDiscardStashes = state.pendingDiscardStashes.length
      ? state.pendingDiscardStashes
      : [];
    const restoredToolStashes = pendingDiscardStashes.length
      ? await restoreToolStashes({
        stashes: pendingDiscardStashes,
        phase: "restoring discarded paths after commit"
      })
      : null;
    if (restoredToolStashes && !restoredToolStashes.ok) {
      const restoreStatus = await collectGitState(config.repoPath);
      const restoreSummary = summarizeGitState(restoreStatus);
      const toolStashes = await listToolStashes();
      const audit = auditRepositoryState({
        action: "commit",
        selectedPaths: paths,
        status: restoreStatus,
        summary: restoreSummary,
        activeRecovery: state.activeRecovery,
        activeSyncStash: state.activeSyncStash,
        toolStashes
      });
      state.blockers = restoreSummary.blockers;
      await setPhase("UserResolutionPending", "tool stash restore failed after commit");
      return {
        ok: false,
        blocked: true,
        message: "commit succeeded, but tool stash restore failed",
        reason: restoredToolStashes.reason,
        add,
        commit,
        restoredToolStashes,
        status: restoreStatus,
        summary: restoreSummary,
        audit,
        toolStashes
      };
    }

    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    const committedPaths = await readHeadChangedPaths();
    const toolStashes = await listToolStashes();
    const audit = auditRepositoryState({
      action: "commit",
      selectedPaths: paths,
      committedPaths,
      status,
      summary,
      activeRecovery: state.activeRecovery,
      activeSyncStash: state.activeSyncStash,
      toolStashes
    });
    state.blockers = summary.blockers;
    await setPhase("Idle", "commit complete");
    return { ok: true, add, commit, restoredToolStashes, status, summary, audit, toolStashes };
  }

  async function discardSelectedFiles(payload = {}) {
    const paths = uniquePaths(payload.paths);
    if (!paths.length) {
      throw new Error("discard requires a non-empty paths array");
    }
    if (!payload.confirmed) {
      state.blockers = ["Discard requires browser confirmation."];
      await setPhase("UserResolutionPending", "discard confirmation required");
      return { ok: false, blocked: true, reason: "discard confirmation required" };
    }

    await setPhase("Discarding", "discarding selected paths into a recovery stash");
    const beforeStatus = await collectGitState(config.repoPath);
    const beforeSummary = summarizeGitState(beforeStatus);
    state.blockers = beforeSummary.blockers;
    if (beforeSummary.rebaseInProgress || beforeSummary.unmergedCount || beforeSummary.blockers.length) {
      await setPhase("UserResolutionPending", "discard blocked by repository state");
      throw new Error(`discard blocked: ${beforeSummary.blockers.join("; ") || "repository is not ready"}`);
    }

    const dirtySet = new Set(dirtyPaths(beforeStatus));
    const discardPaths = paths
      .map((filePath) => pathInsideRepo(config.repoPath, filePath).relative)
      .filter((filePath) => dirtySet.has(filePath));
    if (!discardPaths.length) {
      await setPhase("Idle", "no selected dirty paths to discard");
      return { ok: true, discarded: [], stash: null, status: beforeStatus, summary: beforeSummary };
    }

    const message = `git-safe-commit-tool discard ${new Date().toISOString()}`;
    const stash = await runGit(config.repoPath, ["stash", "push", "--include-untracked", "--message", message, "--", ...discardPaths]);
    if (!stash.ok) {
      await setPhase("UserResolutionPending", "git stash discard failed");
      throw new Error(stash.stderr || stash.stdout || stash.error || "git stash discard failed");
    }
    const sha = await runGit(config.repoPath, ["rev-parse", "--verify", "stash@{0}"]);
    const toolStash = {
      ref: "stash@{0}",
      sha: sha.ok ? sha.stdout.trim() : "",
      subject: `On ${beforeStatus.branch || ""}: ${message}`,
      type: "discard"
    };
    state.pendingDiscardStashes = [toolStash, ...state.pendingDiscardStashes];

    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    await setPhase("Idle", "selected paths discarded");
    return { ok: true, message: "selected paths discarded into a recovery stash", discarded: discardPaths, stash, toolStash, status, summary };
  }

  async function restoreToolStashesAction(payload = {}) {
    const requestedTypes = new Set(
      Array.isArray(payload.types) && payload.types.length
        ? payload.types.map(String)
        : ["discard"]
    );
    const activeSyncStash = await getActiveSyncStash();
    const toolStashes = (await listToolStashes()).filter((stash) => {
      if (activeSyncStash?.sha && stash.sha === activeSyncStash.sha) return false;
      return requestedTypes.has(stash.type);
    });
    if (!toolStashes.length) {
      const status = await collectGitState(config.repoPath);
      const summary = summarizeGitState(status);
      const audit = auditRepositoryState({
        action: "restore-tool-stashes",
        status,
        summary,
        activeRecovery: state.activeRecovery,
        activeSyncStash,
        toolStashes: []
      });
      state.blockers = summary.blockers;
      await setPhase("Idle", "no tool stashes to restore");
      return { ok: true, message: "no tool stashes to restore", restoredToolStashes: { ok: true, restored: [] }, status, summary, audit, toolStashes: [] };
    }

    const restoredToolStashes = await restoreToolStashes({
      stashes: toolStashes,
      phase: "restoring tool-created stash entries"
    });
    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    const remainingToolStashes = await listToolStashes();
    const audit = auditRepositoryState({
      action: "restore-tool-stashes",
      status,
      summary,
      activeRecovery: state.activeRecovery,
      activeSyncStash: state.activeSyncStash,
      toolStashes: remainingToolStashes
    });
    state.blockers = summary.blockers;
    if (!restoredToolStashes.ok) {
      await setPhase("UserResolutionPending", "tool stash restore failed");
      return {
        ok: false,
        blocked: true,
        message: "tool stash restore failed",
        reason: restoredToolStashes.reason,
        restoredToolStashes,
        status,
        summary,
        audit,
        toolStashes: remainingToolStashes
      };
    }
    await setPhase("Idle", "tool stashes restored and cleaned");
    return {
      ok: true,
      message: "tool stashes restored and cleaned",
      restoredToolStashes,
      status,
      summary,
      audit,
      toolStashes: remainingToolStashes
    };
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

    const syncStash = await getActiveSyncStash();
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

    const syncStash = await getActiveSyncStash();
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

  async function pushDirect(payload = {}, options = {}) {
    const allowDirtyStash = Boolean(options.allowDirtyStash);
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
    if (!beforeSummary.cleanWorktree && !allowDirtyStash) {
      await setPhase("UserResolutionPending", "push requires clean worktree");
      throw new Error(cleanWorktreePushError(beforeStatus));
    }
    if (config.workflow?.requireConfirmBeforePush && !payload.confirmed) {
      state.blockers = ["Push requires browser confirmation."];
      await setPhase("UserResolutionPending", "push confirmation required");
      return { ok: false, blocked: true, reason: "push confirmation required", status: beforeStatus, summary: beforeSummary };
    }

    if (!beforeSummary.cleanWorktree) {
      return pushWithTemporaryStash({ beforeStatus, beforeSummary });
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

  async function pushWithTemporaryStash({ beforeStatus, beforeSummary }) {
    await setPhase("RecoveryCreating", "creating recovery before temporary push stash");
    const recovery = await createRecovery(config.repoPath);
    state.activeRecovery = recovery;
    const syncStash = await stashForSync(recovery.timestamp, recovery);
    state.activeSyncStash = syncStash;

    const pushPreflight = await guardPushPreflight();
    if (pushPreflight.blocked) {
      const stashRestore = await restoreSyncStash(syncStash);
      if (stashRestore && !stashRestore.apply.ok) {
        const restoreStatus = await collectGitState(config.repoPath);
        const restoreSummary = summarizeGitState(restoreStatus);
        state.blockers = restoreSummary.blockers;
        await setPhase("UserResolutionPending", "temporary stash restore failed before push");
        return {
          ok: false,
          blocked: true,
          message: "push blocked, and temporary stash restore failed",
          reason: stashRestore.apply.stderr || stashRestore.apply.stdout || stashRestore.apply.error || "temporary stash restore failed",
          fetch: pushPreflight.fetch,
          recovery,
          syncStash: { ...syncStash, ...stashRestore },
          status: restoreStatus,
          summary: restoreSummary
        };
      }
      state.activeSyncStash = null;
      const recoveryCleanup = await cleanupRecovery(recovery);
      return { ...pushPreflight, recovery, recoveryCleanup, syncStash: { ...syncStash, ...stashRestore }, status: beforeStatus, summary: beforeSummary };
    }

    await setPhase("Pushing", "pushing branch with temporary worktree stash");
    const push = await runGit(config.repoPath, ["push"]);
    const stashRestore = await restoreSyncStash(syncStash);
    if (stashRestore && !stashRestore.apply.ok) {
      const restoreStatus = await collectGitState(config.repoPath);
      const restoreSummary = summarizeGitState(restoreStatus);
      state.blockers = restoreSummary.blockers;
      await setPhase("UserResolutionPending", "temporary stash restore failed after push");
      return {
        ok: false,
        blocked: true,
        message: push.ok ? "push succeeded, but temporary stash restore failed" : "push failed, and temporary stash restore failed",
        reason: stashRestore.apply.stderr || stashRestore.apply.stdout || stashRestore.apply.error || "temporary stash restore failed",
        push,
        recovery,
        syncStash: { ...syncStash, ...stashRestore },
        status: restoreStatus,
        summary: restoreSummary
      };
    }
    state.activeSyncStash = null;
    if (!push.ok) {
      if (isRemoteAdvancedPushFailure(push)) {
        const blocked = await remoteAdvancedPushResult({ push });
        const recoveryCleanup = await cleanupRecovery(recovery);
        return { ...blocked, recovery, recoveryCleanup, syncStash: { ...syncStash, ...stashRestore } };
      }
      await setPhase("UserResolutionPending", "git push failed");
      throw new Error(push.stderr || push.stdout || push.error || "git push failed");
    }

    const recoveryCleanup = await cleanupRecovery(recovery);
    const status = await collectGitState(config.repoPath);
    const summary = summarizeGitState(status);
    state.blockers = summary.blockers;
    await setPhase("Idle", "push complete");
    return { ok: true, message: "push complete", push, recovery, recoveryCleanup, syncStash: { ...syncStash, ...stashRestore }, status, summary };
  }

  async function syncAndPush(payload = {}) {
    const syncs = [];
    let lastBlocked = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pushed = await pushDirect(payload, { allowDirtyStash: true });
      if (pushed.ok) {
        return {
          ok: true,
          message: "AI sync and push complete",
          push: pushed.push,
          recovery: pushed.recovery,
          recoveryCleanup: pushed.recoveryCleanup,
          syncStash: pushed.syncStash,
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
        const status = await collectGitState(config.repoPath);
        const summary = summarizeGitState(status);
        state.blockers = summary.blockers;
        if (!summary.cleanWorktree) {
          await setPhase("UserResolutionPending", "git_rebase requires clean worktree");
          throw new Error(`${cleanWorktreePushError(status)} Use the built-in sync_remote path so dirty work can be stashed safely before rebase.`);
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

  async function readHeadChangedPaths() {
    const show = await runGit(config.repoPath, ["show", "--name-only", "--pretty=", "HEAD"]);
    if (!show.ok) return [];
    return show.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  async function listToolStashes() {
    const list = await runGit(config.repoPath, ["stash", "list", "--format=%gd%x00%H%x00%s"]);
    if (!list.ok) return [];
    return list.stdout
      .split(/\r?\n/)
      .map(parseToolStashLine)
      .filter(Boolean);
  }

  async function restoreToolStashes({ stashes = [], phase = "restoring tool-created stashes" } = {}) {
    await setPhase("StashRestoring", phase);
    const restored = [];
    for (const stash of stashes) {
      const resolved = await resolveToolStashRef(stash);
      const restoreRef = stash.sha ? resolved.ref : (resolved.ref || stash.ref);
      const expectedSha = resolved.sha || stash.sha;
      if (!restoreRef) {
        return {
          ok: false,
          reason: "tool stash ref is unavailable",
          restored,
          failed: {
            ...stash,
            apply: {
              ok: false,
              code: 1,
              stdout: "",
              stderr: "tool stash ref is unavailable",
              error: "tool stash ref is unavailable"
            },
            drop: null
          }
        };
      }
      const apply = await runGit(config.repoPath, ["stash", "apply", "--index", restoreRef]);
      if (!apply.ok) {
        return {
          ok: false,
          reason: apply.stderr || apply.stdout || apply.error || "tool stash restore failed",
          restored,
          failed: { ...stash, ref: restoreRef, sha: expectedSha, apply, drop: null }
        };
      }
      const current = await runGit(config.repoPath, ["rev-parse", "--verify", restoreRef]);
      if (expectedSha && current.ok && current.stdout.trim() !== expectedSha) {
        return {
          ok: false,
          reason: "tool stash ref changed before cleanup",
          restored,
          failed: {
            ...stash,
            ref: restoreRef,
            sha: expectedSha,
            apply,
            drop: {
              ok: false,
              code: 1,
              stdout: "",
              stderr: "tool stash ref changed before cleanup",
              error: "tool stash ref changed before cleanup"
            }
          }
        };
      }
      const drop = await runGit(config.repoPath, ["stash", "drop", restoreRef]);
      if (!drop.ok) {
        return {
          ok: false,
          reason: drop.stderr || drop.stdout || drop.error || "tool stash cleanup failed",
          restored,
          failed: { ...stash, ref: restoreRef, sha: expectedSha, apply, drop }
        };
      }
      const restoredEntry = { ...stash, ref: restoreRef, sha: expectedSha, apply, drop };
      restored.push(restoredEntry);
      if (expectedSha) {
        state.pendingDiscardStashes = state.pendingDiscardStashes.filter((entry) => entry.sha !== expectedSha);
      }
    }
    return { ok: true, restored };
  }

  async function resolveToolStashRef(stash) {
    if (stash?.sha) {
      const list = await runGit(config.repoPath, ["stash", "list", "--format=%gd%x00%H"]);
      if (list.ok) {
        for (const line of list.stdout.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const [ref, sha] = line.split("\0");
          if (sha === stash.sha) return { ref, sha };
        }
        return { ref: "", sha: stash.sha };
      }
    }
    return { ref: stash?.ref || "", sha: stash?.sha || "" };
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
    inspectSnapshot,
    state
  };
}

function auditError(message, audit) {
  const error = new Error(message);
  error.audit = audit;
  return error;
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

function uniquePaths(paths = []) {
  return [...new Set(Array.isArray(paths) ? paths.map(String).filter(Boolean) : [])];
}

function isRemoteAdvancedPushFailure(result = {}) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}\n${result.error || ""}`;
  return /fetch first|non-fast-forward|rejected|remote contains work|updates were rejected/i.test(text);
}

function parseToolStashLine(line = "") {
  if (!line.trim()) return null;
  const [ref = "", sha = "", subject = ""] = line.split("\0");
  if (!subject.includes("git-safe-commit-tool ")) return null;
  return {
    ref,
    sha,
    subject,
    type: subject.includes("git-safe-commit-tool discard ")
      ? "discard"
      : subject.includes("git-safe-commit-tool sync ")
        ? "sync"
        : "tool"
  };
}

function toolDefinition(name) {
  return GitSafeCommitTools.find((tool) => tool.function?.name === name);
}
