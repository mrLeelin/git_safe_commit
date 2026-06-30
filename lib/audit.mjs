const SecretPathPattern = /(^|[\\/])(\.env(\.|$)|id_rsa$|id_dsa$|.*\.(keystore|p12|pfx|pem|key)$)/i;
const PrivateConfigPattern = /(^|[\\/])(config|settings|secrets?)\.(local\.)?json$/i;
const ExampleConfigPattern = /(^|[\\/])(config|settings)\.example\.json$/i;
const TablePattern = /\.(xlsx|xlsm|xls|csv|tsv)$/i;
const UnityResourcePattern = /\.(unity|prefab|asset|meta|mat|anim|controller|overridecontroller|playable|mask)$/i;
const GeneratedPattern = /(^|[\\/])generated[\\/]|(\.g|\.generated)\.(cs|js|ts|mjs)$/i;
const BinaryPattern = /\.(zip|7z|rar|gz|png|jpe?g|webp|psd|mp3|wav|mp4|mov|dll|exe|bin|so|dylib)$/i;

const RiskPriority = {
  danger: 3,
  warn: 2,
  info: 1,
  ok: 0
};

export function classifyPathRisk(filePath = "") {
  const path = String(filePath || "").replaceAll("\\", "/");
  const labels = [];
  let tone = "ok";

  function add(label, nextTone) {
    if (!labels.includes(label)) labels.push(label);
    if (RiskPriority[nextTone] > RiskPriority[tone]) tone = nextTone;
  }

  if (PrivateConfigPattern.test(path) && !ExampleConfigPattern.test(path)) add("private-config", "danger");
  if (SecretPathPattern.test(path)) add(path.includes(".env") ? "env" : "secret", "danger");
  if (TablePattern.test(path)) add("table", "warn");
  if (UnityResourcePattern.test(path)) add("unity-resource", "warn");
  if (GeneratedPattern.test(path)) add("generated", "info");
  if (BinaryPattern.test(path)) add("binary", "warn");

  return {
    path: filePath,
    labels,
    tone,
    risky: labels.length > 0
  };
}

export function auditRepositoryState({
  action = "inspect",
  selectedPaths = [],
  committedPaths = [],
  status = {},
  summary = {},
  activeRecovery = null,
  activeSyncStash = null,
  toolStashes = []
} = {}) {
  const selectedSet = new Set(selectedPaths.map(normalizePath));
  const staged = Array.isArray(status.staged) ? status.staged : [];
  const stagedPaths = staged.map((item) => item.path).filter(Boolean);
  const dirty = dirtyPaths(status);
  const scopedPaths = unique([...stagedPaths, ...selectedPaths, ...committedPaths]);
  const riskFiles = scopedPaths
    .map((filePath) => classifyPathRisk(filePath))
    .filter((risk) => risk.risky);
  const findings = [];

  const blockers = Array.isArray(summary.blockers) ? summary.blockers : [];
  const unresolvedRepositoryBlockers = blockers.length
    || Number(summary.unmergedCount || 0) > 0
    || Number(summary.markerCount || 0) > 0;
  if (unresolvedRepositoryBlockers) {
    findings.push({
      code: "repository-blocked",
      severity: "blocked",
      message: "仓库当前还有未解决的阻断项，不能继续执行这个动作。",
      blockers
    });
  } else if (summary.rebaseInProgress) {
    const rebaseCanContinue = action === "inspect" || action === "continue-rebase-and-push";
    findings.push({
      code: "rebase-ready-to-continue",
      severity: rebaseCanContinue ? "warn" : "blocked",
      message: rebaseCanContinue
        ? "冲突已清理，当前 rebase 等待继续。确认暂存结果后可以继续变基。"
        : "当前处于 rebase 流程，请先继续或复位 rebase，不能执行这个动作。",
      blockers
    });
  }

  if (action === "commit" && selectedSet.size) {
    const outside = stagedPaths.filter((filePath) => !selectedSet.has(normalizePath(filePath)));
    if (outside.length) {
      findings.push({
        code: "staged-out-of-scope",
        severity: "blocked",
        message: "暂存区里有未选中的文件，直接提交会把它们一起带上。",
        paths: outside
      });
    }
  }

  const riskySelected = selectedPaths
    .map((filePath) => classifyPathRisk(filePath))
    .filter((risk) => risk.risky);
  if (riskySelected.length) {
    findings.push({
      code: "risky-selected-files",
      severity: "warn",
      message: "选中的文件里包含配置、资源或二进制等需确认类型，请确认后再提交。",
      count: riskySelected.length,
      paths: riskySelected.map((risk) => risk.path)
    });
  }

  if (activeSyncStash) {
    findings.push({
      code: "pending-sync-stash",
      severity: "warn",
      message: "仍有同步流程创建的临时 stash 等待恢复。",
      ref: activeSyncStash.ref || "",
      sha: activeSyncStash.sha || ""
    });
  }

  const visibleToolStashes = toolStashes.filter((stash) => {
    return !activeSyncStash?.sha || stash.sha !== activeSyncStash.sha;
  });
  const discardToolStashes = visibleToolStashes.filter((stash) => stash.type === "discard");
  const syncToolStashes = visibleToolStashes.filter((stash) => stash.type === "sync");
  if (visibleToolStashes.length) {
    findings.push({
      code: "tool-stashes-present",
      severity: discardToolStashes.length ? "warn" : "info",
      message: toolStashMessage({
        total: visibleToolStashes.length,
        discard: discardToolStashes.length,
        sync: syncToolStashes.length
      }),
      count: visibleToolStashes.length,
      discardCount: discardToolStashes.length,
      syncCount: syncToolStashes.length,
      refs: visibleToolStashes.map((stash) => stash.ref)
    });
  }

  if (activeRecovery) {
    findings.push({
      code: "active-recovery",
      severity: "info",
      message: "当前有一个恢复点处于可用状态。",
      backupBranch: activeRecovery.backupBranch || "",
      timestamp: activeRecovery.timestamp || ""
    });
  }

  const verdict = findings.some((finding) => finding.severity === "blocked")
    ? "blocked"
    : findings.some((finding) => finding.severity === "warn")
      ? "needs_confirmation"
      : "passed";

  return {
    verdict,
    title: auditTitle(verdict, findings),
    action,
    findings,
    riskFiles,
    counts: {
      selected: selectedPaths.length,
      staged: stagedPaths.length,
      dirty: dirty.length,
      risk: riskFiles.length,
      toolStash: visibleToolStashes.length,
      discardStash: discardToolStashes.length,
      syncStash: syncToolStashes.length
    }
  };
}

function toolStashMessage({ total = 0, discard = 0, sync = 0 } = {}) {
  if (discard && sync) {
    return `仍有工具创建的 stash 未处理（${total} 个，其中可自动恢复 ${discard} 个、历史同步 ${sync} 个）。历史同步 stash 不会自动恢复。`;
  }
  if (discard) return `仍有工具创建的 stash 未处理（${discard} 个）。请恢复或明确删除后再继续。`;
  if (sync) return `仍有历史同步 stash 未处理（${sync} 个）。这类 stash 不会自动恢复，请确认后手动处理。`;
  return `仍有工具创建的 stash 未处理（${total} 个）。请确认后处理。`;
}

function auditTitle(verdict, findings) {
  if (findings.some((finding) => finding.code === "staged-out-of-scope")) return "范围不一致";
  if (verdict === "blocked") return "已阻断";
  if (verdict === "needs_confirmation") return "需要确认";
  return "审计通过";
}

function dirtyPaths(status = {}) {
  return unique([
    ...(status.staged || []).map((item) => item.path),
    ...(status.unstaged || []).map((item) => item.path),
    ...(status.untracked || []),
    ...(status.unmerged || [])
  ].filter(Boolean));
}

function normalizePath(filePath = "") {
  return String(filePath || "").replaceAll("\\", "/");
}

function unique(values) {
  return [...new Set(values)];
}
