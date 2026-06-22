import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runGit, validateRepoPath } from "./git-executor.mjs";

export async function createRecovery(repoPath, options = {}) {
  const repoRoot = validateRepoPath(repoPath);
  const timestamp = options.timestamp || makeTimestamp();
  const backupBranch = `backup/git-safe-commit-tool/${timestamp}`;
  const backupDir = path.join(".git", "git-safe-commit-tool-backups", timestamp);
  const absoluteBackupDir = path.join(repoRoot, backupDir);
  await mkdir(absoluteBackupDir, { recursive: true });

  const [
    status,
    head,
    stagedPatch,
    unstagedPatch,
    untrackedManifest
  ] = await Promise.all([
    runGit(repoRoot, ["status", "--short", "--branch"]),
    runGit(repoRoot, ["rev-parse", "HEAD"]),
    runGit(repoRoot, ["diff", "--cached", "--binary"]),
    runGit(repoRoot, ["diff", "--binary"]),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"])
  ]);

  await writeFile(path.join(absoluteBackupDir, "status.txt"), status.stdout, "utf8");
  await writeFile(path.join(absoluteBackupDir, "head.txt"), head.stdout, "utf8");
  await writeFile(path.join(absoluteBackupDir, "staged.patch"), stagedPatch.stdout, "utf8");
  await writeFile(path.join(absoluteBackupDir, "unstaged.patch"), unstagedPatch.stdout, "utf8");
  await writeFile(path.join(absoluteBackupDir, "untracked-manifest.txt"), untrackedManifest.stdout, "utf8");

  const branch = await runGit(repoRoot, ["branch", backupBranch, "HEAD"]);
  const dirty = Boolean(status.stdout.split(/\r?\n/).some((line) => line && !line.startsWith("##")));
  let stashRef = "";
  let stash = null;
  if (dirty) {
    stash = await runGit(repoRoot, ["stash", "push", "--include-untracked", "-m", `git-safe-commit-tool: ${timestamp}`]);
    const list = await runGit(repoRoot, ["stash", "list"]);
    stashRef = list.stdout.split(/\r?\n/).find((line) => line.includes(`git-safe-commit-tool: ${timestamp}`))?.split(":")[0] || "";
  }

  return {
    timestamp,
    backupBranch,
    backupDir: backupDir.replaceAll("\\", "/"),
    statusFile: path.join(backupDir, "status.txt").replaceAll("\\", "/"),
    headFile: path.join(backupDir, "head.txt").replaceAll("\\", "/"),
    stagedPatch: path.join(backupDir, "staged.patch").replaceAll("\\", "/"),
    unstagedPatch: path.join(backupDir, "unstaged.patch").replaceAll("\\", "/"),
    untrackedManifest: path.join(backupDir, "untracked-manifest.txt").replaceAll("\\", "/"),
    stashRef,
    commands: {
      status,
      head,
      branch,
      stash
    }
  };
}

function makeTimestamp() {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
