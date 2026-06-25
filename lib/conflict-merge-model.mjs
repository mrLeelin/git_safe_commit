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
  const columnCount = Math.max(
    ...[base, ours, theirs].flatMap((table) => table.map((row) => row.length)),
    0
  );
  const keyCandidates = detectKeyCandidates([base, ours, theirs], columnCount);
  const alignment = alignTableRows(base, ours, theirs, columnCount, options, keyCandidates);
  const alignedRows = alignment.rows;
  const cells = [];
  let conflictCount = 0;
  let autoCount = 0;

  for (let rowIndex = 0; rowIndex < alignedRows.length; rowIndex++) {
    const alignedRow = alignedRows[rowIndex];
    const row = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const baseValue = cellAtRow(alignedRow.base, columnIndex);
      const oursValue = cellAtRow(alignedRow.ours, columnIndex);
      const theirsValue = cellAtRow(alignedRow.theirs, columnIndex);
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
        rowKey: alignedRow.key,
        baseRow: alignedRow.baseRow,
        oursRow: alignedRow.oursRow,
        theirsRow: alignedRow.theirsRow,
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

  return {
    delimiter,
    rowCount: alignedRows.length,
    columnCount,
    cells,
    conflictCount,
    autoCount,
    rowAlignment: alignment.mode,
    keyColumn: alignment.keyColumn,
    keyCandidates
  };
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

function cellAtRow(row, column) {
  return row?.[column] ?? "";
}

function alignTableRows(base, ours, theirs, columnCount, options = {}, keyCandidates = []) {
  const requestedKeyColumn = Number.isInteger(options.keyColumn) ? options.keyColumn : -1;
  if (options.alignment === "index" || options.inferKeys === false) {
    return { mode: "index", keyColumn: -1, rows: alignTableRowsByIndex(base, ours, theirs) };
  }

  const tables = [base, ours, theirs];
  const forced = options.alignment === "key" || options.inferKeys === true || requestedKeyColumn >= 0;
  const keyColumn = requestedKeyColumn >= 0
    ? requestedKeyColumn
    : forced
      ? detectKeyColumn(tables, columnCount)
      : chooseAutoKeyColumn(tables, columnCount);
  if (keyColumn < 0) {
    return { mode: "index", keyColumn: -1, rows: alignTableRowsByIndex(base, ours, theirs) };
  }
  if (requestedKeyColumn >= 0 && !keyCandidates.some((candidate) => candidate.column === requestedKeyColumn)) {
    return { mode: "index", keyColumn: -1, rows: alignTableRowsByIndex(base, ours, theirs) };
  }

  const baseRows = keyRows(base, keyColumn);
  const oursRows = keyRows(ours, keyColumn);
  const theirsRows = keyRows(theirs, keyColumn);
  const order = keyedRowOrder(baseRows.keys, oursRows.keys, theirsRows.keys);

  return {
    mode: requestedKeyColumn >= 0 ? "manual-key" : forced ? "key" : "auto-key",
    keyColumn,
    rows: order.map((key) => {
    const baseEntry = baseRows.map.get(key);
    const oursEntry = oursRows.map.get(key);
    const theirsEntry = theirsRows.map.get(key);
    return {
      key,
      base: baseEntry?.row || [],
      ours: oursEntry?.row || [],
      theirs: theirsEntry?.row || [],
      baseRow: baseEntry?.index ?? "",
      oursRow: oursEntry?.index ?? "",
      theirsRow: theirsEntry?.index ?? ""
    };
    })
  };
}

function detectKeyCandidates(tables, columnCount) {
  return Array.from({ length: columnCount }, (_, column) => {
    const analysis = analyzeKeyColumn(tables, column);
    return {
      column,
      header: tables[0]?.[0]?.[column] || columnName(column),
      usable: analysis.usable,
      overlap: analysis.overlap,
      filled: analysis.filled,
      explicit: isExplicitKeyHeader(tables, column)
    };
  }).filter((candidate) => candidate.usable);
}

function alignTableRowsByIndex(base, ours, theirs) {
  const rowCount = Math.max(base.length, ours.length, theirs.length);
  return Array.from({ length: rowCount }, (_, rowIndex) => ({
    key: "",
    base: base[rowIndex] || [],
    ours: ours[rowIndex] || [],
    theirs: theirs[rowIndex] || [],
    baseRow: rowIndex,
    oursRow: rowIndex,
    theirsRow: rowIndex
  }));
}

function detectKeyColumn(tables, columnCount) {
  const headerColumn = detectHeaderKeyColumn(tables, columnCount);
  if (headerColumn >= 0 && isUsableKeyColumn(tables, headerColumn)) return headerColumn;

  return detectHeuristicKeyColumn(tables, columnCount);
}

function chooseAutoKeyColumn(tables, columnCount) {
  const headerColumn = detectHeaderKeyColumn(tables, columnCount);
  if (headerColumn >= 0 && isUsableKeyColumn(tables, headerColumn)) return headerColumn;

  const heuristicColumn = detectHeuristicKeyColumn(tables, columnCount);
  if (heuristicColumn < 0) return -1;
  return tableShapeSuggestsRowIdentityChanged(tables, heuristicColumn) ? heuristicColumn : -1;
}

function detectHeuristicKeyColumn(tables, columnCount) {
  let bestColumn = -1;
  let bestScore = 0;
  for (let column = 0; column < columnCount; column++) {
    const analysis = analyzeKeyColumn(tables, column);
    if (!analysis.usable) continue;
    const score = analysis.overlap * 100 + analysis.filled * 10 - column;
    if (score > bestScore) {
      bestScore = score;
      bestColumn = column;
    }
  }
  return bestColumn;
}

function tableShapeSuggestsRowIdentityChanged(tables, keyColumn) {
  const baseKeys = keySequence(tables[0], keyColumn);
  return tables.slice(1).some((table) => {
    const keys = keySequence(table, keyColumn);
    if (keys.length !== baseKeys.length) return true;
    if (sameSequence(keys, baseKeys)) return false;
    return sameKeySet(keys, baseKeys);
  });
}

function detectHeaderKeyColumn(tables, columnCount) {
  for (let column = 0; column < columnCount; column++) {
    if (isExplicitKeyHeader(tables, column)) return column;
  }
  return -1;
}

function isExplicitKeyHeader(tables, column) {
  const headerNames = new Set(["key", "id", "rowkey", "row_key", "rowid", "row_id"]);
  return tables.some((table) => headerNames.has(normalizeKey(table[0]?.[column]).toLowerCase()));
}

function isUsableKeyColumn(tables, column) {
  return analyzeKeyColumn(tables, column).usable;
}

function analyzeKeyColumn(tables, column) {
  const sets = [];
  let filled = 0;
  for (const table of tables) {
    const keys = new Set();
    for (const row of table) {
      const key = normalizeKey(row?.[column]);
      if (!key) continue;
      if (keys.has(key)) return { usable: false, overlap: 0, filled };
      keys.add(key);
    }
    filled += keys.size;
    sets.push(keys);
  }

  const allKeys = new Set(sets.flatMap((set) => [...set]));
  let overlap = 0;
  for (const key of allKeys) {
    const appearances = sets.filter((set) => set.has(key)).length;
    if (appearances > 1) overlap++;
  }

  return { usable: overlap > 0, overlap, filled };
}

function keyRows(table, keyColumn) {
  const keys = [];
  const map = new Map();
  for (let index = 0; index < table.length; index++) {
    const row = table[index];
    const key = normalizeKey(row?.[keyColumn]) || `__row:${index}`;
    if (!map.has(key)) keys.push(key);
    map.set(key, { row, index });
  }
  return { keys, map };
}

function keyedRowOrder(baseKeys, oursKeys, theirsKeys) {
  const baseKeySet = new Set(baseKeys);
  const seen = new Set();
  const order = [];
  let oursCursor = 0;
  let theirsCursor = 0;

  function push(key) {
    if (seen.has(key)) return;
    seen.add(key);
    order.push(key);
  }

  function appendInsertedBefore(keys, cursor, anchorKey) {
    const anchorIndex = keys.indexOf(anchorKey, cursor);
    if (anchorIndex < 0) return cursor;
    for (let index = cursor; index < anchorIndex; index++) {
      const key = keys[index];
      if (!baseKeySet.has(key)) push(key);
    }
    return anchorIndex + 1;
  }

  for (const baseKey of baseKeys) {
    oursCursor = appendInsertedBefore(oursKeys, oursCursor, baseKey);
    theirsCursor = appendInsertedBefore(theirsKeys, theirsCursor, baseKey);
    push(baseKey);
  }

  for (let index = oursCursor; index < oursKeys.length; index++) {
    if (!baseKeySet.has(oursKeys[index])) push(oursKeys[index]);
  }
  for (let index = theirsCursor; index < theirsKeys.length; index++) {
    if (!baseKeySet.has(theirsKeys[index])) push(theirsKeys[index]);
  }

  return order;
}

function normalizeKey(value) {
  return String(value ?? "").trim();
}

function keySequence(table, column) {
  return table.map((row) => normalizeKey(row?.[column])).filter(Boolean);
}

function sameSequence(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameKeySet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
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
