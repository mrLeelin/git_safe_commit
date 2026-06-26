import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ExcelJS from "exceljs";

import {
  applyConflictCandidate,
  exportBinaryConflict,
  loadBinaryConflict,
  loadTableConflict,
  loadTextConflict,
  writeBinaryCandidate,
  writeTableCandidate,
  writeTextCandidate
} from "../lib/conflict-workbench.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createConflictRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "gsc-conflict-workbench-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeFile(path.join(repo, "tracked.js"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(repo, "data.csv"), "id,name,score,note\n1,Alice,10,base\n", "utf8");
  await writeFile(path.join(repo, "data.bytes"), Buffer.from([1, 2, 3, 4]));
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["switch", "-c", "feature"]);
  await writeFile(path.join(repo, "tracked.js"), "export const value = 2;\n", "utf8");
  await writeFile(path.join(repo, "data.csv"), "id,name,score,note\n1,Ally,10,theirs\n", "utf8");
  await writeFile(path.join(repo, "data.bytes"), Buffer.from([2, 2, 3, 4]));
  git(repo, ["commit", "-am", "feature edit"]);
  git(repo, ["switch", "main"]);
  await writeFile(path.join(repo, "tracked.js"), "export const value = 3;\n", "utf8");
  await writeFile(path.join(repo, "data.csv"), "id,name,score,note\n1,Alicia,11,base\n", "utf8");
  await writeFile(path.join(repo, "data.bytes"), Buffer.from([3, 2, 3, 4]));
  git(repo, ["commit", "-am", "main edit"]);
  assert.throws(() => git(repo, ["merge", "feature"]));
  return repo;
}

async function createPrefabConflictRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "gsc-prefab-conflict-workbench-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeFile(path.join(repo, "Example.prefab"), "%YAML 1.1\n--- !u!1 &1000\nGameObject:\n  m_Name: Base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["switch", "-c", "feature"]);
  await writeFile(path.join(repo, "Example.prefab"), "%YAML 1.1\n--- !u!1 &1000\nGameObject:\n  m_Name: Feature\n", "utf8");
  git(repo, ["commit", "-am", "feature edit"]);
  git(repo, ["switch", "main"]);
  await writeFile(path.join(repo, "Example.prefab"), "%YAML 1.1\n--- !u!1 &1000\nGameObject:\n  m_Name: Main\n", "utf8");
  git(repo, ["commit", "-am", "main edit"]);
  assert.throws(() => git(repo, ["merge", "feature"]));
  return repo;
}

async function createSpreadsheetConflictRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "gsc-xlsx-conflict-workbench-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeWorkbook(path.join(repo, "data.xlsx"), [
    ["id", "name", "score", "note"],
    [1, "Alice", { formula: "5+5", result: 10 }, "base"]
  ]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["switch", "-c", "feature"]);
  await writeWorkbook(path.join(repo, "data.xlsx"), [
    ["id", "name", "score", "note"],
    [1, "Ally", { formula: "5+5", result: 10 }, "theirs"]
  ]);
  git(repo, ["commit", "-am", "feature edit"]);
  git(repo, ["switch", "main"]);
  await writeWorkbook(path.join(repo, "data.xlsx"), [
    ["id", "name", "score", "note"],
    [1, "Alicia", { formula: "5+6", result: 11 }, "base"]
  ]);
  git(repo, ["commit", "-am", "main edit"]);
  assert.throws(() => git(repo, ["merge", "feature"]));
  return repo;
}

async function createSparseSpreadsheetConflictRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "gsc-sparse-xlsx-conflict-workbench-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeWorkbook(path.join(repo, "data.xlsx"), [
    ["id", "name"],
    [0, "line\nbreak"],
    [],
    [1, "Alice"]
  ]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["switch", "-c", "feature"]);
  await writeWorkbook(path.join(repo, "data.xlsx"), [
    ["id", "name"],
    [0, "line\nbreak"],
    [],
    [1, "Ally"]
  ]);
  git(repo, ["commit", "-am", "feature edit"]);
  git(repo, ["switch", "main"]);
  await writeWorkbook(path.join(repo, "data.xlsx"), [
    ["id", "name"],
    [0, "line\nbreak"],
    [],
    [1, "Alicia"]
  ]);
  git(repo, ["commit", "-am", "main edit"]);
  assert.throws(() => git(repo, ["merge", "feature"]));
  return repo;
}

async function createMultiSheetSpreadsheetConflictRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "gsc-multisheet-xlsx-conflict-workbench-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeWorkbookSheets(path.join(repo, "data.xlsx"), {
    Sheet1: [
      ["id", "name"],
      [1, "same"]
    ],
    Sheet2: [
      ["id", "title"],
      [1, "base"]
    ]
  });
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["switch", "-c", "feature"]);
  await writeWorkbookSheets(path.join(repo, "data.xlsx"), {
    Sheet1: [
      ["id", "name"],
      [1, "same"]
    ],
    Sheet2: [
      ["id", "title"],
      [1, "theirs"]
    ]
  });
  git(repo, ["commit", "-am", "feature edit"]);
  git(repo, ["switch", "main"]);
  await writeWorkbookSheets(path.join(repo, "data.xlsx"), {
    Sheet1: [
      ["id", "name"],
      [1, "same"]
    ],
    Sheet2: [
      ["id", "title"],
      [1, "ours"]
    ]
  });
  git(repo, ["commit", "-am", "main edit"]);
  assert.throws(() => git(repo, ["merge", "feature"]));
  return repo;
}

async function createTwoConflictSheetSpreadsheetRepo() {
  const repo = await mkdtemp(path.join(os.tmpdir(), "gsc-two-sheet-xlsx-conflict-workbench-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "tool@example.test"]);
  git(repo, ["config", "user.name", "Tool Test"]);
  await writeWorkbookSheets(path.join(repo, "data.xlsx"), {
    Sheet1: [
      ["id", "name"],
      [1, "base-a"]
    ],
    Sheet2: [
      ["id", "title"],
      [1, "base-b"]
    ]
  });
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["switch", "-c", "feature"]);
  await writeWorkbookSheets(path.join(repo, "data.xlsx"), {
    Sheet1: [
      ["id", "name"],
      [1, "theirs-a"]
    ],
    Sheet2: [
      ["id", "title"],
      [1, "theirs-b"]
    ]
  });
  git(repo, ["commit", "-am", "feature edit"]);
  git(repo, ["switch", "main"]);
  await writeWorkbookSheets(path.join(repo, "data.xlsx"), {
    Sheet1: [
      ["id", "name"],
      [1, "ours-a"]
    ],
    Sheet2: [
      ["id", "title"],
      [1, "ours-b"]
    ]
  });
  git(repo, ["commit", "-am", "main edit"]);
  assert.throws(() => git(repo, ["merge", "feature"]));
  return repo;
}

test("text conflict workbench loads stages and writes a candidate without staging", async () => {
  const repo = await createConflictRepo();

  const loaded = await loadTextConflict({ repoPath: repo, filePath: "tracked.js" });
  const candidate = await writeTextCandidate({
    repoPath: repo,
    filePath: "tracked.js",
    content: "export const value = 5;\n",
    source: "line",
    lineChoices: [{ row: 1, choice: "both" }]
  });

  assert.equal(loaded.ok, true);
  assert.match(loaded.textConflict.base.content, /value = 1/);
  assert.match(loaded.textConflict.ours.content, /value = 3/);
  assert.match(loaded.textConflict.theirs.content, /value = 2/);
  assert.equal(candidate.ok, true);
  assert.match(candidate.textCandidate.candidate, /\.git\/git-safe-commit-backups\/.+\/text-merge-candidates\/tracked\.merged\./);
  assert.equal(await readFile(path.join(repo, candidate.textCandidate.candidate), "utf8"), "export const value = 5;\n");
  const choices = JSON.parse(await readFile(path.join(repo, candidate.textCandidate.choices), "utf8"));
  assert.equal(choices.source, "line");
  assert.deepEqual(choices.lineChoices, [{ row: 1, choice: "both" }]);
  assert.match(git(repo, ["status", "--short"]), /^UU tracked\.js/m);
});

test("text conflict workbench supports Unity prefab YAML conflicts", async () => {
  const repo = await createPrefabConflictRepo();

  const loaded = await loadTextConflict({ repoPath: repo, filePath: "Example.prefab" });
  const candidate = await writeTextCandidate({
    repoPath: repo,
    filePath: "Example.prefab",
    content: "%YAML 1.1\n--- !u!1 &1000\nGameObject:\n  m_Name: Resolved\n",
    source: "line",
    lineChoices: [{ row: 4, choice: "ours" }]
  });

  assert.equal(loaded.ok, true);
  assert.match(loaded.textConflict.base.content, /m_Name: Base/);
  assert.match(loaded.textConflict.ours.content, /m_Name: Main/);
  assert.match(loaded.textConflict.theirs.content, /m_Name: Feature/);
  assert.equal(candidate.ok, true);
  assert.match(candidate.textCandidate.candidate, /\.git\/git-safe-commit-backups\/.+\/text-merge-candidates\/Example\.merged\..+\.prefab/);
  assert.equal(await readFile(path.join(repo, candidate.textCandidate.candidate), "utf8"), "%YAML 1.1\n--- !u!1 &1000\nGameObject:\n  m_Name: Resolved\n");
  assert.match(git(repo, ["status", "--short"]), /^UU Example\.prefab/m);
});

test("conflict workbench applies a generated candidate back to the conflict file and stages it", async () => {
  const repo = await createConflictRepo();
  const candidate = await writeTextCandidate({
    repoPath: repo,
    filePath: "tracked.js",
    content: "export const value = 5;\n",
    source: "line",
    lineChoices: [{ row: 1, choice: "theirs" }]
  });

  const applied = await applyConflictCandidate({
    repoPath: repo,
    filePath: "tracked.js",
    candidatePath: candidate.textCandidate.candidate
  });

  assert.equal(applied.ok, true);
  assert.deepEqual(applied.appliedConflict, {
    path: "tracked.js",
    candidate: candidate.textCandidate.candidate,
    staged: true
  });
  assert.equal(await readFile(path.join(repo, "tracked.js"), "utf8"), "export const value = 5;\n");
  const status = git(repo, ["status", "--short"]);
  assert.match(status, /^M  tracked\.js/m);
  assert.doesNotMatch(status, /^UU tracked\.js/m);
});

test("conflict workbench refuses to apply a candidate outside the backup area", async () => {
  const repo = await createConflictRepo();
  await writeFile(path.join(repo, "not-a-candidate.js"), "export const value = 9;\n", "utf8");

  await assert.rejects(
    () => applyConflictCandidate({
      repoPath: repo,
      filePath: "tracked.js",
      candidatePath: "not-a-candidate.js"
    }),
    /candidate path must be inside \.git\/git-safe-commit-backups/
  );

  assert.match(git(repo, ["status", "--short"]), /^UU tracked\.js/m);
});

test("table conflict workbench loads CSV stages and writes merged candidate without staging", async () => {
  const repo = await createConflictRepo();

  const loaded = await loadTableConflict({ repoPath: repo, filePath: "data.csv" });
  const candidate = await writeTableCandidate({
    repoPath: repo,
    filePath: "data.csv",
    content: "id,name,score,note\n1,Ally,11,theirs\n",
    source: "table",
    cellChoices: [{ row: 1, column: 1, label: "B2", choice: "theirs" }]
  });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.tableConflict.merge.conflictCount, 1);
  assert.equal(loaded.tableConflict.merge.autoCount, 2);
  assert.equal(loaded.tableConflict.merge.cells[1][1].label, "B2");
  assert.equal(loaded.tableConflict.merge.cells[1][1].kind, "conflict");
  assert.match(candidate.tableCandidate.candidate, /\.git\/git-safe-commit-backups\/.+\/table-merge-candidates\/data\.merged\./);
  assert.equal(await readFile(path.join(repo, candidate.tableCandidate.candidate), "utf8"), "id,name,score,note\n1,Ally,11,theirs\n");
  const choices = JSON.parse(await readFile(path.join(repo, candidate.tableCandidate.choices), "utf8"));
  assert.deepEqual(choices.cellChoices, [{ row: 1, column: 1, label: "B2", choice: "theirs" }]);
  assert.match(git(repo, ["status", "--short"]), /^UU data\.csv/m);
});

test("table conflict workbench loads XLSX stages and writes an XLSX candidate without staging", async () => {
  const repo = await createSpreadsheetConflictRepo();

  const loaded = await loadTableConflict({ repoPath: repo, filePath: "data.xlsx" });
  const candidate = await writeTableCandidate({
    repoPath: repo,
    filePath: "data.xlsx",
    content: "id,name,score,note\n1,Ally,11,theirs\n",
    source: "table",
    cellChoices: [{ row: 1, column: 1, label: "B2", choice: "theirs" }]
  });
  const rows = await readWorkbookRows(path.join(repo, candidate.tableCandidate.candidate));

  assert.equal(loaded.ok, true);
  assert.equal(loaded.tableConflict.path, "data.xlsx");
  assert.equal(loaded.tableConflict.merge.conflictCount, 1);
  assert.equal(loaded.tableConflict.merge.autoCount, 2);
  assert.equal(loaded.tableConflict.merge.cells[1][1].kind, "conflict");
  assert.match(candidate.tableCandidate.candidate, /\.git\/git-safe-commit-backups\/.+\/table-merge-candidates\/data\.merged\..+\.xlsx/);
  assert.deepEqual(rows, [
    ["id", "name", "score", "note"],
    ["1", "Ally", "11", "theirs"]
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(path.join(repo, candidate.tableCandidate.candidate)));
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.getColumn(2).width, 24);
  assert.equal(sheet.getRow(2).height, 32);
  assert.equal(sheet.getCell("B2").fill.fgColor.argb, "FF123456");
  assert.equal(sheet.getCell("B2").font.color.argb, "FFFFFFFF");
  assert.deepEqual(sheet.getCell("C2").value, { formula: "5+6", result: 11 });
  assert.match(git(repo, ["status", "--short"]), /^UU data\.xlsx/m);
});

test("table conflict workbench compacts pure empty XLSX rows", async () => {
  const repo = await createSparseSpreadsheetConflictRepo();

  const loaded = await loadTableConflict({ repoPath: repo, filePath: "data.xlsx" });
  const conflict = loaded.tableConflict.merge.cells[2][1];
  conflict.choice = "theirs";
  const candidate = await writeTableCandidate({
    repoPath: repo,
    filePath: "data.xlsx",
    content: "id,name\n0,\"line\nbreak\"\n1,Ally\n",
    source: "table",
    cellChoices: [{ row: 2, column: 1, label: "B3", choice: "theirs" }]
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(path.join(repo, candidate.tableCandidate.candidate)));
  const sheet = workbook.worksheets[0];

  assert.equal(conflict.label, "B3");
  assert.equal(conflict.ours, "Alicia");
  assert.equal(conflict.theirs, "Ally");
  assert.equal(sheet.getCell("B2").value, "line\nbreak");
  assert.equal(sheet.getCell("B3").value, "Ally");
  assert.equal(sheet.rowCount, 3);
});

test("table conflict workbench exposes and writes conflicts from a second XLSX sheet", async () => {
  const repo = await createMultiSheetSpreadsheetConflictRepo();

  const loaded = await loadTableConflict({ repoPath: repo, filePath: "data.xlsx" });
  const secondSheet = loaded.tableConflict.sheets.find((sheet) => sheet.name === "Sheet2");
  const candidate = await writeTableCandidate({
    repoPath: repo,
    filePath: "data.xlsx",
    sheetName: "Sheet2",
    content: "id,title\n1,theirs\n",
    source: "table",
    cellChoices: [{ sheetName: "Sheet2", row: 1, column: 1, label: "B2", choice: "theirs" }]
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(path.join(repo, candidate.tableCandidate.candidate)));

  assert.equal(loaded.tableConflict.activeSheetName, "Sheet2");
  assert.equal(secondSheet.merge.conflictCount, 1);
  assert.equal(secondSheet.merge.cells[1][1].label, "B2");
  assert.equal(secondSheet.merge.cells[1][1].ours, "ours");
  assert.equal(secondSheet.merge.cells[1][1].theirs, "theirs");
  assert.equal(workbook.getWorksheet("Sheet1").getCell("B2").value, "same");
  assert.equal(workbook.getWorksheet("Sheet2").getCell("B2").value, "theirs");
});

test("table conflict workbench writes every XLSX sheet merge into one candidate", async () => {
  const repo = await createTwoConflictSheetSpreadsheetRepo();

  const loaded = await loadTableConflict({ repoPath: repo, filePath: "data.xlsx" });
  const candidate = await writeTableCandidate({
    repoPath: repo,
    filePath: "data.xlsx",
    sheets: [
      { name: "Sheet1", content: "id,name\n1,theirs-a\n" },
      { name: "Sheet2", content: "id,title\n1,theirs-b\n" }
    ],
    source: "table",
    cellChoices: [
      { sheetName: "Sheet1", row: 1, column: 1, label: "B2", choice: "theirs" },
      { sheetName: "Sheet2", row: 1, column: 1, label: "B2", choice: "theirs" }
    ]
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(path.join(repo, candidate.tableCandidate.candidate)));

  assert.equal(loaded.tableConflict.sheets.length, 2);
  assert.equal(workbook.getWorksheet("Sheet1").getCell("B2").value, "theirs-a");
  assert.equal(workbook.getWorksheet("Sheet2").getCell("B2").value, "theirs-b");
});

test("binary conflict workbench exports ours and theirs without resolving", async () => {
  const repo = await createConflictRepo();

  const result = await exportBinaryConflict({ repoPath: repo, filePath: "data.bytes" });

  assert.equal(result.ok, true);
  assert.match(result.binaryConflict.ours, /\.git\/git-safe-commit-backups\/.+\/binary-conflicts\/data\.bytes\.ours\.bytes/);
  assert.match(result.binaryConflict.theirs, /\.git\/git-safe-commit-backups\/.+\/binary-conflicts\/data\.bytes\.theirs\.bytes/);
  assert.deepEqual([...await readFile(path.join(repo, result.binaryConflict.ours))], [3, 2, 3, 4]);
  assert.deepEqual([...await readFile(path.join(repo, result.binaryConflict.theirs))], [2, 2, 3, 4]);
  assert.match(git(repo, ["status", "--short"]), /^UU data\.bytes/m);
});

async function writeWorkbook(filePath, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  for (const row of rows) sheet.addRow(row);
  sheet.getColumn(2).width = 24;
  sheet.getRow(2).height = 32;
  sheet.getCell("B2").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF123456" }
  };
  sheet.getCell("B2").font = {
    name: "Consolas",
    bold: true,
    color: { argb: "FFFFFFFF" }
  };
  sheet.getCell("B2").alignment = { horizontal: "center" };
  await workbook.xlsx.writeFile(filePath);
}

async function writeWorkbookSheets(filePath, sheets) {
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(name);
    for (const row of rows) sheet.addRow(row);
  }
  await workbook.xlsx.writeFile(filePath);
}

async function readWorkbookRows(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await readFile(filePath));
  const sheet = workbook.worksheets[0];
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = [];
    for (let column = 1; column <= sheet.actualColumnCount; column++) {
      values.push(workbookCellText(row.getCell(column).value));
    }
    rows.push(values);
  });
  return rows;
}

function workbookCellText(value) {
  if (value == null) return "";
  if (typeof value === "object" && "result" in value) return String(value.result ?? "");
  return String(value);
}

test("binary conflict workbench loads sides and writes selected side as candidate without resolving", async () => {
  const repo = await createConflictRepo();

  const loaded = await loadBinaryConflict({ repoPath: repo, filePath: "data.bytes" });
  const candidate = await writeBinaryCandidate({ repoPath: repo, filePath: "data.bytes", choice: "theirs" });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.binaryConflict.path, "data.bytes");
  assert.equal(loaded.binaryConflict.ours.byteLength, 4);
  assert.equal(loaded.binaryConflict.theirs.byteLength, 4);
  assert.equal(candidate.ok, true);
  assert.equal(candidate.binaryCandidate.choice, "theirs");
  assert.match(candidate.binaryCandidate.candidate, /\.git\/git-safe-commit-backups\/.+\/binary-merge-candidates\/data\.selected\.theirs\./);
  assert.deepEqual([...await readFile(path.join(repo, candidate.binaryCandidate.candidate))], [2, 2, 3, 4]);
  assert.match(git(repo, ["status", "--short"]), /^UU data\.bytes/m);
});
