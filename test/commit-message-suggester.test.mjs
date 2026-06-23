import assert from "node:assert/strict";
import test from "node:test";

import { suggestCommitMessage } from "../lib/commit-message-suggester.mjs";

test("suggestCommitMessage uses the selected installed AI CLI instead of remote API config", async () => {
  const commands = [];
  const result = await suggestCommitMessage({
    config: {
      repoPath: "C:\\repo",
      ai: {
        selected: "codex",
        baseUrl: "https://bad.example/v1",
        apiKey: ""
      }
    },
    paths: ["src/App.vue"],
    detectInstalledAi: () => [{ id: "codex", label: "Codex", command: "codex", source: "codex" }],
    runGit: async (_repoPath, args) => {
      if (args[0] === "diff" && args[1] === "--cached") return { stdout: "" };
      if (args[0] === "diff") return { stdout: "diff --git a/src/App.vue b/src/App.vue\n+fix ui\n" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
    runProcess: async (file, args, options) => {
      commands.push({ file, args, options });
      return { ok: true, stdout: "修复设置页 AI 提交说明生成", stderr: "" };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.message, "修复设置页 AI 提交说明生成");
  assert.equal(commands[0].file, "codex");
  assert.deepEqual(commands[0].args, ["--ask-for-approval", "never", "exec", "--sandbox", "read-only", "-"]);
  assert.match(commands[0].options.input, /diff --git/);
  assert.match(commands[0].options.input, /\[FixBug\]/);
  assert.match(commands[0].options.input, /\[Feature\]/);
  assert.match(commands[0].options.input, /\[Assets\]/);
  assert.match(commands[0].options.input, /\[FixBug\] -- 修复提交按钮无法提交/);
  assert.match(commands[0].options.input, /\s+-- 补充直接提交回归测试/);
  assert.match(commands[0].options.input, /\[FixBug\] \[Assets\] -- 修复资源加载异常/);
});

test("suggestCommitMessage returns a structured error when selected AI is unavailable", async () => {
  await assert.rejects(
    suggestCommitMessage({
      config: { repoPath: "C:\\repo", ai: { selected: "claude" } },
      paths: ["src/App.vue"],
      detectInstalledAi: () => [{ id: "codex", label: "Codex", command: "codex", source: "codex" }]
    }),
    /未检测到已选择的 AI：claude/
  );
});

test("suggestCommitMessage uses the Windows cmd shim for Codex extensionless npm shims", async () => {
  const commands = [];
  const result = await suggestCommitMessage({
    config: { repoPath: "C:\\repo", ai: { selected: "codex" } },
    paths: ["src/App.vue"],
    detectInstalledAi: () => [{
      id: "codex",
      label: "Codex",
      command: "codex",
      source: "C:\\Users\\me\\AppData\\Roaming\\npm\\codex"
    }],
    runGit: async (_repoPath, args) => {
      if (args[0] === "diff" && args[1] === "--cached") return { stdout: "" };
      if (args[0] === "diff") return { stdout: "diff --git a/src/App.vue b/src/App.vue\n+fix ui\n" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
    runProcess: async (file, args, options) => {
      commands.push({ file, args, options });
      return { ok: true, stdout: "修复 AI 生成", stderr: "" };
    },
    fileExists: (candidate) => candidate.endsWith("codex.ps1") || candidate.endsWith("codex.cmd")
  });

  assert.equal(result.message, "修复 AI 生成");
  assert.equal(commands[0].file, "cmd.exe");
  assert.deepEqual(commands[0].args.slice(0, 5), [
    "/d",
    "/s",
    "/c",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
    "--ask-for-approval"
  ]);
  assert.match(commands[0].options.input, /diff --git/);
});

test("suggestCommitMessage trims failed AI output before returning an error", async () => {
  await assert.rejects(
    suggestCommitMessage({
      config: { repoPath: "C:\\repo", ai: { selected: "claude" } },
      paths: ["src/App.vue"],
      detectInstalledAi: () => [{
        id: "claude",
        label: "Claude",
        command: "claude",
        source: "claude"
      }],
      runGit: async (_repoPath, args) => {
        if (args[0] === "diff" && args[1] === "--cached") return { stdout: "" };
        if (args[0] === "diff") return { stdout: "diff --git a/src/App.vue b/src/App.vue\n+fix ui\n" };
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
      runProcess: async () => ({
        ok: false,
        code: 1,
        stdout: "",
        stderr: "first line\n" + "x".repeat(1000),
        error: "Command failed with huge prompt"
      })
    }),
    /AI 生成提交说明失败：first line/
  );
});

test("suggestCommitMessage accepts stdout when Codex produces a message before timing out", async () => {
  const result = await suggestCommitMessage({
    config: { repoPath: "C:\\repo", ai: { selected: "codex" } },
    paths: ["src/App.vue"],
    detectInstalledAi: () => [{
      id: "codex",
      label: "Codex",
      command: "codex",
      source: "codex"
    }],
    runGit: async (_repoPath, args) => {
      if (args[0] === "diff" && args[1] === "--cached") return { stdout: "" };
      if (args[0] === "diff") return { stdout: "diff --git a/src/App.vue b/src/App.vue\n+fix ui\n" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
    runProcess: async () => ({
      ok: false,
      code: 1,
      stdout: "修复 AI 提交说明生成\n",
      stderr: "",
      error: "process timed out after 45000ms"
    })
  });

  assert.equal(result.message, "修复 AI 提交说明生成");
});
