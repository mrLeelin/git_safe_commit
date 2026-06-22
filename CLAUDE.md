# CLAUDE.md

This file gives Claude Code repository-specific guidance for
`git-safe-commit-tool`. Also follow `AGENTS.md`.

## Response Language

Respond in Chinese by default unless the user explicitly asks for another
language.

## What This Project Is

`git-safe-commit-tool` is a standalone Node.js browser tool for safe local Git
commit/sync/push workflows. It exposes a browser UI, a local HTTP API, SSE log
events, guarded Git execution, recovery creation, and an AI tool-call loop.

Important files:

- `server.mjs`: server entry point.
- `public/`: browser UI assets.
- `lib/config.mjs`: local config loading, masking, and saving.
- `lib/git-executor.mjs`: Git allowlist and forbidden command checks.
- `lib/git-state.mjs`: Git state and blocker detection.
- `lib/workflow-runner.mjs`: workflow orchestration.
- `lib/ai-decider.mjs`: AI tool-call loop.
- `lib/tool-definitions.mjs`: AI tool schema and system prompt.
- `.agents/skills/git-safe-commit/`: canonical local skill.

## Local Skill Layout

There must be only one physical project skill copy:

```text
.agents/skills/git-safe-commit
```

The following should be Windows Junctions to `.agents/skills`:

```text
.codex/skills
.claude/skills
.kiro/skills
```

Do not create separate skill copies for Claude or Codex.

## Commands

```powershell
npm test
npm start
```

Server default:

```text
http://127.0.0.1:8080
```

## Safety Requirements

- Keep all Git commands behind `runGit()` / `runProcess()`.
- Keep Git command arguments as arrays passed to `execFile`.
- Do not add destructive Git support: `pull`, `reset --hard`, `clean`, `stash pop`, or force push.
- Do not bypass blockers from `summarizeGitState()`.
- Require recovery before rebase.
- Preserve push confirmation when configured.
- Do not expose or commit API keys from `config.json`.

## Development Rules

- Match the current ESM style.
- Prefer small direct changes.
- Avoid new dependencies unless requested.
- Keep UI/API contracts synchronized.
- Keep operational UI text compact and explicit.
- For AI tools, validate JSON arguments and keep handler names in sync with the tool definitions.

## Verification

Run:

```powershell
npm test
```

Report test results and any unverified areas before claiming completion.
