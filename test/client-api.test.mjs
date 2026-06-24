import assert from "node:assert/strict";
import test from "node:test";

import { runAction } from "../src/client/api.js";

test("client API preserves structured action error details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, options) => {
    assert.equal(path, "/api/action/push");
    assert.equal(options.method, "POST");
    return new Response(JSON.stringify({
      ok: false,
      error: "remote advanced before push",
      reason: "remote advanced before push",
      recommendedAction: "ai-sync-and-push",
      summary: { behind: 1, ahead: 1 }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  try {
    await assert.rejects(
      () => runAction("push", { confirmed: true }),
      (error) => {
        assert.equal(error.message, "remote advanced before push");
        assert.equal(error.data.reason, "remote advanced before push");
        assert.equal(error.data.recommendedAction, "ai-sync-and-push");
        assert.equal(error.data.summary.behind, 1);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
