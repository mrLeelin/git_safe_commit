export function buildCommitGraphRows(commits) {
  const rows = Array.isArray(commits) ? commits : [];
  const stashInternalParents = collectStashInternalParents(rows);
  const visibleRows = rows.filter((commit) => !stashInternalParents.has(commit.hash));
  const lanes = [];

  return visibleRows.map((commit, index) => {
    const originalParents = Array.isArray(commit.parents) ? commit.parents : [];
    const isStash = isStashCommit(commit);
    const parents = isStash ? originalParents.slice(0, 1) : originalParents;
    let nodeLane = lanes.indexOf(commit.hash);
    const openedLane = nodeLane === -1;

    if (openedLane) {
      nodeLane = firstFreeLane(lanes);
      lanes[nodeLane] = commit.hash;
    }

    const mergeParentLanes = parents.slice(1).map((parentHash) => ensureLane(lanes, parentHash));
    const duplicateLanes = laneIndexes(lanes, commit.hash);
    const branchLines = activeBranchLines(lanes, nodeLane);
    const mergeJoinLanes = uniqueSorted(
      mergeParentLanes.filter((lane) => lane > 0)
    );
    const branchSplitLanes = uniqueSorted(
      duplicateLanes.filter((lane) => lane > 0 && lane !== nodeLane)
    );

    const row = {
      ...commit,
      rowIndex: index,
      nodeLane,
      startsLane: openedLane,
      branchLines,
      mergeJoinLanes,
      branchSplitLanes,
      isStash,
      isMerge: originalParents.length > 1 && !isStash,
      showMergeJoin: mergeJoinLanes.length > 0,
      showBranchSplit: branchSplitLanes.length > 0,
      endsBranch: nodeLane > 0
    };

    advanceLanes(lanes, nodeLane, commit.hash, parents);
    return row;
  });
}

function collectStashInternalParents(rows) {
  const hashes = new Set();
  rows.forEach((commit) => {
    if (!isStashCommit(commit) || !Array.isArray(commit.parents)) return;
    commit.parents.slice(1).forEach((hash) => {
      if (hash) hashes.add(hash);
    });
  });
  return hashes;
}

function isStashCommit(commit) {
  return Array.isArray(commit.refs) && commit.refs.some((ref) => {
    const value = String(ref || "");
    return value === "refs/stash" || value === "stash" || value.startsWith("stash@");
  });
}

function advanceLanes(lanes, nodeLane, hash, parents) {
  if (!parents.length) {
    clearMatchingLanes(lanes, hash);
  } else {
    lanes[nodeLane] = parents[0] || "";
    laneIndexes(lanes, hash).filter((lane) => lane !== nodeLane).forEach((lane) => {
      lanes[lane] = "";
    });
  }

  trimTrailingFreeLanes(lanes);
}

function ensureLane(lanes, hash) {
  if (!hash) return -1;
  const existing = lanes.indexOf(hash);
  if (existing !== -1) return existing;
  const lane = firstFreeLane(lanes);
  lanes[lane] = hash;
  return lane;
}

function clearMatchingLanes(lanes, hash) {
  laneIndexes(lanes, hash).forEach((lane) => {
    lanes[lane] = "";
  });
}

function trimTrailingFreeLanes(lanes) {
  while (lanes.length && !lanes.at(-1)) lanes.pop();
}

function activeBranchLines(lanes, nodeLane) {
  return uniqueSorted(
    lanes
      .map((hash, lane) => ({ hash, lane }))
      .filter(({ hash, lane }) => hash && lane > 0)
      .map(({ lane }) => lane)
      .concat(nodeLane > 0 ? [nodeLane] : [])
  );
}

function laneIndexes(lanes, hash) {
  return lanes
    .map((laneHash, lane) => laneHash === hash ? lane : -1)
    .filter((lane) => lane >= 0);
}

function firstFreeLane(lanes) {
  const index = lanes.findIndex((hash) => !hash);
  return index === -1 ? lanes.length : index;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}
