import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { detectInstalledAi } from "../lib/ai-installations.mjs";

test("detectInstalledAi finds supported AI CLI tools on PATH", () => {
  const bin = path.join("C:", "tools", "bin");
  const seen = new Set([
    path.join(bin, "codex.ps1"),
    path.join(bin, "claude.cmd"),
    path.join(bin, "gemini.exe"),
    path.join(bin, "cursor.exe"),
    path.join(bin, "code.cmd"),
    path.join(bin, "kiro.exe")
  ]);

  const installations = detectInstalledAi({
    platform: "win32",
    pathEnv: bin,
    pathExt: ".EXE;.CMD",
    canAccess: (candidate) => seen.has(candidate)
  });

  assert.deepEqual(installations.map((tool) => tool.id), ["codex", "claude", "gemini"]);
  assert.equal(installations[0].source, path.join(bin, "codex.ps1"));
  assert.equal(installations[1].source, path.join(bin, "claude.cmd"));
  assert.equal(installations[2].source, path.join(bin, "gemini.exe"));
});

test("detectInstalledAi returns an empty list when no supported AI CLI is installed", () => {
  const installations = detectInstalledAi({
    platform: "win32",
    pathEnv: path.join("C:", "tools", "bin"),
    canAccess: () => false
  });

  assert.deepEqual(installations, []);
});
