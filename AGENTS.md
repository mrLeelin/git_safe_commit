# AGENTS.md

Project guidance for autonomous coding agents working in this repository.

## Project Shape

This is a standalone local browser tool for running a safe `git-safe-commit`
workflow against a configured Git repository.

Key entry points:

- `server.mjs` starts the local HTTP server and exposes the browser UI plus JSON/SSE APIs.
- `public/` contains the browser interface.
- `lib/config.mjs` loads, normalizes, masks, and saves local configuration.
- `lib/git-executor.mjs` is the Git command safety boundary.
- `lib/git-state.mjs` collects and summarizes repository status.
- `lib/workflow-runner.mjs` owns workflow actions and AI tool handlers.
- `lib/ai-decider.mjs` runs the Chat Completions tool-call loop.
- `.agents/skills/git-safe-commit/` is the single canonical project skill directory.
- `.codex/skills`, `.claude/skills`, and `.kiro/skills` are Windows Junctions to `.agents/skills`.
- `test/` contains Node test-runner coverage for config, Git safety, recovery, workflow, and server smoke behavior.

## Commands

Use PowerShell from the repository root.

```powershell
npm test
npm start
```

The server defaults to:

```text
http://127.0.0.1:8080
```

`config.json` is local private state and is ignored by Git. Do not commit real
API keys or user-specific target repository paths.

## Safety Rules

This project exists to protect Git operations. Preserve that boundary.

- Keep all Git execution behind `runGit()` / `runProcess()` in `lib/git-executor.mjs`.
- Use `execFile` argument arrays. Do not build shell command strings for Git.
- Do not add support for `git pull`, `git reset --hard`, `git clean`, `git stash pop`, or force push.
- Keep `repoPath` validation absolute and inside the intended target repository for path-sensitive operations.
- Create recovery state before any rebase-capable workflow path.
- Treat conflicts, conflict markers, failed `git diff --check`, and missing upstream as blockers unless a specific tested recovery path handles them.
- Preserve the push confirmation gate when `workflow.requireConfirmBeforePush` is enabled.

## Implementation Conventions

- This repo uses ESM modules (`"type": "module"`) and Node built-ins where possible.
- Keep modules small and boundary-focused; prefer extending existing helpers over adding parallel mechanisms.
- Use structured JSON responses for API errors and workflow results.
- Keep browser/server contracts explicit. When API response shapes change, update both `server.mjs`/`lib/*` and `public/*`.
- Avoid new dependencies unless the task explicitly requires them.
- Keep generated or reference skill assets under `.agents/skills/git-safe-commit/` separate from the standalone tool runtime unless the task is intentionally syncing behavior.
- Do not create duplicate skill copies under `.codex`, `.claude`, or `.kiro`; keep those paths as Junctions to `.agents/skills`.

## AI Tool Loop Rules

When changing `lib/ai-decider.mjs`, `lib/tool-definitions.mjs`, or workflow tool handlers:

- Validate tool-call argument JSON before executing handlers.
- Keep handler names aligned with `GitSafeCommitTools`.
- Keep max-turn failure explicit.
- Do not let the model bypass Git safety allowlists or push confirmation.
- Return enough structured tool results for the UI/log stream to explain what happened.

## UI Rules

The browser UI is an operational tool, not a marketing page.

- Keep status, blockers, recovery state, logs, and confirmation controls visible and direct.
- Do not hide destructive or remote-affecting actions behind ambiguous labels.
- For long-running actions, emit useful SSE state/log updates from the server.
- Keep text compact and task-oriented.

## Verification

For normal code changes, run:

```powershell
npm test
```

For focused changes, also run or inspect the relevant layer:

- Git command safety: `test/git-executor.test.mjs`
- Git status/blockers: `test/git-state.test.mjs`
- Recovery creation: `test/recovery.test.mjs`
- AI tool loop: `test/ai-decider.test.mjs`
- Workflow actions: `test/workflow-runner.test.mjs`
- HTTP/API behavior: `test/server-smoke.test.mjs`

Before claiming completion, report what was tested and any validation that could
not be run.

## Commit Guidance

Keep commits narrow. Stage only files related to the requested change.

If asked to commit, use the repository's Lore-style commit message convention:

```text
<intent line: why the change was made, not just what changed>

Constraint: <external constraint that shaped the decision>
Rejected: <alternative considered> | <reason for rejection>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Directive: <forward-looking warning for future modifiers>
Tested: <what was verified>
Not-tested: <known gaps in verification>
```
