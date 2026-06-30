import assert from "node:assert/strict";
import test from "node:test";

import { reviewAuditWithAi } from "../lib/ai-audit-review.mjs";

test("reviewAuditWithAi sends staged diff and risk labels to the selected local AI", async () => {
  const commands = [];
  const result = await reviewAuditWithAi({
    config: { repoPath: "C:\\repo", ai: { selected: "codex" } },
    paths: ["src/table-conflict.csv"],
    risks: [{ path: "src/table-conflict.csv", labels: ["table"] }],
    detectInstalledAi: () => [{ id: "codex", label: "Codex", command: "codex", source: "codex" }],
    runGit: async (_repoPath, args) => {
      assert.deepEqual(args, ["diff", "--cached", "--", "src/table-conflict.csv"]);
      return { ok: true, stdout: "diff --git a/src/table-conflict.csv b/src/table-conflict.csv\n+id,value\n+1,local\n" };
    },
    runProcess: async (file, args, options) => {
      commands.push({ file, args, options });
      return {
        ok: true,
        stdout: "结论：需要人工复查\n关注点：\n- CSV 行列需要确认\n建议：\n- 对照业务表检查 value 列\n"
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.paths[0], "src/table-conflict.csv");
  assert.match(result.review, /结论：需要人工复查/);
  assert.equal(commands[0].file, "codex");
  assert.match(commands[0].options.input, /只审查下面这些暂存 diff/);
  assert.match(commands[0].options.input, /src\/table-conflict\.csv: table/);
  assert.match(commands[0].options.input, /diff --git/);
});

test("reviewAuditWithAi reports missing staged diff", async () => {
  await assert.rejects(
    reviewAuditWithAi({
      config: { repoPath: "C:\\repo", ai: { selected: "codex" } },
      paths: ["src/table-conflict.csv"],
      detectInstalledAi: () => [{ id: "codex", label: "Codex", command: "codex", source: "codex" }],
      runGit: async () => ({ ok: true, stdout: "" })
    }),
    /没有暂存 diff/
  );
});

test("reviewAuditWithAi can review selected files across staged unstaged and untracked diffs", async () => {
  const calls = [];
  let prompt = "";
  const result = await reviewAuditWithAi({
    config: { repoPath: "C:\\repo", ai: { selected: "codex" } },
    paths: ["src/service.js", "src/new-file.js"],
    diffScope: "combined",
    detectInstalledAi: () => [{ id: "codex", label: "Codex", command: "codex", source: "codex" }],
    readFile: async (filePath) => {
      assert.match(filePath, /src[\\/]new-file\.js$/);
      return "export const added = true;\n";
    },
    runGit: async (_repoPath, args) => {
      calls.push(args);
      if (args[0] === "diff" && args[1] === "--cached") {
        return { ok: true, stdout: "diff --git a/src/service.js b/src/service.js\n+staged\n" };
      }
      if (args[0] === "diff") {
        return { ok: true, stdout: "diff --git a/src/service.js b/src/service.js\n+unstaged\n" };
      }
      if (args[0] === "ls-files") {
        return { ok: true, stdout: "src/new-file.js\n" };
      }
      return { ok: false, stderr: "unexpected command" };
    },
    runProcess: async (_file, _args, options) => {
      prompt = options.input;
      return { ok: true, stdout: "结论：通过\n关注点：\n- AI 未发现明显问题\n建议：\n- 仍需人工确认业务含义\n" };
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0], ["diff", "--cached", "--", "src/service.js", "src/new-file.js"]);
  assert.deepEqual(calls[1], ["diff", "--", "src/service.js", "src/new-file.js"]);
  assert.deepEqual(calls[2], ["ls-files", "--others", "--exclude-standard", "--", "src/service.js", "src/new-file.js"]);
  assert.match(prompt, /只审查下面这些所选文件 diff/);
  assert.match(prompt, /--- staged ---/);
  assert.match(prompt, /--- unstaged ---/);
  assert.match(prompt, /--- untracked ---/);
  assert.match(prompt, /export const added = true/);
});
