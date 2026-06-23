import { runAiToolLoop } from "./ai-decider.mjs";
import { runGit } from "./git-executor.mjs";
import { collectGitState, summarizeGitState } from "./git-state.mjs";
import { createRecovery } from "./recovery.mjs";
import { GitSafeCommitTools, SystemPrompt } from "./tool-definitions.mjs";

export function createWorkflowRunner({ config, emit = () => {}, fetchImpl } = {}) {
  const state = {
    phase: "Idle",
    activeRecovery: null,
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
    if (action === "commit") {
      return commitSelectedFiles(payload);
    }
    if (action === "ai-push" || action === "ai-sync" || action === "ai-commit") {
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

  async function runAiAction(action, payload) {
    await setPhase("Inspecting", `starting ${action}`);
    const result = await runAiToolLoop({
      config,
      messages: [
        { role: "system", content: SystemPrompt },
        { role: "user", content: JSON.stringify({ action, payload }) }
      ],
      tools: GitSafeCommitTools,
      handlers: createToolHandlers({ action, payload }),
      fetchImpl,
      onEvent: emit
    });
    await setPhase("Idle", "AI action complete");
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
        if (config.workflow?.requireConfirmBeforePush && !confirmed) {
          state.blockers = ["Push requires browser confirmation."];
          await setPhase("UserResolutionPending", "push confirmation required");
          return { blocked: true, reason: "push confirmation required" };
        }
        return runGit(config.repoPath, ["push"]);
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

  async function setPhase(phase, note = "") {
    state.phase = phase;
    state.note = note;
    emit("phase", { phase, note });
  }

  return {
    run,
    state
  };
}
