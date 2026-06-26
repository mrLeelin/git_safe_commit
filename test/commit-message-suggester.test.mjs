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
      if (args[0] === "ls-files") return { stdout: "" };
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
  assert.match(commands[0].options.input, /只分析这些已选择文件的 diff/);
  assert.match(commands[0].options.input, /先在内部完成分析/);
  assert.match(commands[0].options.input, /不要输出分析过程/);
  assert.match(commands[0].options.input, /按提交目的归并/);
  assert.match(commands[0].options.input, /不要按文件逐条罗列/);
  assert.match(commands[0].options.input, /优先说明用户可感知的行为变化/);
  assert.match(commands[0].options.input, /无法从 diff 判断目的时/);
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

test("suggestCommitMessage reports git diff failures instead of returning an empty message", async () => {
  await assert.rejects(
    suggestCommitMessage({
      config: { repoPath: "C:\\not-a-repo", ai: { selected: "codex" } },
      paths: ["src/App.vue"],
      detectInstalledAi: () => [{ id: "codex", label: "Codex", command: "codex", source: "codex" }],
      runGit: async () => ({
        ok: false,
        stdout: "",
        stderr: "fatal: not a git repository",
        error: ""
      })
    }),
    /读取选中文件 diff 失败：fatal: not a git repository/
  );
});

test("suggestCommitMessage reports selected paths without diff", async () => {
  await assert.rejects(
    suggestCommitMessage({
      config: { repoPath: "C:\\repo", ai: { selected: "codex" } },
      paths: ["src/App.vue"],
      detectInstalledAi: () => [{ id: "codex", label: "Codex", command: "codex", source: "codex" }],
      runGit: async () => ({ ok: true, stdout: "", stderr: "" })
    }),
    /选中的文件没有可用于生成提交说明的变更/
  );
});

test("suggestCommitMessage includes selected untracked files in the AI diff", async () => {
  const commands = [];
  const result = await suggestCommitMessage({
    config: { repoPath: "C:\\repo", ai: { selected: "codex" } },
    paths: ["docs/new-note.md"],
    detectInstalledAi: () => [{ id: "codex", label: "Codex", command: "codex", source: "codex" }],
    runGit: async (_repoPath, args) => {
      if (args[0] === "diff") return { stdout: "" };
      if (args[0] === "ls-files") return { stdout: "docs/new-note.md\n" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
    readFile: async (filePath, encoding) => {
      assert.equal(filePath, "C:\\repo\\docs\\new-note.md");
      assert.equal(encoding, "utf8");
      return "new note\nsecond line";
    },
    runProcess: async (file, args, options) => {
      commands.push({ file, args, options });
      return { ok: true, stdout: "[Docs] -- add new note\n", stderr: "" };
    }
  });

  assert.equal(result.message, "[Docs] -- add new note");
  assert.match(commands[0].options.input, /--- untracked ---/);
  assert.match(commands[0].options.input, /diff --git a\/docs\/new-note\.md b\/docs\/new-note\.md/);
  assert.match(commands[0].options.input, /new file mode 100644/);
  assert.match(commands[0].options.input, /\+new note/);
  assert.match(commands[0].options.input, /\+second line/);
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
      if (args[0] === "ls-files") return { stdout: "" };
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
        if (args[0] === "ls-files") return { stdout: "" };
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
      if (args[0] === "ls-files") return { stdout: "" };
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

test("suggestCommitMessage preserves tagged multiline commit messages from noisy AI output", async () => {
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
      if (args[0] === "diff") return { stdout: "diff --git a/src/App.vue b/src/App.vue\n-同步远端\n+拉取远端\n" };
      if (args[0] === "ls-files") return { stdout: "" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
    runProcess: async () => ({
      ok: true,
      stdout: [
        "我会根据 diff 生成提交说明：",
        "[Style] -- 更新推送拉取按钮标签文案",
        "        -- 调整操作区按钮显示名称"
      ].join("\n"),
      stderr: ""
    })
  });

  assert.equal(result.message, "[Style] -- 更新推送拉取按钮标签文案\n        -- 调整操作区按钮显示名称");
});

test("suggestCommitMessage aligns continuation markers with each tagged line", async () => {
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
      if (args[0] === "diff") return { stdout: "diff --git a/src/App.vue b/src/App.vue\n+fetch button\n" };
      if (args[0] === "ls-files") return { stdout: "" };
      throw new Error(`unexpected git args: ${args.join(" ")}`);
    },
    runProcess: async () => ({
      ok: true,
      stdout: [
        "[Feature] -- 增加获取远端按钮",
        "-- 刷新仓库状态和提交树",
        "[FixBug] [Assets] -- 修复资源按钮显示",
        " -- 保留提交说明标签"
      ].join("\n"),
      stderr: ""
    })
  });

  assert.equal(result.message, [
    "[Feature] -- 增加获取远端按钮",
    "          -- 刷新仓库状态和提交树",
    "[FixBug] [Assets] -- 修复资源按钮显示",
    "                  -- 保留提交说明标签"
  ].join("\n"));
});
