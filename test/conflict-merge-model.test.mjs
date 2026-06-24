import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTableMerge,
  buildLineMergeRows,
  composeLineDraft,
  composeTableDraft,
  lineChoiceSummary,
  tableChoiceSummary
} from "../src/conflict-merge-model.js";

test("buildLineMergeRows marks changed rows and defaults to keeping both sides", () => {
  const rows = buildLineMergeRows("same\nours only\nend", "same\ntheirs only\nend");

  assert.equal(rows.length, 3);
  assert.equal(rows[0].kind, "same");
  assert.equal(rows[1].kind, "changed");
  assert.equal(rows[1].choice, "both");
  assert.equal(rows[1].ours, "ours only");
  assert.equal(rows[1].theirs, "theirs only");
  assert.equal(rows[2].kind, "same");
});

test("composeLineDraft applies ours theirs both and none choices", () => {
  const rows = buildLineMergeRows("a\nleft\nb", "a\nright\nb");
  rows[1].choice = "ours";
  assert.equal(composeLineDraft(rows), "a\nleft\nb");

  rows[1].choice = "theirs";
  assert.equal(composeLineDraft(rows), "a\nright\nb");

  rows[1].choice = "both";
  assert.equal(composeLineDraft(rows), "a\nleft\nright\nb");

  rows[1].choice = "none";
  assert.equal(composeLineDraft(rows), "a\nb");
});

test("lineChoiceSummary returns only changed rows", () => {
  const rows = buildLineMergeRows("a\nleft\nb", "a\nright\nb");

  assert.deepEqual(lineChoiceSummary(rows), [{
    row: 1,
    oursLine: 2,
    theirsLine: 2,
    choice: "both",
    ours: "left",
    theirs: "right"
  }]);
});

test("buildTableMerge flags same-cell conflicts and auto merges different cells", () => {
  const base = "id,name,score,note\n1,Alice,10,base\n";
  const ours = "id,name,score,note\n1,Alicia,11,base\n";
  const theirs = "id,name,score,note\n1,Ally,10,theirs\n";

  const table = buildTableMerge(base, ours, theirs, { delimiter: "," });

  assert.equal(table.conflictCount, 1);
  assert.equal(table.autoCount, 2);
  assert.equal(table.cells[1][1].kind, "conflict");
  assert.equal(table.cells[1][1].base, "Alice");
  assert.equal(table.cells[1][1].ours, "Alicia");
  assert.equal(table.cells[1][1].theirs, "Ally");
  assert.equal(table.cells[1][2].kind, "auto-ours");
  assert.equal(table.cells[1][2].value, "11");
  assert.equal(table.cells[1][3].kind, "auto-theirs");
  assert.equal(table.cells[1][3].value, "theirs");
  assert.equal(composeTableDraft(table), "id,name,score,note\n1,Alicia,11,theirs");
});

test("buildTableMerge aligns keyed rows before comparing cells", () => {
  const base = [
    "index,key,zh,en",
    ",net_error_describe_-15,dynamodb 数据库异常,DynamoDB database error",
    ",language_title,语言:,Language:123"
  ].join("\n");
  const ours = [
    "index,key,zh,en",
    ",net_error_describe_-10,更新数据失败,Failed to update data",
    ",net_error_describe_-15,dynamodb 数据库异常,DynamoDB database error",
    ",language_title,语言:,Language:456"
  ].join("\n");
  const theirs = [
    "index,key,zh,en",
    ",net_error_describe_-15,dynamodb 数据库异常,DynamoDB database error",
    ",language_title,语言:111111111111112312312,Language:456"
  ].join("\n");

  const table = buildTableMerge(base, ours, theirs, { delimiter: "," });
  const keyedCells = table.cells.flatMap((row) => row).filter((cell) => cell.rowKey === "language_title");

  assert.equal(
    keyedCells.some((cell) => cell.ours === "net_error_describe_-15" || cell.theirs === "net_error_describe_-15"),
    false
  );
  assert.equal(keyedCells.find((cell) => cell.column === 2).kind, "auto-theirs");
  assert.equal(keyedCells.find((cell) => cell.column === 2).theirs, "语言:111111111111112312312");
  assert.equal(keyedCells.find((cell) => cell.column === 3).kind, "same-change");
  assert.equal(keyedCells.find((cell) => cell.column === 3).value, "Language:456");
});

test("buildTableMerge can merge same-row edits when the first column is editable data", () => {
  const base = "##var#column,##group,##type,##,value\nguild_open_level,,int,引导开启等级,1\n";
  const ours = "##var#column,##group,##type,##,value\nguild_open_level_123,,int,引导开启等级,1\n";
  const theirs = "##var#column,##group,##type,##,value\nguild_open_level,,int123323,引导开启等级,1\n";

  const table = buildTableMerge(base, ours, theirs);

  assert.equal(table.conflictCount, 0);
  assert.equal(table.autoCount, 2);
  assert.equal(table.rowAlignment, "index");
  assert.equal(table.cells[1][0].kind, "auto-ours");
  assert.equal(table.cells[1][2].kind, "auto-theirs");
  assert.equal(composeTableDraft(table), "##var#column,##group,##type,##,value\nguild_open_level_123,,int123323,引导开启等级,1");
});

test("buildTableMerge uses heuristic row keys when inserted rows make indexes unreliable", () => {
  const base = [
    "var,type,value",
    "alpha,int,1",
    "beta,string,b"
  ].join("\n");
  const ours = [
    "var,type,value",
    "new_flag,bool,true",
    "alpha,int,1",
    "beta,string,b-ours"
  ].join("\n");
  const theirs = [
    "var,type,value",
    "alpha,int,2",
    "beta,string,b"
  ].join("\n");

  const table = buildTableMerge(base, ours, theirs);
  const betaCells = table.cells.flatMap((row) => row).filter((cell) => cell.rowKey === "beta");
  const alphaCells = table.cells.flatMap((row) => row).filter((cell) => cell.rowKey === "alpha");

  assert.equal(table.rowAlignment, "auto-key");
  assert.equal(betaCells.find((cell) => cell.column === 2).kind, "auto-ours");
  assert.equal(alphaCells.find((cell) => cell.column === 2).kind, "auto-theirs");
  assert.equal(composeTableDraft(table), "var,type,value\nnew_flag,bool,true\nalpha,int,2\nbeta,string,b-ours");
});

test("buildTableMerge lets callers force a key column when auto alignment is too conservative", () => {
  const base = "var,type,value\nalpha,int,1\nbeta,string,b";
  const ours = "var,type,value\nbeta,string,b-ours\nalpha,int,1";
  const theirs = "var,type,value\nalpha,int,2\nbeta,string,b";

  const byIndex = buildTableMerge(base, ours, theirs, { alignment: "index" });
  const byKey = buildTableMerge(base, ours, theirs, { alignment: "key", keyColumn: 0 });
  const betaCells = byKey.cells.flatMap((row) => row).filter((cell) => cell.rowKey === "beta");

  assert.equal(byIndex.rowAlignment, "index");
  assert.equal(byKey.rowAlignment, "manual-key");
  assert.equal(byKey.keyColumn, 0);
  assert.equal(byKey.keyCandidates.some((candidate) => candidate.column === 0), true);
  assert.equal(betaCells.find((cell) => cell.column === 2).kind, "auto-ours");
});

test("composeTableDraft writes table BOTH as a new row by default", () => {
  const base = "id,name\n1,Alice\n";
  const ours = "id,name\n1,Alicia\n";
  const theirs = "id,name\n1,Ally\n";
  const table = buildTableMerge(base, ours, theirs, { delimiter: "," });

  table.cells[1][1].choice = "both";
  assert.equal(composeTableDraft(table), "id,name\n1,Alicia\n1,Ally");
  assert.deepEqual(tableChoiceSummary(table), [{
    row: 1,
    column: 1,
    label: "B2",
    choice: "both",
    ours: "Alicia",
    theirs: "Ally"
  }]);

  table.cells[1][1].choice = "none";
  assert.equal(composeTableDraft(table), "id,name\n1,");
});

test("composeTableDraft can write table BOTH as a new column", () => {
  const base = "id,name,score\n1,Alice,10\n";
  const ours = "id,name,score\n1,Alicia,10\n";
  const theirs = "id,name,score\n1,Ally,10\n";
  const table = buildTableMerge(base, ours, theirs, { delimiter: "," });

  table.cells[1][1].choice = "both";

  assert.equal(composeTableDraft(table, { bothStrategy: "columns" }), "id,name,name_THEIRS,score\n1,Alicia,Ally,10");
});
