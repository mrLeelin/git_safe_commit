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
