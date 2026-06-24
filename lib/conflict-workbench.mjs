import path from "node:path";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import ExcelJS from "exceljs";

import { pathInsideRepo, runGit as runGitDefault } from "./git-executor.mjs";
import { buildTableMerge } from "../src/conflict-merge-model.js";

const TextConflictExtensions = new Set([
  ".cs", ".asmdef", ".asmref", ".js", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".ps1", ".sh", ".bat", ".cmd",
  ".java", ".kt", ".cpp", ".h", ".hpp", ".c", ".go", ".rs", ".md", ".txt", ".json", ".jsonc", ".xml",
  ".yml", ".yaml", ".toml", ".ini", ".editorconfig", ".gitignore", ".gitattributes", ".shader", ".hlsl",
  ".cginc", ".compute", ".uss", ".uxml"
]);
const TableConflictExtensions = new Set([".csv", ".tsv", ".xlsx"]);
const SpreadsheetConflictExtensions = new Set([".xlsx"]);

export async function loadTextConflict({ repoPath, filePath, runGit = runGitDefault } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  assertTextConflict(relative);
  await assertUnmerged(repoPath, relative, runGit);
  const [base, ours, theirs] = await Promise.all([
    readGitStageText(repoPath, relative, 1, runGit),
    readGitStageText(repoPath, relative, 2, runGit),
    readGitStageText(repoPath, relative, 3, runGit)
  ]);
  let current = { available: true, content: "", error: "" };
  try {
    current.content = await readFile(path.resolve(repoPath, relative), "utf8");
  } catch (error) {
    current = { available: false, content: "", error: error.message || String(error) };
  }
  return { ok: true, textConflict: { path: relative, finalPath: relative, base, ours, theirs, current } };
}

export async function writeTextCandidate({ repoPath, filePath, content = "", source = "edited", lineChoices = [] } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  assertTextConflict(relative);
  const candidateRoot = path.join(repoPath, ".git", "git-safe-commit-backups", timestamp(), "text-merge-candidates");
  await mkdir(candidateRoot, { recursive: true });
  const ext = path.extname(relative);
  const baseName = path.basename(relative, ext).replace(/[^a-zA-Z0-9._-]/g, "_") || "merged";
  const outputPath = path.join(candidateRoot, `${baseName}.merged.${timestamp()}${ext || ".txt"}`);
  const choicePath = path.join(candidateRoot, `${baseName}.choices.${timestamp()}.json`);
  const choices = {
    path: relative,
    source: String(source || "edited"),
    lineChoices: Array.isArray(lineChoices) ? lineChoices : [],
    contentLength: String(content).length,
    finalPath: relative
  };
  await writeFile(outputPath, String(content), "utf8");
  await writeFile(choicePath, JSON.stringify(choices, null, 2), "utf8");
  return {
    ok: true,
    textCandidate: {
      path: relative,
      candidate: toRepoRelative(repoPath, outputPath),
      choices: toRepoRelative(repoPath, choicePath),
      finalPath: relative,
      source: choices.source
    }
  };
}

export async function applyConflictCandidate({ repoPath, filePath, candidatePath, runGit = runGitDefault } = {}) {
  const target = pathInsideRepo(repoPath, filePath);
  if (!candidatePath || typeof candidatePath !== "string") throw new Error("candidate path is required");
  const candidate = pathInsideRepo(target.root, candidatePath);
  if (!candidate.relative.startsWith(".git/git-safe-commit-backups/")) {
    throw new Error("candidate path must be inside .git/git-safe-commit-backups");
  }
  await assertUnmerged(target.root, target.relative, runGit);
  await copyFile(candidate.fullPath, target.fullPath);
  const add = await runGit(target.root, ["add", "--", target.relative]);
  if (!add.ok) {
    throw new Error(add.stderr || add.error || `git add failed for ${target.relative}`);
  }
  return {
    ok: true,
    appliedConflict: {
      path: target.relative,
      candidate: candidate.relative,
      staged: true
    }
  };
}

export async function loadTableConflict({ repoPath, filePath, runGit = runGitDefault } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  assertTableConflict(relative);
  await assertUnmerged(repoPath, relative, runGit);
  const ext = path.extname(relative).toLowerCase();
  const readStage = SpreadsheetConflictExtensions.has(ext) ? readGitStageSpreadsheet : readGitStageText;
  const [base, ours, theirs] = await Promise.all([
    readStage(repoPath, relative, 1, runGit),
    readStage(repoPath, relative, 2, runGit),
    readStage(repoPath, relative, 3, runGit)
  ]);
  const delimiter = ext === ".tsv" ? "\t" : ",";
  return {
    ok: true,
    tableConflict: {
      path: relative,
      finalPath: relative,
      base,
      ours,
      theirs,
      merge: buildTableMerge(base.content, ours.content, theirs.content, { delimiter })
    }
  };
}

export async function writeTableCandidate({ repoPath, filePath, content = "", source = "table", cellChoices = [], runGit = runGitDefault } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  assertTableConflict(relative);
  const candidateRoot = path.join(repoPath, ".git", "git-safe-commit-backups", timestamp(), "table-merge-candidates");
  await mkdir(candidateRoot, { recursive: true });
  const ext = path.extname(relative);
  const baseName = path.basename(relative, ext).replace(/[^a-zA-Z0-9._-]/g, "_") || "merged";
  const outputPath = path.join(candidateRoot, `${baseName}.merged.${timestamp()}${ext || ".csv"}`);
  const choicePath = path.join(candidateRoot, `${baseName}.choices.${timestamp()}.json`);
  const choices = {
    path: relative,
    source: String(source || "table"),
    cellChoices: Array.isArray(cellChoices) ? cellChoices : [],
    contentLength: String(content).length,
    finalPath: relative
  };
  if (SpreadsheetConflictExtensions.has(ext.toLowerCase())) {
    const ours = await readGitStageRaw(repoPath, relative, 2, runGit);
    if (!ours.ok) {
      throw new Error(ours.stderr || ours.error || `spreadsheet template stage is unavailable: ${relative}`);
    }
    await writeFile(outputPath, await tableTextToWorkbookBuffer(String(content), { templateBuffer: ours.stdout }));
  } else {
    await writeFile(outputPath, String(content), "utf8");
  }
  await writeFile(choicePath, JSON.stringify(choices, null, 2), "utf8");
  return {
    ok: true,
    tableCandidate: {
      path: relative,
      candidate: toRepoRelative(repoPath, outputPath),
      choices: toRepoRelative(repoPath, choicePath),
      finalPath: relative,
      source: choices.source
    }
  };
}

export async function loadBinaryConflict({ repoPath, filePath, runGit = runGitDefault } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  await assertUnmerged(repoPath, relative, runGit);
  const [base, ours, theirs] = await Promise.all([
    readGitStageRaw(repoPath, relative, 1, runGit),
    readGitStageRaw(repoPath, relative, 2, runGit),
    readGitStageRaw(repoPath, relative, 3, runGit)
  ]);
  if (!ours.ok || !theirs.ok) {
    throw new Error(`binary conflict stages are unavailable: ${relative}`);
  }
  return {
    ok: true,
    binaryConflict: {
      path: relative,
      finalPath: relative,
      base: binaryStageInfo(base, 1),
      ours: binaryStageInfo(ours, 2),
      theirs: binaryStageInfo(theirs, 3)
    }
  };
}

export async function writeBinaryCandidate({ repoPath, filePath, choice = "ours", runGit = runGitDefault } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  const side = String(choice || "ours").toLowerCase();
  if (!["ours", "theirs"].includes(side)) {
    throw new Error(`binary candidate choice must be ours or theirs: ${choice}`);
  }
  await assertUnmerged(repoPath, relative, runGit);
  const stage = side === "ours" ? 2 : 3;
  const selected = await readGitStageRaw(repoPath, relative, stage, runGit);
  if (!selected.ok) {
    throw new Error(`binary conflict stage ${stage} is unavailable: ${relative}`);
  }
  const candidateRoot = path.join(repoPath, ".git", "git-safe-commit-backups", timestamp(), "binary-merge-candidates");
  await mkdir(candidateRoot, { recursive: true });
  const ext = path.extname(relative) || ".bin";
  const baseName = path.basename(relative, ext).replace(/[^a-zA-Z0-9._-]/g, "_") || "binary";
  const outputPath = path.join(candidateRoot, `${baseName}.selected.${side}.${timestamp()}${ext}`);
  await writeFile(outputPath, selected.stdout);
  return {
    ok: true,
    binaryCandidate: {
      path: relative,
      candidate: toRepoRelative(repoPath, outputPath),
      finalPath: relative,
      choice: side,
      stage,
      byteLength: selected.stdout.length
    }
  };
}

export async function exportBinaryConflict({ repoPath, filePath, runGit = runGitDefault } = {}) {
  const relative = validateConflictPath(repoPath, filePath);
  await assertUnmerged(repoPath, relative, runGit);
  const binaryRoot = path.join(repoPath, ".git", "git-safe-commit-backups", timestamp(), "binary-conflicts");
  await mkdir(binaryRoot, { recursive: true });
  const ext = path.extname(relative) || ".bin";
  const name = path.basename(relative);
  const basePath = path.join(binaryRoot, `${name}.base${ext}`);
  const oursPath = path.join(binaryRoot, `${name}.ours${ext}`);
  const theirsPath = path.join(binaryRoot, `${name}.theirs${ext}`);
  const [base, ours, theirs] = await Promise.all([
    readGitStageRaw(repoPath, relative, 1, runGit),
    readGitStageRaw(repoPath, relative, 2, runGit),
    readGitStageRaw(repoPath, relative, 3, runGit)
  ]);
  if (base.ok) await writeFile(basePath, base.stdout, "utf8");
  if (!ours.ok || !theirs.ok) {
    throw new Error(`binary conflict stages are unavailable: ${relative}`);
  }
  await writeFile(oursPath, ours.stdout, "utf8");
  await writeFile(theirsPath, theirs.stdout, "utf8");
  return {
    ok: true,
    binaryConflict: {
      path: relative,
      base: base.ok ? toRepoRelative(repoPath, basePath) : "",
      ours: toRepoRelative(repoPath, oursPath),
      theirs: toRepoRelative(repoPath, theirsPath),
      finalPath: relative
    }
  };
}

function validateConflictPath(repoPath, filePath) {
  if (!filePath || typeof filePath !== "string") throw new Error("conflict path is required");
  return pathInsideRepo(repoPath, filePath).relative;
}

function assertTextConflict(filePath) {
  const ext = path.extname(filePath);
  if (!TextConflictExtensions.has(ext) && !TextConflictExtensions.has(path.basename(filePath))) {
    throw new Error(`text conflict workbench does not support this file type: ${filePath}`);
  }
}

function assertTableConflict(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!TableConflictExtensions.has(ext)) {
    throw new Error(`table conflict workbench does not support this file type: ${filePath}`);
  }
}

async function assertUnmerged(repoPath, filePath, runGit) {
  const result = await runGit(repoPath, ["ls-files", "-u", "--", filePath]);
  if (!result.ok || !result.stdout.trim()) {
    throw new Error(`no unmerged stages found for ${filePath}`);
  }
}

async function readGitStageText(repoPath, filePath, stage, runGit) {
  const result = await readGitStageRaw(repoPath, filePath, stage, runGit);
  return {
    stage,
    available: result.ok,
    content: result.ok ? result.stdout.toString("utf8") : "",
    byteLength: result.ok ? result.stdout.length : 0,
    error: result.ok ? "" : (result.stderr || result.error || `stage ${stage} is unavailable`)
  };
}

async function readGitStageSpreadsheet(repoPath, filePath, stage, runGit) {
  const result = await readGitStageRaw(repoPath, filePath, stage, runGit);
  let content = "";
  let error = "";
  if (result.ok) {
    try {
      content = await workbookBufferToCsv(result.stdout);
    } catch (parseError) {
      error = parseError.message || String(parseError);
    }
  }
  return {
    stage,
    available: result.ok && !error,
    content,
    byteLength: result.ok ? result.stdout.length : 0,
    error: result.ok ? error : (result.stderr || result.error || `stage ${stage} is unavailable`)
  };
}

async function readGitStageRaw(repoPath, filePath, stage, runGit) {
  return runGit(repoPath, ["show", `:${stage}:${filePath}`], { encoding: "buffer" });
}

function binaryStageInfo(result, stage) {
  return {
    stage,
    available: result.ok,
    byteLength: result.ok ? result.stdout.length : 0,
    error: result.ok ? "" : (result.stderr || result.error || `stage ${stage} is unavailable`)
  };
}

function toRepoRelative(repoPath, targetPath) {
  return path.relative(repoPath, targetPath).replaceAll("\\", "/");
}

async function workbookBufferToCsv(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return "";
  const rows = [];
  const columnCount = sheet.actualColumnCount || sheet.columnCount || 0;
  const rowCount = sheet.rowCount || sheet.actualRowCount || 0;
  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const values = [];
    for (let column = 1; column <= columnCount; column++) {
      values.push(formatCsvCell(excelCellToText(row.getCell(column).value)));
    }
    rows.push(values.join(","));
  }
  return rows.join("\n");
}

async function tableTextToWorkbookBuffer(content, options = {}) {
  const workbook = new ExcelJS.Workbook();
  let sheet;
  if (options.templateBuffer?.length) {
    await workbook.xlsx.load(options.templateBuffer);
    sheet = workbook.worksheets[0] || workbook.addWorksheet("Sheet1");
  } else {
    sheet = workbook.addWorksheet("Sheet1");
  }
  applyTableRowsToSheet(sheet, parseCsvTable(content));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function parseCsvTable(content) {
  const normalized = String(content || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === "\"") {
      if (quoted && normalized[index + 1] === "\"") {
        cell += "\"";
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" && !quoted) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length || !rows.length) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length > 1 && rows.at(-1).length === 1 && rows.at(-1)[0] === "") rows.pop();
  return rows;
}

function applyTableRowsToSheet(sheet, rows) {
  const maxColumns = Math.max(0, ...rows.map((row) => row.length));
  for (let column = 1; column <= maxColumns; column++) {
    const targetColumn = sheet.getColumn(column);
    if (!targetColumn.width && column > 1) {
      const previousWidth = sheet.getColumn(column - 1).width;
      if (previousWidth) targetColumn.width = previousWidth;
    }
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const rowNumber = rowIndex + 1;
    const row = sheet.getRow(rowNumber);
    if (!row.height && rowNumber > 1) {
      const previousHeight = sheet.getRow(rowNumber - 1).height;
      if (previousHeight) row.height = previousHeight;
    }
    for (let columnIndex = 0; columnIndex < maxColumns; columnIndex++) {
      const cell = row.getCell(columnIndex + 1);
      const nextText = rows[rowIndex]?.[columnIndex] ?? "";
      copyNeighborStyleIfEmpty(sheet, cell, rowNumber, columnIndex + 1);
      if (excelCellToText(cell.value) !== nextText) {
        cell.value = nextText;
      }
    }
  }
}

function copyNeighborStyleIfEmpty(sheet, cell, rowNumber, columnNumber) {
  if (Object.keys(cell.style || {}).length > 0) return;
  const source = rowNumber > 1
    ? sheet.getRow(rowNumber - 1).getCell(columnNumber)
    : columnNumber > 1
      ? sheet.getRow(rowNumber).getCell(columnNumber - 1)
      : null;
  if (source && Object.keys(source.style || {}).length > 0) {
    cell.style = JSON.parse(JSON.stringify(source.style));
  }
}

function excelCellToText(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    if ("text" in value) return String(value.text ?? "");
    if ("result" in value) return String(value.result ?? "");
    if ("hyperlink" in value) return String(value.text ?? value.hyperlink ?? "");
    return String(value);
  }
  return String(value);
}

function formatCsvCell(value) {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "\"") {
      if (quoted && line[index + 1] === "\"") {
        cell += "\"";
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
