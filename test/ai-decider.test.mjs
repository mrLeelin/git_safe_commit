import assert from "node:assert/strict";
import test from "node:test";

import { runAiToolLoop } from "../lib/ai-decider.mjs";

test("runAiToolLoop executes tool calls and returns final text", async () => {
  const calls = [];
  const responses = [
    {
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_1",
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
          content: "status checked"
        }
      }]
    }
  ];

  const result = await runAiToolLoop({
    config: {
      ai: {
        baseUrl: "https://example.test/v1",
        apiKey: "local-test-key",
        model: "model-a",
        temperature: 0
      }
    },
    messages: [{ role: "user", content: "inspect" }],
    tools: [{
      type: "function",
      function: {
        name: "git_status",
        description: "status",
        parameters: { type: "object", properties: {} }
      }
    }],
    handlers: {
      git_status: async () => {
        calls.push("git_status");
        return { branch: "main" };
      }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift()
    })
  });

  assert.deepEqual(calls, ["git_status"]);
  assert.equal(result.finalText, "status checked");
  assert.equal(result.toolResults.length, 1);
});

test("runAiToolLoop uses the active provider resolved by config", async () => {
  const requests = [];
  const result = await runAiToolLoop({
    config: {
      ai: {
        activeProvider: "claude",
        baseUrl: "https://claude.example/v1",
        apiKey: "claude-key",
        model: "claude-model",
        temperature: 0.3,
        providers: {
          codex: {
            baseUrl: "https://codex.example/v1",
            apiKey: "codex-key",
            model: "codex-model",
            temperature: 0.1
          },
          claude: {
            baseUrl: "https://claude.example/v1",
            apiKey: "claude-key",
            model: "claude-model",
            temperature: 0.3
          }
        }
      }
    },
    messages: [{ role: "user", content: "inspect" }],
    tools: [],
    handlers: {},
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "done" } }] })
      };
    }
  });

  assert.equal(result.finalText, "done");
  assert.equal(requests[0].url, "https://claude.example/v1/chat/completions");
  assert.equal(requests[0].options.headers.authorization, "Bearer claude-key");
  assert.equal(JSON.parse(requests[0].options.body).model, "claude-model");
});
