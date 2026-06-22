import { existsSync } from "node:fs";
import path from "node:path";

import { runGit, validateRepoPath } from "./git-executor.mjs";

export async function collectGitState(repoPath) {
  const repoRoot = validateRepoPath(repoPath);
  const [
    status,
    branch,
    upstream,
    aheadBehind,
    head,
    upstreamHead,
    staged,
    unstaged,
    untracked,
    unmerged,
    unstagedCheck,
    stagedCheck
  ] = await Promise.all([
    runGit(repoRoot, ["status", "--short", "--branch"]),
    runGit(repoRoot, ["branch", "--show-current"]),
    runGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    runGit(repoRoot, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
    runGit(repoRoot, ["rev-parse", "HEAD"]),
    runGit(repoRoot, ["rev-parse", "@{u}"]),
    runGit(repoRoot, ["diff", "--cached", "--name-status"]),
    runGit(repoRoot, ["diff", "--name-status"]),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]),
    runGit(repoRoot, ["ls-files", "-u"]),
    runGit(repoRoot, ["diff", "--check"]),
    runGit(repoRoot, ["diff", "--cached", "--check"])
  ]);

  const counts = aheadBehind.ok ? aheadBehind.stdout.trim().split(/\s+/) : ["0", "0"];
  const changedPaths = unique([
    ...parseNameStatus(staged.stdout).map((item) => item.path),
    ...parseNameStatus(unstaged.stdout).map((item) => item.path),
    ...splitLines(unmerged.stdout).map((line) => line.split(/\s+/).at(-1)),
    ...splitLines(untracked.stdout)
  ].filter(Boolean));
  const markerSearch = changedPaths.length
    ? await runGit(repoRoot, ["grep", "-n", "-I", "-E", "^(<<<<<<< |=======|>>>>>>> )", "--", ...changedPaths])
    : { ok: false, code: 1, stdout: "", stderr: "", command: "git grep markers" };

  const rebaseInProgress = existsSync(path.join(repoRoot, ".git", "rebase-merge"))
    || existsSync(path.join(repoRoot, ".git", "rebase-apply"));
  const stagedItems = parseNameStatus(staged.stdout);
  const unstagedItems = parseNameStatus(unstaged.stdout);
  const untrackedItems = splitLines(untracked.stdout);
  const unmergedItems = parseUnmerged(unmerged.stdout);
  const conflictMarkers = markerSearch.code === 1 ? [] : splitLines(markerSearch.stdout);

  return {
    repoRoot,
    branch: branch.ok ? branch.stdout.trim() : "",
    upstream: upstream.ok ? upstream.stdout.trim() : "",
    head: head.ok ? head.stdout.trim() : "",
    upstreamHead: upstreamHead.ok ? upstreamHead.stdout.trim() : "",
    ahead: Number(counts[0] || 0),
    behind: Number(counts[1] || 0),
    cleanWorktree: !stagedItems.length && !unstagedItems.length && !untrackedItems.length && !unmergedItems.length,
    staged: stagedItems,
    unstaged: unstagedItems,
    untracked: untrackedItems,
    unmerged: unique(unmergedItems.map((item) => item.path)),
    unmergedStages: unmergedItems,
    conflictMarkers,
    rebaseInProgress,
    checks: {
      unstaged: commandView(unstagedCheck),
      staged: commandView(stagedCheck)
    },
    commands: {
      status: commandView(status),
      staged: commandView(staged),
      unstaged: commandView(unstaged),
      untracked: commandView(untracked),
      unmerged: commandView(unmerged),
      markerSearch: commandView(markerSearch)
    }
  };
}

export function summarizeGitState(state) {
  const blockers = [];
  if (!state.upstream) blockers.push("missing upstream");
  if (state.unmerged.length) blockers.push("unmerged files present");
  if (state.conflictMarkers.length) blockers.push("conflict markers present");
  if (!state.checks.unstaged.ok) blockers.push("unstaged diff check failed");
  if (!state.checks.staged.ok) blockers.push("staged diff check failed");

  return {
    branch: state.branch,
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    cleanWorktree: state.cleanWorktree,
    stagedCount: state.staged.length,
    unstagedCount: state.unstaged.length,
    untrackedCount: state.untracked.length,
    unmergedCount: state.unmerged.length,
    markerCount: state.conflictMarkers.length,
    rebaseInProgress: state.rebaseInProgress,
    blockers
  };
}

export function splitLines(text) {
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

export function parseNameStatus(text) {
  return splitLines(text).map((line) => {
    const parts = line.split("\t").filter(Boolean);
    return {
      status: parts[0] || "",
      path: parts.at(-1) || ""
    };
  }).filter((item) => item.path);
}

function parseUnmerged(text) {
  return splitLines(text).map((line) => {
    const parts = line.split(/\s+/);
    return {
      mode: parts[0] || "",
      object: parts[1] || "",
      stage: parts[2] || "",
      path: parts.at(-1) || ""
    };
  }).filter((item) => item.path);
}

function commandView(result) {
  return {
    command: result.command,
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function unique(values) {
  return [...new Set(values)];
}
