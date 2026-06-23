export function buildCommitGraphRows(commits) {
  const rows = Array.isArray(commits) ? commits : [];
  const indexByHash = new Map(rows.map((commit, index) => [commit.hash, index]));
  const commitByHash = new Map(rows.map((commit) => [commit.hash, commit]));
  const branchRanges = [];

  rows.forEach((commit, index) => {
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    const mainParentHash = parents[0];
    parents.slice(1).forEach((parentHash, parentIndex) => {
      const branchParentIndex = indexByHash.get(parentHash);
      if (Number.isInteger(branchParentIndex) && branchParentIndex > index) {
        const ancestorIndex = findVisibleCommonAncestorIndex({
          mainParentHash,
          branchParentHash: parentHash,
          commitByHash,
          indexByHash
        });
        branchRanges.push({
          start: index,
          tip: branchParentIndex,
          end: Math.max(branchParentIndex, ancestorIndex ?? branchParentIndex),
          lane: parentIndex + 1,
          parentHash
        });
      }
    });
  });

  return rows.map((commit, index) => {
    const branchLines = uniqueSorted(
      branchRanges
        .filter((range) => index >= range.start && index <= range.end)
        .map((range) => range.lane)
    );
    const endingBranch = branchRanges.find((range) => range.tip === index);
    const mergeJoinLanes = uniqueSorted(
      branchRanges
        .filter((range) => range.start === index)
        .map((range) => range.lane)
    );
    const branchSplitLanes = uniqueSorted(
      branchRanges
        .filter((range) => range.end === index && range.tip !== index)
        .map((range) => range.lane)
    );
    const nodeLane = endingBranch ? endingBranch.lane : 0;

    return {
      ...commit,
      nodeLane,
      branchLines,
      mergeJoinLanes,
      branchSplitLanes,
      isMerge: Array.isArray(commit.parents) && commit.parents.length > 1,
      showMergeJoin: mergeJoinLanes.length > 0,
      showBranchSplit: branchSplitLanes.length > 0,
      endsBranch: Boolean(endingBranch)
    };
  });
}

function findVisibleCommonAncestorIndex({ mainParentHash, branchParentHash, commitByHash, indexByHash }) {
  if (!mainParentHash || !branchParentHash) return null;

  const mainAncestors = collectVisibleAncestors(mainParentHash, commitByHash, indexByHash);
  let current = branchParentHash;
  const seen = new Set();

  while (current && !seen.has(current)) {
    seen.add(current);
    if (mainAncestors.has(current)) return indexByHash.get(current);
    const commit = commitByHash.get(current);
    current = Array.isArray(commit?.parents) ? commit.parents[0] : "";
  }

  return null;
}

function collectVisibleAncestors(startHash, commitByHash, indexByHash) {
  const ancestors = new Set();
  let current = startHash;

  while (current && !ancestors.has(current)) {
    if (!indexByHash.has(current)) break;
    ancestors.add(current);
    const commit = commitByHash.get(current);
    current = Array.isArray(commit?.parents) ? commit.parents[0] : "";
  }

  return ancestors;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left - right);
}
