# Git Safe Commit 使用说明

`git-safe-commit` 用于在脏工作区里安全提交、显式合并分支、rebase、处理冲突和 push。核心原则是：Codex 执行 Git 主流程，脚本只做检查、证据记录和恢复辅助；HTML 页面只做观察、对比和确认，不替代语义判断。

## 解决什么问题

- 避免 `git pull` 产生 merge commit。
- 只有用户明确说 `merge <branch>` 或 `合并 <branch>` 时才进入显式 merge 模式；该模式不 rebase。
- 避免误提交已暂存或未暂存的无关文件。
- 在 rebase、恢复本地改动、冲突处理前创建恢复点。
- 在 rebase 或显式 merge 冲突中提供文本、Excel 和二进制对比工作台，只生成候选文件，不执行 Git 主流程。
- 对 Excel、Unity 资源、`.meta`、Prefab、Scene、`.bytes`、音频、图片等高风险文件保持保守边界。
- 在 PowerShell 中使用 `'@{u}'`，避免 `@{u}` 被解析成哈希字面量。

## 默认安全流程

```text
Inspect -> Recovery -> Sync/Rebase -> Conflict or Scope Review -> Commit -> Push -> Verify
```

## 显式 merge 模式

只有用户明确说 `merge <branch>`、`合并 <branch>`、`把 <branch> merge 进来` 或 `把 <branch> 合并进来` 时才使用该模式。普通的“同步”“更新”“push”“解决冲突”不触发 merge。

```text
Inspect -> Recovery -> Merge -> Conflict or Commit -> Verify
```

规则：

- 执行 `git fetch --prune` 后使用 `git merge --no-ff <branch>`。
- 不执行 `git rebase`，也不使用 `git pull`。
- 如果出现冲突，仍使用同一套文本、Excel、二进制对比工作台。
- 工作台只生成候选文件；Codex 负责把确认后的候选放回原路径、验证、`git add`，最后用 `git commit` 完成 merge。

## 对比工作台边界

HTML 对比工作台适用于 rebase 冲突和显式 merge 冲突：

- 文本工作台展示 BASE、OURS、THEIRS 和当前冲突文件，可生成文本候选。
- Excel 工作台导出并对比 OURS/THEIRS，可生成 `.xlsx` 候选。
- 二进制冲突只导出两边版本，等待人工确认。

工作台不会覆盖原路径，不会执行 `git add`，不会执行 `git commit`、`git push`、`git rebase --continue` 或 `git merge --continue`。候选文件只有在 Codex 放回原路径并通过冲突验证后，才算进入最终解决。

常用检查：

```bash
node .kiro/skills/git-safe-commit/scripts/git-safe-commit-preflight.mjs
git status --short --branch
git rev-parse --abbrev-ref --symbolic-full-name '@{u}'
git rev-list --left-right --count 'HEAD...@{u}'
git diff --cached --name-status
git diff --name-status
git ls-files --others --exclude-standard
git ls-files -u
```

## Rebase 前的 Excel/高风险文件检查

preflight 不只检查“已暂存的 Excel”，还会检查下一次 rebase 会从 upstream 带入并覆盖工作区的 Excel 文件。

如果远端修改了某个 `.xlsx`，而本地对应文件正被 Excel/WPS/ET 打开或无法独占打开，必须先阻断 rebase。否则 Git 可能在 `could not detach HEAD` 前部分写入远端文件，造成工作区出现一批看起来像“回退/删除”的未暂存文件。

阻断依据：

- 精确路径匹配到打开的工作簿。
- 或者对该文件执行独占打开失败。
- Excel/WPS/ET 进程存在但打开的是无关文件，不单独构成阻断。

## 已保存工作簿自动关闭

可以开启“只关闭已保存表”的可选模式：

```bash
GIT_SAFE_COMMIT_AUTOCLOSE_SAVED_EXCEL=1 node .kiro/skills/git-safe-commit/scripts/git-safe-commit-preflight.mjs
```

自动关闭必须同时满足：

- 通过 COM 拿到工作簿的绝对路径 `FullName`。
- 该路径与 Git 相关 Excel 文件精确一致。
- 能明确读取 `Saved=true`。

如果路径为空、保存态未知、COM 不可用，或者 `Saved=false`，脚本必须保留阻断，不关闭任何东西。禁止杀 `EXCEL.exe`、`wps.exe`、`et.exe`。

## 未暂存文件处理策略

默认保留未暂存和未跟踪文件，不清理、不丢弃、不顺手提交。

1. 只提交当前任务
   只执行路径级暂存：

   ```bash
   git add -- <path>
   git diff --cached --name-status
   git commit
   ```

   其他未暂存文件继续留在工作区。

2. 需要 rebase 或 push，且工作区不干净
   先创建恢复点，再执行同步操作。恢复本地改动时优先使用：

   ```bash
   git stash apply --index <stash-hash>
   git apply --index <patch>
   ```

   不使用 `git stash pop`。

3. 存在多组任务改动
   只在来源清晰时按路径拆提交。来源不清晰的文件保持未暂存，并在最终报告列出。

4. 存在高风险文件
   Unity 资源、`.meta`、Prefab、Scene、材质、动画、Addressables、Excel、`.bytes`、音频、图片、视频、压缩包、签名文件、服务器配置和生成物只备份和报告。除非用户明确指定，否则不自动合并、不自动丢弃、不自动暂存。

5. 用户明确要求丢弃某个文件
   只对明确路径执行：

   ```bash
   git restore -- <path>
   ```

   不使用 `git reset --hard` 或 `git clean`。

## 部分 rebase 失败恢复

如果 `git rebase '@{u}'` 在 detach HEAD 前失败，例如：

```text
error: unable to unlink old '<path>.xlsx': Invalid argument
error: could not detach HEAD
```

这通常不是普通冲突，而是工作簿锁定导致 Git 已经部分写入 upstream 文件。处理顺序：

1. 不继续 rebase，不 push，不 commit。
2. 保存失败现场。
3. 确认没有 `.git/rebase-merge` 或 `.git/rebase-apply`。
4. 确认 HEAD 仍是 rebase 前的 HEAD。
5. 用 backup branch 路径级恢复，不用 `reset --hard`：

```bash
node .kiro/skills/git-safe-commit/scripts/git-safe-commit-recover-partial-rebase.mjs backup/git-safe-commit/<timestamp>
```

恢复脚本会把 status、HEAD、unmerged stages、staged/unstaged binary patch 保存到 `.git/git-safe-commit-backups/partial-rebase-*`，然后执行：

```bash
git restore --source <backup-branch> --worktree --staged -- .
```

## Push-only 快速路径

只有在工作区干净、分支有 upstream、`ahead > 0`、`behind == 0`、没有提交范围需要审查时，才使用快速 push。

```text
1. preflight
2. git fetch --prune
3. git rev-list --left-right --count 'HEAD...@{u}'
4. git push
5. final-verify
```

如果工作区有任何未暂存、未跟踪、冲突文件，或者远端前进了，就切回完整流程。

## 禁止操作

- 不运行 `git pull`。
- 不在用户未明确说 `merge` 或 `合并` 且未提供源分支时运行 `git merge`。
- 显式 merge 模式下不运行 `git rebase`。
- 不运行 `git reset --hard`。
- 不运行 `git clean`。
- 不运行 `git stash pop`。
- 不普通 force push。
- 有 unresolved conflict 或 conflict marker 时，不 commit、不 push、不 `rebase --continue`。
- 不自动解决 Excel、二进制、Unity 序列化资源冲突。

## 完成标准

最强完成条件由 final verify 证明：

- HEAD 等于 upstream。
- ahead/behind 为 `0/0`。
- 没有 rebase 状态。
- 没有 unresolved conflict 或 conflict marker。
- 工作区干净。

如果是 dirty repo 窄提交，工作区可以继续有无关本地改动。此时需要手工验证：

- 目标 commit 已创建。
- staged 区为空。
- 目标文件已经进入 commit。
- 剩余 dirty 文件都是未纳入本次范围的本地改动。
- 没有冲突状态。
