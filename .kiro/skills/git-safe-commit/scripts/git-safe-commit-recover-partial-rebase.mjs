#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { findRepoRoot, printJson, runGit, runGitBuffer } from "./git-safe-commit-lib.mjs";

const repoRoot = await findRepoRoot();
const backupBranch = process.argv[2] || process.env.GIT_SAFE_COMMIT_BACKUP_BRANCH || "";
const expectedHead = process.env.GIT_SAFE_COMMIT_EXPECTED_HEAD || "";
const ts = timestamp();
const evidenceDir = path.join(repoRoot, ".git", "git-safe-commit-backups", `partial-rebase-${ts}`);

await mkdir(evidenceDir, { recursive: true });

const status = await runGit(["status", "--short", "--branch"], { cwd: repoRoot });
const head = await runGit(["rev-parse", "HEAD"], { cwd: repoRoot });
const upstream = await runGit(["rev-parse", "@{u}"], { cwd: repoRoot });
const unmerged = await runGit(["ls-files", "-u"], { cwd: repoRoot });
const stagedPatch = await runGitBuffer(["diff", "--cached", "--binary"], { cwd: repoRoot });
const unstagedPatch = await runGitBuffer(["diff", "--binary"], { cwd: repoRoot });

await writeFile(path.join(evidenceDir, "status.txt"), status.stdout, "utf8");
await writeFile(path.join(evidenceDir, "head.txt"), `HEAD ${head.stdout.trim()}\nUPSTREAM ${upstream.ok ? upstream.stdout.trim() : ""}\n`, "utf8");
await writeFile(path.join(evidenceDir, "unmerged.txt"), unmerged.stdout, "utf8");
await writeFile(path.join(evidenceDir, "staged.patch"), stagedPatch.stdout, "utf8");
await writeFile(path.join(evidenceDir, "unstaged.patch"), unstagedPatch.stdout, "utf8");

const rebaseMerge = path.join(repoRoot, ".git", "rebase-merge");
const rebaseApply = path.join(repoRoot, ".git", "rebase-apply");
const rebaseInProgress = existsSync(rebaseMerge) || existsSync(rebaseApply);
const blockers = [];

if (rebaseInProgress) {
  blockers.push("rebase metadata exists; inspect status and prefer git rebase --abort before partial-checkout recovery");
}
if (!backupBranch) {
  blockers.push("backup branch is required as argv[2] or GIT_SAFE_COMMIT_BACKUP_BRANCH");
}
if (expectedHead && head.stdout.trim() !== expectedHead) {
  blockers.push(`HEAD moved: expected ${expectedHead}, actual ${head.stdout.trim()}`);
}

let restore = null;
if (!blockers.length) {
  const branchCheck = await runGit(["rev-parse", "--verify", backupBranch], { cwd: repoRoot });
  if (!branchCheck.ok) {
    blockers.push(`backup branch not found: ${backupBranch}`);
  } else {
    restore = await runGit(["restore", "--source", backupBranch, "--worktree", "--staged", "--", "."], {
      cwd: repoRoot
    });
    if (!restore.ok) {
      blockers.push("path-level restore from backup branch failed");
    }
  }
}

const after = await runGit(["status", "--short", "--branch"], { cwd: repoRoot });
await writeFile(path.join(evidenceDir, "after-status.txt"), after.stdout, "utf8");

printJson({
  ok: blockers.length === 0,
  mode: "recover-partial-rebase",
  evidenceDir: path.relative(repoRoot, evidenceDir).replaceAll("\\", "/"),
  backupBranch,
  expectedHead,
  head: head.stdout.trim(),
  rebaseInProgress,
  blockers,
  commands: {
    restore
  },
  beforeStatus: status.stdout.trim(),
  afterStatus: after.stdout.trim()
});

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
