import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkflowRunner } from "../lib/workflow-runner.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createRepo(prefix = "gsc-runner-") {
  const repo = await mkdtemp(path.join(os.tmpdir(), prefix));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

test("workflow runner inspects without AI and emits phase events", async () => {
  const repo = await createRepo();
  const events = [];
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {}
    },
    emit: (event, data) => events.push({ event, data })
  });

  const result = await runner.run("inspect", {});

  assert.equal(result.ok, true);
  assert.equal(result.status.branch, "main");
  assert.deepEqual(events.map((item) => item.event), ["phase", "phase"]);
});

test("workflow runner accepts ai-commit payload and exposes commit tools", async () => {
  const repo = await createRepo();
  await writeFile(path.join(repo, "tracked.txt"), "two\n", "utf8");
  const responses = [
    {
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_status",
            type: "function",
            function: { name: "git_status", arguments: "{}" }
          }]
        }
      }]
    },
    {
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_add",
            type: "function",
            function: { name: "git_add", arguments: JSON.stringify({ paths: ["tracked.txt"] }) }
          }, {
            id: "call_commit",
            type: "function",
            function: { name: "git_commit", arguments: JSON.stringify({ message: "Explain narrow commit path" }) }
          }, {
            id: "call_verify",
            type: "function",
            function: { name: "final_verify", arguments: "{}" }
          }]
        }
      }]
    },
    {
      choices: [{
        message: {
          role: "assistant",
          content: "committed"
        }
      }]
    }
  ];
  const requestBodies = [];
  const runner = createWorkflowRunner({
    config: {
      repoPath: repo,
      workflow: { requireConfirmBeforePush: true },
      ai: {
        baseUrl: "https://example.test/v1",
        apiKey: "local-test-key",
        model: "model-a",
        temperature: 0
      }
    },
    fetchImpl: async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => responses.shift() };
    }
  });

  const result = await runner.run("ai-commit", { paths: ["tracked.txt"], message: "Explain narrow commit path" });

  assert.equal(result.ok, true);
  assert.equal(result.finalText, "committed");
  assert.deepEqual(result.toolResults.map((item) => item.tool), ["git_status", "git_add", "git_commit", "final_verify"]);
  assert.match(requestBodies[0].messages.at(-1).content, /"action":"ai-commit"/);
  assert.match(requestBodies[0].messages.at(-1).content, /"paths":\["tracked.txt"\]/);
  assert.match(git(repo, ["log", "-1", "--pretty=%s"]).trim(), /^Explain narrow commit path$/);
});
