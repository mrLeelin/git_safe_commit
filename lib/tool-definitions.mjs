export const GitSafeCommitTools = [
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Read full repository status including branch, upstream, ahead/behind, changed files, conflicts, and blockers.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "create_recovery",
      description: "Create a recovery point before any sync, rebase, or destructive-risk operation.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "git_fetch",
      description: "Fetch remote updates without merging.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "git_add",
      description: "Stage an explicit path allowlist. Never stage unrelated files.",
      parameters: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } }
        },
        required: ["paths"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Commit the current staged allowlist with the provided message.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" }
        },
        required: ["message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_rebase",
      description: "Rebase current branch onto the configured upstream. Requires recovery first.",
      parameters: {
        type: "object",
        properties: {
          onto: { type: "string", description: "Target ref. Defaults to @{u}." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "git_push",
      description: "Push current branch. The tool may block this if confirmation is required or conflicts exist.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "final_verify",
      description: "Verify final branch/upstream, conflicts, rebase state, and dirty state.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "escalate_conflict",
      description: "Pause automation and ask the browser UI to show a human confirmation or conflict workbench.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          reason: { type: "string" }
        },
        required: ["path", "reason"]
      }
    }
  }
];

export const SystemPrompt = `You are the decision engine inside a local git-safe-commit browser tool.

Rules:
- Never request git pull, git reset --hard, git clean, stash pop, or force push.
- Create a recovery point before rebase or any sync that can rewrite local work.
- Use git_status before making decisions.
- For commit operations, stage only explicit paths provided by the UI.
- For push operations, respect requireConfirmBeforePush; if confirmation is missing, escalate to the human UI.
- Escalate Excel, Unity serialized resources, binary files, secrets, signing files, or semantic conflicts to the human UI.
- Stop after final_verify when the repository is safe or when the user must decide.`;
