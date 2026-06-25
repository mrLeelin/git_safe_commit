import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("release runtime modules load without the frontend src directory", async () => {
  const packageRoot = await mkdtemp(path.resolve(".runtime-package-"));
  try {
    await cp(path.resolve("lib"), path.join(packageRoot, "lib"), { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");

    const workbench = await import(pathToFileURL(path.join(packageRoot, "lib", "conflict-workbench.mjs")));

    assert.equal(typeof workbench.loadTableConflict, "function");
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});
