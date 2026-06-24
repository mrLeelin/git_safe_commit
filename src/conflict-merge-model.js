const MergeChoices = new Set(["ours", "theirs", "both", "none"]);
const TableChoices = new Set(["ours", "theirs", "both", "none"]);

export function buildLineMergeRows(oursText = "", theirsText = "") {
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);
  const pairs = lcsPairs(ours, theirs);
  const rows = [];
  let left = 0;
  let right = 0;

  function pushChanged(untilLeft, untilRight) {
    const leftBlock = ours.slice(left, untilLeft);
    const rightBlock = theirs.slice(right, untilRight);
    const count = Math.max(leftBlock.length, rightBlock.length);
    for (let offset = 0; offset < count; offset++) {
      const oursLine = leftBlock[offset] ?? "";
      const theirsLine = rightBlock[offset] ?? "";
      rows.push({
        id: rows.length,
        kind: "changed",
        oursLineNumber: offset < leftBlock.length ? left + offset + 1 : "",
        theirsLineNumber: offset < rightBlock.length ? right + offset + 1 : "",
        ours: oursLine,
        theirs: theirsLine,
        choice: oursLine && theirsLine && oursLine !== theirsLine ? "both" : oursLine ? "ours" : "theirs"
      });
    }
  }

  for (const [nextLeft, nextRight] of pairs) {
    pushChanged(nextLeft, nextRight);
    rows.push({
      id: rows.length,
      kind: "same",
      oursLineNumber: nextLeft + 1,
      theirsLineNumber: nextRight + 1,
      ours: ours[nextLeft],
      theirs: theirs[nextRight],
      choice: "both"
    });
    left = nextLeft + 1;
    right = nextRight + 1;
  }

  pushChanged(ours.length, theirs.length);
  return rows;
}

export function composeLineDraft(rows = []) {
  return rows.flatMap(rowContent).join("\n");
}

export function lineChoiceSummary(rows = []) {
  return rows
    .filter((row) => row.kind === "changed")
    .map((row) => ({
      row: row.id,
      oursLine: row.oursLineNumber,
      theirsLine: row.theirsLineNumber,
      choice: row.choice,
      ours: row.ours,
      theirs: row.theirs
    }));
}

export function buildTableMerge(baseText = "", oursText = "", theirsText = "", options = {}) {
  const delimiter = options.delimiter || detectDelimiter(baseText, oursText, theirsText);
  const base = parseDelimitedTable(baseText, delimiter);
  const ours = parseDelimitedTable(oursText, delimiter);
  const theirs = parseDelimitedTable(theirsText, delimiter);
  const rowCount = Math.max(base.length, ours.length, theirs.length);
  const columnCount = Math.max(
    ...[base, ours, theirs].flatMap((table) => table.map((row) => row.length)),
    0
  );
  const cells = [];
  let conflictCount = 0;
  let autoCount = 0;

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const baseValue = cellAt(base, rowIndex, columnIndex);
      const oursValue = cellAt(ours, rowIndex, columnIndex);
      const theirsValue = cellAt(theirs, rowIndex, columnIndex);
      const oursChanged = oursValue !== baseValue;
      const theirsChanged = theirsValue !== baseValue;
      let kind = "same";
      let value = baseValue;
      let choice = "";

      if (oursValue === theirsValue) {
        value = oursValue;
        kind = oursChanged || theirsChanged ? "same-change" : "same";
      } else if (oursChanged && theirsChanged) {
        kind = "conflict";
        value = oursValue;
        choice = "ours";
        conflictCount++;
      } else if (oursChanged) {
        kind = "auto-ours";
        value = oursValue;
        autoCount++;
      } else if (theirsChanged) {
        kind = "auto-theirs";
        value = theirsValue;
        autoCount++;
      }

      row.push({
        id: `${rowIndex}:${columnIndex}`,
        row: rowIndex,
        column: columnIndex,
        label: `${columnName(columnIndex)}${rowIndex + 1}`,
        kind,
        base: baseValue,
        ours: oursValue,
        theirs: theirsValue,
        value,
        choice
      });
    }
    cells.push(row);
  }

  return { delimiter, rowCount, columnCount, cells, conflictCount, autoCount };
}

export function composeTableDraft(table, options = {}) {
  const delimiter = table?.delimiter || ",";
  return composeTableRows(table, options)
    .map((row) => row.map((value) => formatDelimitedCell(value, delimiter)).join(delimiter))
    .join("\n");
}

export function composeTableRows(table, options = {}) {
  return options.bothStrategy === "columns"
    ? composeTableRowsWithBothColumns(table)
    : composeTableRowsWithBothRows(table);
}

export function tableChoiceSummary(table) {
  return (table?.cells || [])
    .flatMap((row) => row)
    .filter((cell) => cell.kind === "conflict")
    .map((cell) => ({
      row: cell.row,
      column: cell.column,
      label: cell.label,
      choice: TableChoices.has(cell.choice) ? cell.choice : "ours",
      ours: cell.ours,
      theirs: cell.theirs
    }));
}

function rowContent(row) {
  if (row.kind === "same") return [row.ours];
  if (row.choice === "ours") return row.ours ? [row.ours] : [];
  if (row.choice === "theirs") return row.theirs ? [row.theirs] : [];
  if (row.choice === "both") {
    const result = [];
    if (row.ours) result.push(row.ours);
    if (row.theirs && row.theirs !== row.ours) result.push(row.theirs);
    return result;
  }
  return [];
}

function splitLines(content) {
  const lines = String(content || "").split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function lcsPairs(left, right) {
  const dp = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

export function isMergeChoice(choice) {
  return MergeChoices.has(choice);
}

export function isTableChoice(choice) {
  return TableChoices.has(choice);
}

function detectDelimiter(...texts) {
  const sample = texts.find((text) => String(text || "").includes("\t")) || "";
  return sample.includes("\t") ? "\t" : ",";
}

function parseDelimitedTable(content, delimiter) {
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
    } else if (char === delimiter && !quoted) {
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

function parseDelimitedLine(line, delimiter) {
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
    } else if (char === delimiter && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

function cellAt(table, row, column) {
  return table[row]?.[column] ?? "";
}

function composeTableRowsWithBothRows(table) {
  return (table?.cells || []).flatMap((row) => {
    const hasBoth = row.some(isDistinctBothCell);
    const rows = [row.map((cell) => tableCellValue(cell, "ours"))];
    if (hasBoth) rows.push(row.map((cell) => tableCellValue(cell, "theirs")));
    return rows;
  });
}

function composeTableRowsWithBothColumns(table) {
  const cells = table?.cells || [];
  const bothColumns = new Set();
  for (const row of cells) {
    for (const cell of row) {
      if (isDistinctBothCell(cell)) bothColumns.add(cell.column);
    }
  }

  return cells.map((row, rowIndex) => {
    const output = [];
    for (const cell of row) {
      output.push(tableCellValue(cell, "ours"));
      if (bothColumns.has(cell.column)) {
        output.push(rowIndex === 0 ? bothColumnHeader(cell) : bothColumnValue(cell));
      }
    }
    return output;
  });
}

function bothColumnHeader(cell) {
  const header = tableCellValue(cell, "ours") || columnName(cell?.column ?? 0);
  return `${header}_THEIRS`;
}

function bothColumnValue(cell) {
  return isDistinctBothCell(cell) ? cell.theirs : "";
}

function isDistinctBothCell(cell) {
  return cell?.kind === "conflict" && cell.choice === "both" && cell.theirs !== cell.ours;
}

function tableCellValue(cell, bothSide = "ours") {
  if (cell?.kind === "conflict") {
    if (cell.choice === "both") return bothSide === "theirs" ? cell.theirs : cell.ours;
    if (cell.choice === "none") return "";
    return cell.choice === "theirs" ? cell.theirs : cell.ours;
  }
  return cell?.value ?? "";
}

function formatDelimitedCell(value, delimiter) {
  const text = String(value ?? "");
  if (!text.includes(delimiter) && !text.includes("\"") && !/[\r\n]/.test(text)) return text;
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value--;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}
