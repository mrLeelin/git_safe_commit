const MergeChoices = new Set(["ours", "theirs", "both", "none"]);

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
