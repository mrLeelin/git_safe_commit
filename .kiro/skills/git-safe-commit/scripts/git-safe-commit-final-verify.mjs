#!/usr/bin/env node
import { collectGitState, printJson, summarizeState } from "./git-safe-commit-lib.mjs";

const state = await collectGitState();
const summary = summarizeState(state);
const headEqualsUpstream = Boolean(state.head && state.upstreamHead && state.head === state.upstreamHead);
const complete = Boolean(
  summary.upstream &&
  headEqualsUpstream &&
  summary.ahead === "0" &&
  summary.behind === "0" &&
  summary.cleanWorktree &&
  !summary.rebaseInProgress &&
  !summary.blockers.length
);

printJson({
  ok: complete,
  mode: "final-verify",
  summary: {
    ...summary,
    head: state.head,
    upstreamHead: state.upstreamHead,
    headEqualsUpstream,
    complete
  },
  blockers: [
    ...summary.blockers,
    ...(headEqualsUpstream ? [] : ["HEAD does not equal upstream"]),
    ...(summary.ahead === "0" && summary.behind === "0" ? [] : ["ahead/behind is not 0/0"]),
    ...(summary.cleanWorktree ? [] : ["worktree is not clean"]),
    ...(summary.rebaseInProgress ? ["rebase state remains"] : [])
  ],
  details: {
    status: state.status.stdout.trim(),
    staged: state.staged,
    unstaged: state.unstaged,
    untracked: state.untracked,
    unmerged: state.unmerged,
    conflictMarkers: state.conflictMarkers
  }
});
