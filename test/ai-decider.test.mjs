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
