import assert from "node:assert/strict";
import test from "node:test";

import { parseSelectedFolderPath } from "../lib/folder-picker.mjs";

test("parseSelectedFolderPath trims PowerShell output and returns selected folder", () => {
  assert.equal(parseSelectedFolderPath("  C:\\Project\\Repo  \r\n"), "C:\\Project\\Repo");
});

test("parseSelectedFolderPath returns empty string when dialog is cancelled", () => {
  assert.equal(parseSelectedFolderPath("\r\n"), "");
});
