#!/usr/bin/env node
import { collectGitState, printJson, summarizeState } from "./git-safe-commit-lib.mjs";

const autoCloseSavedExcel = process.env.GIT_SAFE_COMMIT_AUTOCLOSE_SAVED_EXCEL === "1";
const state = await collectGitState(null, { autoCloseSavedExcel });
const summary = summarizeState(state);
const ahead = Number(summary.ahead || 0);
const behind = Number(summary.behind || 0);

const needsRecoveryBeforeRebase = Boolean(summary.upstream && behind > 0);
const canPushNow = Boolean(
  summary.upstream &&
  ahead > 0 &&
  behind === 0 &&
  summary.cleanWorktree &&
  !summary.rebaseInProgress &&
  !summary.blockers.length
);
const canFastRebase = Boolean(
  summary.upstream &&
  behind > 0 &&
  summary.cleanWorktree &&
  !summary.rebaseInProgress &&
  !summary.blockers.length
);

printJson({
  ok: summary.blockers.length === 0,
  mode: "preflight",
  summary,
  decision: {
    canPushNow,
    canFastRebase,
    needsRecoveryBeforeRebase,
    shouldEscalate: !summary.cleanWorktree || summary.blockers.length > 0 || (ahead > 0 && behind > 0),
    reason: summary.blockers.length
      ? summary.blockers.join("; ")
      : canPushNow
        ? "push gate can be checked next"
        : canFastRebase
          ? "create recovery, fetch --prune, then rebase @{u}"
          : "no push needed or manual review needed"
  },
  details: {
    status: state.status.stdout.trim(),
    staged: state.staged,
    unstaged: state.unstaged,
    untracked: state.untracked,
    unmerged: state.unmerged,
    conflictMarkers: state.conflictMarkers,
    excel: state.excel,
    rebaseTarget: state.rebaseTarget,
    diffCheck: {
      unstagedOk: state.checks.unstaged.ok,
      unstagedOutput: `${state.checks.unstaged.stdout}${state.checks.unstaged.stderr}`.trim(),
      stagedOk: state.checks.staged.ok,
      stagedOutput: `${state.checks.staged.stdout}${state.checks.staged.stderr}`.trim()
    }
  }
});
