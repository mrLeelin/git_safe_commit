---
name: git-safe-commit
description: Use this skill when Codex needs to safely commit, explicitly merge a named branch, rebase, resolve conflicts, or push Git changes without losing local files, without creating git pull merge commits, without committing unrelated staged files, and with HTML observer plus guardrail support for recovery points, logs, Excel/binary conflicts, and multi-agent verification.
---

# Git Safe Commit

## Contract

AI is the Git executor. The script is a guardrail and evidence recorder. The HTML page is an observer and user confirmation surface.

Do not let the HTML page or script make semantic Git decisions. Do not use a button to rebase, continue, commit, or push. Codex must run those Git commands directly, after the guard checks and recovery points are in place.

At the start of every `$git-safe-commit` run, ensure the observer is running from the current repository root:

```bash
node .kiro/skills/git-safe-commit/scripts/git-safe-commit-ensure-server.mjs
```

The ensure script checks `http://127.0.0.1:17371/api/info`. If the guard is not running, it starts it. If the guard is running for the same repo/skill but is stale, it restarts it so the HTML uses the latest local assets and scripts. If another non-guard process owns the port, stop and report the blocker instead of killing it.

Open:

```text
http://127.0.0.1:17371
```

The observer records local evidence under `.git/git-safe-commit-backups/`. These files are local Git metadata and must not be committed.

## Fast Safe Mode

Default to fast safe mode unless the user asks for a detailed audit.

Fast safe mode changes reporting and command batching only. It does not remove safety gates.

Use scripts for mechanical checks before falling back to individual Git commands:

```bash
node .kiro/skills/git-safe-commit/scripts/git-safe-commit-preflight.mjs
node .kiro/skills/git-safe-commit/scripts/git-safe-commit-final-verify.mjs
```

The preflight and final-verify scripts are read-only. They must not execute `rebase`, `git add`, `commit`, or `push`. The observer server is not read-only: its recovery endpoints may create local backup branches, stash entries, patches, and recovery metadata under `.git/`. AI still owns decisions and main-flow Git execution.

Use concise stage updates:

```text
Inspect -> Recovery -> Sync/Rebase -> Conflict or Push -> Verify
```

For explicit merge mode, use:

```text
Inspect -> Recovery -> Merge -> Conflict or Commit -> Verify
```

If the scripts are unavailable, batch read-only checks manually:

```bash
git status --short --branch
git rev-parse --abbrev-ref --symbolic-full-name '@{u}'
git rev-list --left-right --count 'HEAD...@{u}'
git diff --cached --name-status
git diff --name-status
git ls-files --others --exclude-standard
git ls-files -u
```

Keep observer writes brief. Prefer one state update per phase, not one update per command.

Do not print long JSON, full diffs, or full logs during the happy path. Summarize:

- branch and upstream
- ahead/behind
- recovery id
- conflict paths, if any
- final HEAD/upstream equality

Escalate out of fast mode and explain details when any of these appear:

- staged files are non-empty before scope review
- unstaged or untracked files exist
- upstream is missing
- ahead and behind are both non-zero
- rebase or stash apply creates conflicts
- `git ls-files -u` is non-empty
- conflict markers exist
- Excel, Unity binary assets, images, audio, prefab/scene/material/meta, or other high-risk files are involved
- the same staged Excel file is open in Excel or fails exclusive lock check; unrelated open workbooks do not block
- a file that the next rebase will overwrite is an Excel/high-risk file and that exact file is open or fails exclusive lock check
- push is rejected
- command output is ambiguous

Even in fast mode, always keep these gates:

- create recovery before any rebase
- use `git-safe-commit-preflight.mjs` before deciding whether to rebase, commit, or push
- use `git-safe-commit-final-verify.mjs` before reporting completion after push
- never use `git pull`
- never push with unresolved conflicts or markers
- never commit unrelated staged files
- never auto-resolve binary or Excel conflicts
- never commit or rebase a staged Excel file while that exact file is open or locked by Excel; Excel running with unrelated workbooks is not a blocker
- never rebase across an upstream Excel file that would overwrite the working tree while that exact workbook is open or locked
- only auto-close Excel/WPS/ET workbooks when the guard can match the exact absolute workbook path and positively read `Saved=true`; never kill Office processes and never close a workbook with unknown path or unknown saved state
- verify final ahead/behind and rebase state before reporting completion

## Push Fast Path

When the user requests a **push-only** operation and there is no commit scope to review, use a narrow push path only if the worktree is already clean and the branch is ahead of upstream with zero behind commits.

**Trigger**: User says "推送" / "push", no new commit is needed, `git-safe-commit-preflight.mjs` reports a clean worktree, upstream exists, `ahead > 0`, and `behind == 0`.

**Flow**:

```text
1. node .kiro/skills/git-safe-commit/scripts/git-safe-commit-preflight.mjs
2. git fetch --prune
3. git rev-list --left-right --count 'HEAD...@{u}'
4. git push
5. node .kiro/skills/git-safe-commit/scripts/git-safe-commit-final-verify.mjs
```

**Rules**:
- Do NOT stash local changes in this fast path.
- Do NOT use `git stash pop`.
- Do NOT use this fast path when the worktree has staged, unstaged, untracked, or unmerged files.
- Do NOT use this fast path when the branch is behind upstream or ahead/behind are both non-zero.
- If fetch shows the remote advanced, switch to the detailed flow and create recovery before any rebase.
- If push is rejected, switch to the detailed flow and create recovery before any rebase.
- If final verification fails only because unrelated local changes appeared after the push, report that explicitly instead of cleaning or dropping them.

**Escalation to detailed flow**: Any dirty worktree, missing upstream, remote advancement, conflict, push rejection, or ambiguous command output switches to the full observer-based process.

## Explicit Merge Mode

Use this mode only when the user explicitly asks to merge a branch. Valid triggers include:

- `merge <branch-name>`
- `合并 <branch-name>`
- `把 <branch-name> merge 进来`
- `把 <branch-name> 合并进来`

Do not infer merge mode from generic words like "sync", "update", "pull", "提交", "push", or "解决冲突". If the user does not explicitly say `merge` or `合并`, stay on the normal non-merge workflow.

Merge mode is intentionally not a rebase workflow. Once merge mode is triggered:

- Do NOT run `git rebase`.
- Do NOT run `git pull`.
- Do NOT run `git merge` without a named source branch.
- Do NOT use merge mode to replace the default sync/rebase path.
- Do create recovery before the merge when local changes, staged files, high-risk files, or remote movement could be affected.
- Do use the same observer, recovery, scope review, Excel/binary conflict exports, and text conflict workbench as the normal workflow.
- Do finish a clean or resolved merge with the merge commit that Git expects, after staged scope and conflict checks pass.

**Flow**:

```text
1. node .kiro/skills/git-safe-commit/scripts/git-safe-commit-preflight.mjs
2. git fetch --prune
3. create recovery through POST /api/recovery/create when the worktree is dirty, staged files exist, high-risk paths are involved, or any merge risk is visible
4. git merge --no-ff <branch-name>
5. if conflicts appear, use the Conflict Workflow
6. verify no unmerged files or conflict markers remain
7. git status --short --branch
8. git diff --cached --name-status
9. git commit, when Git has not already created the merge commit
10. optional git push, only if requested or already part of the user's commit/push request
11. node .kiro/skills/git-safe-commit/scripts/git-safe-commit-final-verify.mjs, or manual final verification for intentionally dirty worktrees
```

**Merge conflict completion**:

- During merge mode, never use `git rebase --continue`.
- After resolving conflicts, stage only resolved merge paths with `git add -- <path>`.
- Re-check `git ls-files -u`, conflict markers, `git diff --cached --check`, and staged scope before committing.
- Let `git commit` create the merge commit message unless the repository rules require a specific message. If writing a custom message, include the source branch and keep the Lore protocol trailers only when they add useful decision context.

**Compare/conflict workbench in merge mode**:

The HTML text, Excel, and binary workbenches are available for merge conflicts too. They remain candidate/observer surfaces only:

- They must not overwrite conflicted originals unless Codex deliberately copies a confirmed candidate back.
- They must not run `git add`.
- They must not run `git commit`, `git merge --continue`, `git rebase --continue`, or `git push`.
- Codex must apply the confirmed candidate to the conflicted path, run normal conflict verification, then stage the path.
- The same compare workbench can be opened from merge-mode blockers and `git ls-files -u` paths; it is not limited to rebase conflicts.
- Text and table candidates are evidence files under `.git/git-safe-commit-backups/<timestamp>/`, not the final resolution until Codex copies them back and verifies the original conflicted path.

If the merge is not safe to auto-resolve, stop in `UserResolutionPending` and explain the exact conflicted paths and decision needed. Do not fall back to rebase.

## Hard Rules

- Do not run `git pull`.
- Do not run `git merge` unless the user explicitly says `merge` or `合并` and provides a source branch.
- Do not run `git rebase` during explicit merge mode.
- Do not run `git reset --hard`.
- Do not run `git clean`.
- Do not run `git stash pop`; use `git stash apply --index` for recovery restores.
- Do not run `git stash drop` manually; use `POST /api/recovery/cleanup` for cleanup.
- Do not run `git push --force`.
- Use `git push --force-with-lease` only when the user explicitly asks to rewrite the remote branch and branch ownership is clear.
- Do not trust the current staged area. Re-check staged diff against the requested commit scope.
- Do not continue, commit, or push while `git ls-files -u` or conflict marker search still shows unresolved conflicts.
- Do not auto-resolve semantic conflicts. Preserve both sides when compatible; otherwise stop and explain the decision needed.

## Unstaged File Policy

Default handling for unstaged and untracked files is preservation. Do not clean, discard, hide, or fold them into a commit unless the user explicitly scoped those paths.

Use this decision order:

1. **Commit-only task**: leave unstaged and untracked files untouched. Stage only the requested paths with `git add -- <path>`, verify `git diff --cached --name-status`, and commit only that allowlist.
2. **Rebase or push needed while the worktree is dirty**: create recovery first. Use guard recovery, stash, and patch evidence before any rebase. Prefer `git stash apply --index <stash-hash>` or `git apply --index <patch>` for restore; never use `git stash pop`.
3. **Multiple unrelated work items are present**: split by path into separate commits only when provenance is clear. If provenance is unclear, leave those files unstaged and report them.
4. **High-risk files are present**: Unity serialized resources, `.meta`, Prefab, Scene, material, animation/controller assets, Addressables files, Excel, `.bytes`, audio, image, video, archives, signing files, server config, and generated artifacts must be backed up and reported. Do not auto-merge, auto-discard, or stage them unless the user explicitly scoped them.
5. **Discarding local work**: only use `git restore -- <path>` when the user explicitly says to discard that exact path. Do not use `git reset --hard` or `git clean`.

For dirty-repo narrow commits, success means the requested files were committed and the unrelated local work remains untouched. A dirty worktree after the commit is not a failure by itself.

## Roles

### AI Executor

Codex owns:

- Inspecting branch, upstream, ahead/behind, staged, unstaged, untracked, and unmerged files.
- Creating recovery points before any rebase or stash restore.
- Running `git fetch --prune`, `git rebase '@{u}'` in normal mode, `git merge --no-ff <branch>` in explicit merge mode, `git stash apply --index <hash>`, `git add <path>`, `git rebase --continue` in rebase mode, `git commit` in commit or merge mode, and `git push` when gates pass.
- Explaining and resolving text conflicts.
- Selecting exact commit scope with path-level allowlist.
- Stopping for user confirmation on Excel, binary, high-risk resources, unknown provenance, or uncertain semantic conflict choices.

### Guard Script

The server may:

- Read repository status, staged diff, conflict state, and logs.
- Create recovery evidence: backup branch, patch files, untracked manifest, stash hash, status/head snapshots.
- Validate proposed Git commands.
- Export binary conflict `OURS` and `THEIRS`.
- Record AI/user notes and state transitions.

The server must not expose endpoints that execute `rebase`, `git add`, `rebase --continue`, `commit`, or `push`.

### HTML Observer

The HTML page may:

- Show current phase, blockers, branch/upstream status, staged/unstaged/untracked/unmerged files.
- Show recovery point details.
- Show session logs.
- Export and display Excel/binary conflict paths.
- Record user confirmation notes.

The HTML page must not execute the Git main flow.

### Verification Agents

Use read-only agents when the workflow is non-trivial or risky:

- Recovery verifier: confirm backup branch, patches, untracked manifest, stash hash, and session log exist.
- Scope verifier: confirm staged files match the requested allowlist and no unrelated dirty files are included.
- Conflict verifier: confirm no unmerged stages, no conflict markers, and binary conflicts have explicit user confirmation.
- Push verifier: confirm branch/upstream, ahead/behind, post-commit status, and push result.

Only the primary AI executor may mutate Git state.

## State Machine

Use these phases in the observer:

1. `Idle`
2. `Inspecting`
3. `PlanReady`
4. `RecoveryCreated`
5. `Syncing`
6. `Merging`
7. `RestoringLocalWork`
8. `ConflictBlocked`
9. `UserResolutionPending`
10. `ConflictResolvedReview`
11. `ScopeReview`
12. `UserCommitConfirm`
13. `Committed`
14. `Pushing`
15. `Complete`
16. `Aborted`

Never skip from `Idle` or `Inspecting` directly to `Syncing` or `Merging`. Never enter `Merging` unless explicit merge mode is active. Never leave `ConflictBlocked` until all conflicted paths are resolved and verified. Never enter `Committed` until staged scope has passed review.

## Workflow

### 1. Inspect

Fast path:

```bash
node .kiro/skills/git-safe-commit/scripts/git-safe-commit-preflight.mjs
```

The preflight script checks staged `.xlsx`, `.xlsm`, `.xlsb`, and `.xls` files and upstream Excel files that the next rebase would bring into the worktree. Excel/WPS/ET process running alone is not a blocker, and unrelated open workbooks are not blockers. Stop only when an in-scope Excel path matches an open workbook path or fails the exclusive lock check, and tell the user to close that exact file.

**Excel blockers must be reported BEFORE creating recovery.** If preflight reports `summary.blockers` containing Excel lock issues, stop immediately and tell the user which files to close. Do not create recovery, stash, or perform any other operations until the user confirms the files are closed and a re-run of preflight shows `summary.blockers: []`. This avoids wasting time on recovery setup that would need to be discarded.

**Preflight output parsing**: Only extract these fields from the preflight JSON:
- `decision.canPushNow` / `decision.canFastRebase` / `decision.shouldEscalate`
- `summary.ahead` / `summary.behind` / `summary.cleanWorktree`
- `summary.openExcelCount` and `summary.blockers[]`
- `summary.rebaseTargetExcelCount` / `summary.rebaseTargetHighRiskCount`
- `details.rebaseTarget.excelPaths[]` and `details.rebaseTarget.highRiskPaths[]` only when exact path reporting or rebase-risk handling is needed
Do not read or print the full `details` object during the happy path. If exact rebase target paths are required, read only `details.rebaseTarget`.

Optional saved-workbook auto-close:

```bash
GIT_SAFE_COMMIT_AUTOCLOSE_SAVED_EXCEL=1 node .kiro/skills/git-safe-commit/scripts/git-safe-commit-preflight.mjs
```

This may close only an exact-path matched workbook whose COM `Saved` field is `true`. If the guard cannot read `FullName` or `Saved`, or if the workbook is dirty, it must not close anything and must keep the blocker. Do not terminate `EXCEL.exe`, `wps.exe`, or `et.exe`.

Fallback manual checks:

```bash
git status --short --branch
git branch --show-current
git rev-parse --abbrev-ref --symbolic-full-name '@{u}'
git rev-list --left-right --count 'HEAD...@{u}'
git diff --cached --name-status
git diff --name-status
git ls-files --others --exclude-standard
git ls-files -u
```

Stop if there is no upstream or the branch is not the expected branch.

Optionally write observer state:

```http
POST /api/state
{"phase":"Inspecting","note":"reading branch, upstream, dirty files, and conflicts","blockers":[]}
```

### 2. Create Recovery

Before any rebase, create recovery through the guard:

```http
POST /api/recovery/create
{}
```

This creates:

- `backup/git-safe-commit/<timestamp>`
- `.git/git-safe-commit-backups/<timestamp>/status.txt`
- `.git/git-safe-commit-backups/<timestamp>/head.txt`
- `.git/git-safe-commit-backups/<timestamp>/staged.patch`
- `.git/git-safe-commit-backups/<timestamp>/unstaged.patch`（当 `git diff` 为空但 status 有修改时，自动用 `git diff HEAD` 兜底）
- `.git/git-safe-commit-backups/<timestamp>/untracked-manifest.txt`
- stash hash when local changes exist

**必须检查 recovery 返回值**：

- 只有顶层 `ok: true` 不足以证明恢复点可用；必须同时确认 `recovery.timestamp`、`recovery.backupBranch`、`recovery.backupDir`、`recovery.stagedPatch`、`recovery.unstagedPatch`、`recovery.statusFile`、`recovery.headFile` 和 `recovery.untrackedManifest` 均存在。
- 如果 `recovery.stashEmptyWarning` 存在且 `recovery.usedDirtyCommit` 为 false，说明 stash 为空但 status 显示有修改（Windows Git index 不一致问题）。此时 stash 恢复不可用，但 `recovery.unstagedPatch` 已用 `git diff HEAD` 兜底保存了真实差异。AI 必须确认 `unstaged.patch` 文件大小 > 0 后才能继续 rebase。
- 如果 `recovery.dirtyCommitSha` 存在，走 dirty commit 恢复路径；它只是恢复证据，不是 `git reset --hard` 的目标。
- 如果 `recovery.stashHash` 为空且 `recovery.stashEmptyWarning`、`recovery.dirtyCommitSha` 均不存在，说明工作区本身就是干净的或只有可忽略的幻影修改，recovery 仍然有效。

If recovery creation fails, stop. Do not rebase.

**Recovery output parsing**: Only extract these fields from the recovery JSON:
- `ok`: endpoint success only; do not treat it as recovery-completeness proof by itself
- `recovery.timestamp`: recovery id used by backup paths and cleanup
- `recovery.stashHash`: hash for restore (empty if worktree was clean)
- `recovery.backupBranch`: backup branch name
- `recovery.stashEmptyWarning`: presence means stash failed or was unavailable; must verify `recovery.unstagedPatch` size > 0 unless `recovery.usedDirtyCommit` is true
- `recovery.dirtyCommitSha` / `recovery.usedDirtyCommit`: dirty commit recovery evidence
Ignore the `results[]` array details only after the required `recovery.*` fields above are present. If any required recovery field is missing, inspect `results[]`, stop, and do not rebase.

**Post-stash worktree verification**: After recovery creation succeeds and `recovery.stashHash` is saved, immediately run `git status --short` to confirm the worktree is clean. Unity Editor may modify files (e.g. `ProjectSettings.asset`, delete PNGs) between the preflight check and the stash operation. If `git status` shows new changes:
1. Create a second stash that includes untracked files: `git stash push --include-untracked -m "git-safe-commit: post-recovery catchup <recovery.timestamp>-2"`
2. Record both stash hashes in the observer log/final report. The guard recovery object has one `stashHash`, so the catchup stash hash must be tracked explicitly by Codex.
3. After rebase, restore with `git stash apply --index <recovery.stashHash>` first, then `git stash apply --index <catchup-stash-hash>`.
4. If both stashes modify the same file, do not let the catchup stash overwrite the original recovery stash version. Inspect the catchup diff, manually reapply only non-overlapping changes when safe, and report any skipped catchup changes.

### 3. Sync Without Merge Commit

Ask guard to validate the command, then AI executes:

```bash
git fetch --prune
git rebase '@{u}'
```

This step is for normal non-merge operation only. If explicit merge mode is active, skip this rebase step and use `git merge --no-ff <branch-name>` as described in Explicit Merge Mode.

If rebase conflicts, enter the conflict workflow.

If `git rebase '@{u}'` fails before detaching HEAD with an unlink/invalid-argument error, treat it as a partial checkout failure, not a merge conflict. Preserve evidence first, then recover from the backup branch without `git reset --hard`:

```bash
node .kiro/skills/git-safe-commit/scripts/git-safe-commit-recover-partial-rebase.mjs backup/git-safe-commit/<timestamp>
```

Only use this recovery when no `.git/rebase-merge` or `.git/rebase-apply` state exists and HEAD still equals the pre-rebase HEAD. The script saves status, HEAD, unmerged stages, and binary patches under `.git/git-safe-commit-backups/partial-rebase-*`, then restores the index and worktree from the backup branch with path-level `git restore --source <backup-branch> --worktree --staged -- .`.

### 4. Restore Local Work

根据 recovery 类型选择对应路径：

**路径 A — 有 stashHash（正常路径）：**

```bash
git stash apply --index <stash-hash>
```

Use `apply`, never `pop`.

**路径 B — 有 dirtyCommitSha（dirty commit 路径）：**

`dirtyCommitSha` 是恢复证据和人工核对入口，不是自动恢复命令。不要执行 `git reset --hard <dirtyCommitSha>`。恢复本地改动时先检查 recovery 返回值和当前状态；如果没有可用 `stashHash`，使用 patch 方案恢复：

```bash
git apply --index <unstaged.patch>
```

如果 patch apply 失败，停止并检查 backup branch、dirty commit、patch 文件和当前 `git status`。不要用 hard reset 覆盖工作区。

**路径 C — stashHash 和 dirtyCommitSha 均为空（幻影修改或干净工作区）：**

无需恢复，工作区已是最新状态。

如果 stash restore 或 patch apply 产生冲突，这是 restore conflict，不是 rebase conflict。解决后回到 scope review。

### 5. Review Commit Scope

Run:

```bash
git status --short --branch
git diff --name-only
git diff --cached --name-only
git diff --cached --stat
git diff --cached
```

If unstaged or untracked files exist, classify them before staging:

- requested scope: may be staged
- unrelated local work: leave untouched
- unknown provenance: leave untouched and report
- high-risk resource or binary: leave untouched unless explicitly scoped

Stage only requested files:

```bash
git add -- <path>
git restore --staged -- <path>
```

Do not commit if staged diff includes unrelated changes, unknown provenance, secrets, generated artifacts outside scope, unresolved conflicts, or high-risk resources not explicitly confirmed.

### 6. Commit

Use the repository's commit-message rules. For JellybeanUnity, prefer the Lore Commit Protocol when appropriate:

```text
<intent line: why the change was made>

Constraint: <external constraint>
Rejected: <alternative> | <reason>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Directive: <forward-looking warning>
Tested: <what was verified>
Not-tested: <known gaps>
```

After commit:

```bash
git status --short --branch
git rev-parse HEAD
node .kiro/skills/git-safe-commit/scripts/git-safe-commit-preflight.mjs
```

### 7. Push

Run:

```bash
git push
```

If push is rejected because the remote advanced, do not force push. Repeat fetch plus rebase after verifying recovery and state.

**"Everything up-to-date" is a valid success.** After rebase, if local commit content matches the remote (same tree SHA), `git push` reports "Everything up-to-date" with exit code 0. This is normal and means synchronization is complete. Verify with `git rev-list --left-right --count 'HEAD...@{u}'` — `0 0` confirms success.

### 8. Completion Report

Before reporting completion, run:

```bash
node .kiro/skills/git-safe-commit/scripts/git-safe-commit-final-verify.mjs
```

`final-verify` currently proves the strongest condition: HEAD equals upstream, ahead/behind is `0/0`, no rebase is active, no blockers exist, and the worktree is clean. For narrow commits in a dirty repository, this script may return `complete: false` after a successful push because unrelated local work is intentionally preserved. In that case, manually verify and report:

- the pushed commit exists on upstream
- ahead/behind is `0/0`
- no rebase is active
- no unmerged files or conflict markers exist
- staged files are empty or match only the next explicitly requested scope
- remaining dirty files are unrelated preserved local work

Report:

- branch and upstream
- backup branch
- stash hash or no stash created
- patch backup directory
- files committed
- commit hash
- push result
- verification run
- remaining recovery points
- unresolved risks

**verification 通过后，自动清理恢复点**（仅当 `final-verify` 返回 `complete: true`，或 dirty-repo narrow commit 的手工验证项全部通过时执行）：

```http
POST /api/recovery/cleanup
{}
```

此接口只清理当前 session 创建的恢复点（备份分支、stash、备份目录），不影响其他 session 的恢复点。

**如果 verification 失败且不能用 dirty-repo narrow commit 手工验证解释，或 push 出错，绝对不要调用 cleanup**——恢复点是出错后的回退保障。

## Conflict Workflow

### Detect

Run:

```bash
git status
git diff --name-only --diff-filter=U
git ls-files -u
```

List every conflicted file.

### LLM Text Conflict Auto-Resolve

Use the primary Codex LLM as the first resolver for safe code and plain-text conflicts. Do not require user confirmation before trying this path when recovery has already been created and the file is inside the auto-resolve allowlist.

Auto-resolve allowlist:

- C# and common code files: `.cs`, `.asmdef`, `.asmref`, `.js`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.py`, `.ps1`, `.sh`, `.bat`, `.cmd`, `.java`, `.kt`, `.cpp`, `.h`, `.hpp`, `.c`, `.go`, `.rs`.
- Plain text/config files: `.md`, `.txt`, `.json`, `.jsonc`, `.xml`, `.yml`, `.yaml`, `.toml`, `.ini`, `.editorconfig`, `.gitignore`, `.gitattributes`.
- Shader/source-like Unity text files only when they are hand-authored code: `.shader`, `.hlsl`, `.cginc`, `.compute`, `.uss`, `.uxml`.

Never auto-resolve these paths or extensions even when Git reports them as text:

- Unity serialized resources: `.prefab`, `.unity`, `.mat`, `.anim`, `.controller`, `.overrideController`, `.asset`, `.playable`, `.meta`.
- Addressables, build, generated, or published artifacts unless the user explicitly scoped them for this commit.
- Excel and binary files: `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, images, audio, video, archives, DLLs, `.bytes`.
- Luban generated data/code when the source table or generator has not been confirmed.
- Secrets, signing files, server config, lock files, or files whose semantics depend on external tooling.

For each allowlisted conflicted file, the LLM resolver must:

1. Read surrounding code, not only the marker block.
2. Identify both sides' intent.
3. Preserve both sides when compatible.
4. Choose one side only when local code evidence supports that choice.
5. Keep the edit scoped to the conflict and required surrounding fixes.
6. Remove all `<<<<<<<`, `=======`, and `>>>>>>>` markers.
7. Run the smallest relevant check before staging.

Escalate to the user instead of applying a resolution when:

- The conflict requires product, design, economy, gameplay, release, or data-ownership judgment.
- Both sides make incompatible semantic changes and the correct behavior is not inferable from local code.
- The file is outside the allowlist or matches the denylist.
- The resolution would require broad refactoring, generated artifact updates, or Unity resource rebinding.
- Validation fails after the LLM attempt.

If the first LLM attempt leaves conflict markers, compilation-breaking syntax, or unclear behavior, retry once with the concrete validation error and file context. After two failed attempts, open the HTML text merge workbench for the conflicted path when it is inside the text allowlist. The workbench shows BASE, OURS, THEIRS, and the current marked file, lets the user choose one side or edit a candidate, and writes only a candidate file under `.git/git-safe-commit-backups/<timestamp>/text-merge-candidates/`. It must not overwrite the conflicted original path, must not run `git add`, and must not continue rebase, commit, or push. Codex must copy the confirmed candidate back to the original path and run the normal conflict verification before staging.

The text merge workbench applies to both rebase conflicts and explicit merge conflicts. The continuation command depends on the active mode: `git rebase --continue` only for rebase mode, and `git commit` for explicit merge mode.

Useful commands:

```bash
git diff -- <path>
git checkout --ours -- <path>
git checkout --theirs -- <path>
git add -- <path>
```

Use `--ours` or `--theirs` only with an explanation. Prefer an integrated LLM merge over whole-file side selection for allowlisted text files.

Before staging an auto-resolved file:

```bash
git diff --check
git diff -- <path> | grep -E '^(<<<<<<<|=======|>>>>>>>)'
git diff -- <path>
```

Then stage only the resolved file:

```bash
git add -- <path>
git ls-files -u -- <path>
```

Before continuing a rebase:

```bash
git ls-files -u
git diff --cached --check
git diff
git diff --cached
```

Continue rebase only when all conflicts are resolved and staged:

```bash
git rebase --continue
```

In explicit merge mode, do not run `git rebase --continue`. After all conflicts are resolved and staged, run the merge completion check:

```bash
git ls-files -u
git diff --cached --check
git status --short --branch
git diff --cached --name-status
```

Then finish the merge with:

```bash
git commit
```

### Excel and Binary Conflicts

Treat `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, Unity binary assets, images, audio, and other binary files as non-mergeable unless there is a known safe domain tool.

#### Step 1: 导出两边版本 / 打开 Excel 工作台

For generic binary conflicts, export both sides through the observer:

```http
POST /api/binary-conflict/export
{"path":"<conflicted-path>"}
```

The guard writes:

```text
.git/git-safe-commit-backups/<timestamp>/binary-conflicts/<filename>.ours<ext>
.git/git-safe-commit-backups/<timestamp>/binary-conflicts/<filename>.theirs<ext>
```

For `.xlsx` conflicts, prefer the HTML Excel workbench:

```http
POST /api/excel-conflict/load
{"path":"<conflicted-path>"}
```

The guard exports `OURS` and `THEIRS`, parses the workbook, and shows both sides in the HTML page. The page remains an observer/confirmation surface: it must not run `git add`, `rebase --continue`, `commit`, or `push`.

The Excel compare workbench applies to both rebase conflicts and explicit merge conflicts. Its candidate file is only a proposed workbook; Codex or the user must place the confirmed workbook at the original conflicted path, then Codex verifies and stages it.

Supported workbench scope:

- `.xlsx` only.
- Same sheet count, names, and order are required before candidate generation is enabled.
- `.xlsm`, `.xlsb`, `.xls`, or sheet structure mismatches must fall back to exported files and manual Excel/WPS handling.

#### Step 2: 用户在 HTML 中选择行或单元格

The workbench shows:

- sheet tabs
- left `OURS`, right `THEIRS`
- highlighted conflicting cells
- row-level choices: use `OURS` row or `THEIRS` row
- cell-level choices: use `OURS` value or `THEIRS` value
- merged preview

Default merge base is `OURS`. Only explicit `THEIRS` row/cell selections are applied to the candidate file. Cell choices override row choices.

#### Step 3: 生成候选合并文件

When the user has selected the desired rows/cells, generate a candidate through the observer:

```http
POST /api/excel-conflict/write-candidate
{"path":"<conflicted-path>","choices":{"rowChoices":[],"cellChoices":[]}}
```

The guard writes:

```text
.git/git-safe-commit-backups/<timestamp>/excel-merge-candidates/<filename>.merged.<timestamp>.xlsx
.git/git-safe-commit-backups/<timestamp>/excel-merge-candidates/<filename>.choices.json
```

Hard boundary:

- Candidate generation must not overwrite the conflicted original path.
- Candidate generation must not run `git add`.
- Candidate generation must not continue rebase, commit, or push.
- The user must inspect/confirm the candidate and place the final workbook back at the original conflicted path.

#### Step 4: Fallback script report

If the HTML workbench is unavailable, use the read-only script report:

```bash
python .kiro/skills/compare-excel-conflict.py \
  --ours .git/git-safe-commit-backups/<timestamp>/binary-conflicts/<filename>.ours.xlsx \
  --theirs .git/git-safe-commit-backups/<timestamp>/binary-conflicts/<filename>.theirs.xlsx
```

`summary: "no_impact"` only means low-risk candidate. It still requires user confirmation. `summary: "has_impact"` means real config, formula, Luban header, or sheet structure risk is present.

**用户回复「可以继续」后执行验证：**

#### Step 5: 验证并继续

After the user says continue, verify:

```bash
git status
git ls-files -u -- <path>
```

Only then:

```bash
git add -- <path>
```

Then re-check `git ls-files -u` before rebase continue or commit.

## Rollback

If rebase conflict resolution is wrong or unsafe:

```bash
git rebase --abort
git stash apply --index <stash-hash>
```

If restore remains unsafe, inspect the backup branch and patch files:

```bash
git show backup/git-safe-commit/<timestamp>
git apply --index .git/git-safe-commit-backups/<timestamp>/staged.patch
git apply .git/git-safe-commit-backups/<timestamp>/unstaged.patch
```

Do not delete recovery material while safety is uncertain.
