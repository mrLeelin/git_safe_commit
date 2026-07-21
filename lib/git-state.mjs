import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import { runGit, runProcess, validateRepoPath } from "./git-executor.mjs";
import { getLogger } from "./logger.mjs";

export async function collectGitState(repoPath, options = {}) {
  const repoRoot = validateRepoPath(repoPath);
  const traceId = options?.traceId || "";
  const [
    status,
    branch,
    branches,
    upstream,
    aheadBehind,
    head,
    upstreamHead,
    staged,
    unstaged,
    untracked,
    unmerged,
    unstagedCheck,
    stagedCheck
  ] = await Promise.all([
    runGit(repoRoot, ["status", "--short", "--branch"], { traceId }),
    runGit(repoRoot, ["branch", "--show-current"], { traceId }),
    runGit(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"], { traceId }),
    runGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { traceId }),
    runGit(repoRoot, ["rev-list", "--left-right", "--count", "HEAD...@{u}"], { traceId }),
    runGit(repoRoot, ["rev-parse", "HEAD"], { traceId }),
    runGit(repoRoot, ["rev-parse", "@{u}"], { traceId }),
    runGit(repoRoot, ["diff", "--cached", "--name-status"], { traceId }),
    runGit(repoRoot, ["diff", "--name-status"], { traceId }),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"], { traceId }),
    runGit(repoRoot, ["ls-files", "-u"], { traceId }),
    runGit(repoRoot, ["diff", "--check"], { traceId }),
    runGit(repoRoot, ["diff", "--cached", "--check"], { traceId })
  ]);

  const statusItems = parseShortStatus(status.stdout);
  const stagedItems = uniqueStatusItems([
    ...parseNameStatus(staged.stdout),
    ...statusItems.staged
  ]);
  const unstagedItems = uniqueStatusItems([
    ...parseNameStatus(unstaged.stdout),
    ...statusItems.unstaged
  ]);
  const untrackedItems = mergeUntrackedPaths(untracked, statusItems.untracked);
  const unmergedItems = parseUnmerged(unmerged.stdout);
  const counts = aheadBehind.ok ? aheadBehind.stdout.trim().split(/\s+/) : ["0", "0"];
  const changedPaths = unique([
    ...stagedItems.map((item) => item.path),
    ...unstagedItems.map((item) => item.path),
    ...splitLines(unmerged.stdout).map((line) => line.split(/\s+/).at(-1)),
    ...untrackedItems
  ].filter(Boolean));
  const markerSearch = changedPaths.length
    ? await runGit(repoRoot, ["grep", "-n", "-I", "-E", "^(<<<<<<< |=======|>>>>>>> )", "--", ...changedPaths], { traceId })
    : { ok: false, code: 1, stdout: "", stderr: "", command: "git grep markers" };

  const rebaseInProgress = existsSync(path.join(repoRoot, ".git", "rebase-merge"))
    || existsSync(path.join(repoRoot, ".git", "rebase-apply"));
  const conflictMarkers = markerSearch.code === 1 ? [] : splitLines(markerSearch.stdout);
  const rebaseTarget = await collectRebaseTargetState(repoRoot, upstream.ok, traceId);
  const excel = await collectExcelState(repoRoot, {
    stagedPaths: stagedItems.map((item) => item.path),
    rebaseTargetPaths: rebaseTarget.paths
  });

  const result = {
    repoRoot,
    branch: branch.ok ? branch.stdout.trim() : "",
    branches: branches.ok ? splitLines(branches.stdout) : [],
    upstream: upstream.ok ? upstream.stdout.trim() : "",
    head: head.ok ? head.stdout.trim() : "",
    upstreamHead: upstreamHead.ok ? upstreamHead.stdout.trim() : "",
    ahead: Number(counts[0] || 0),
    behind: Number(counts[1] || 0),
    cleanWorktree: !stagedItems.length && !unstagedItems.length && !untrackedItems.length && !unmergedItems.length,
    staged: stagedItems,
    unstaged: unstagedItems,
    untracked: untrackedItems,
    unmerged: unique(unmergedItems.map((item) => item.path)),
    unmergedStages: unmergedItems,
    conflictMarkers,
    rebaseInProgress,
    checks: {
      unstaged: commandView(unstagedCheck),
      staged: commandView(stagedCheck)
    },
    excel,
    rebaseTarget,
    commands: {
      status: commandView(status),
      staged: commandView(staged),
      unstaged: commandView(unstaged),
      untracked: commandView(untracked),
      unmerged: commandView(unmerged),
      markerSearch: commandView(markerSearch)
    }
  };

  const stateSummary = summarizeGitState(result);
  const logger = getLogger();
  logger?.info("state", traceId, "collectGitState complete", {
    branch: result.branch,
    ahead: result.ahead,
    behind: result.behind,
    cleanWorktree: result.cleanWorktree,
    stagedCount: result.staged.length,
    unstagedCount: result.unstaged.length,
    untrackedCount: result.untracked.length,
    unmergedCount: result.unmerged.length,
    rebaseInProgress: result.rebaseInProgress,
    excelCount: result.excel?.files?.length || 0,
    blockers: stateSummary.blockers
  });

  return result;
}

export function mergeUntrackedPaths(untrackedResult, shortStatusPaths = []) {
  return unique(untrackedResult?.ok
    ? splitLines(untrackedResult.stdout)
    : shortStatusPaths);
}

export function summarizeGitState(state) {
  const blockers = [];
  if (state.unmerged.length) blockers.push("unmerged files present");
  if (state.conflictMarkers.length) blockers.push("conflict markers present");
  for (const file of state.excel?.files || []) {
    if (file.lockedExclusive || file.openInExcel) {
      const scope = file.reasons.includes("rebase-target") ? "即将被 rebase 覆盖的" : "已暂存的";
      blockers.push(`请先关闭${scope} Excel 文件再继续: ${file.path}`);
    }
  }

  return {
    branch: state.branch,
    branches: state.branches || [],
    upstream: state.upstream,
    ahead: state.ahead,
    behind: state.behind,
    cleanWorktree: state.cleanWorktree,
    stagedCount: state.staged.length,
    unstagedCount: state.unstaged.length,
    untrackedCount: state.untracked.length,
    unmergedCount: state.unmerged.length,
    markerCount: state.conflictMarkers.length,
    excelCount: state.excel?.files?.length || 0,
    openExcelCount: (state.excel?.files || []).filter((file) => file.lockedExclusive || file.openInExcel).length,
    rebaseTargetCount: state.rebaseTarget?.paths?.length || 0,
    rebaseTargetExcelCount: state.rebaseTarget?.excelPaths?.length || 0,
    rebaseTargetHighRiskCount: state.rebaseTarget?.highRiskPaths?.length || 0,
    rebaseInProgress: state.rebaseInProgress,
    blockers
  };
}

export function splitLines(text) {
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

export function parseNameStatus(text) {
  return splitLines(text).map((line) => {
    const parts = line.split("\t").filter(Boolean);
    return {
      status: parts[0] || "",
      path: parts.at(-1) || ""
    };
  }).filter((item) => item.path);
}

export function parseShortStatus(text) {
  const parsed = {
    staged: [],
    unstaged: [],
    untracked: []
  };
  for (const line of splitLines(text)) {
    if (line.startsWith("##")) continue;
    const x = line[0] || " ";
    const y = line[1] || " ";
    const rawPath = line.slice(3).trim();
    const filePath = decodeStatusPath(rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath);
    if (!filePath) continue;
    if (x === "?" && y === "?") {
      parsed.untracked.push(filePath);
      continue;
    }
    if (x !== " " && x !== "?") parsed.staged.push({ status: x, path: filePath });
    if (y !== " " && y !== "?") parsed.unstaged.push({ status: y, path: filePath });
  }
  parsed.staged = uniqueStatusItems(parsed.staged);
  parsed.unstaged = uniqueStatusItems(parsed.unstaged);
  parsed.untracked = unique(parsed.untracked);
  return parsed;
}

function parseUnmerged(text) {
  return splitLines(text).map((line) => {
    const parts = line.split(/\s+/);
    return {
      mode: parts[0] || "",
      object: parts[1] || "",
      stage: parts[2] || "",
      path: parts.at(-1) || ""
    };
  }).filter((item) => item.path);
}

async function collectRebaseTargetState(repoRoot, hasUpstream, traceId = "") {
  if (!hasUpstream) {
    return { paths: [], excelPaths: [], highRiskPaths: [] };
  }

  const diff = await runGit(repoRoot, ["diff", "--name-only", "HEAD", "@{u}"], { traceId });
  const paths = diff.ok ? splitLines(diff.stdout) : [];
  return {
    command: diff.command,
    ok: diff.ok,
    paths,
    excelPaths: paths.filter(isExcelPath),
    highRiskPaths: paths.filter(isHighRiskPath)
  };
}

async function collectExcelState(repoRoot, options = {}) {
  const stagedPaths = options.stagedPaths || [];
  const rebaseTargetPaths = options.rebaseTargetPaths || [];
  const byPath = new Map();
  for (const filePath of stagedPaths.filter(isExcelPath)) {
    const entry = byPath.get(filePath) || { path: filePath, reasons: [] };
    entry.reasons.push("staged");
    byPath.set(filePath, entry);
  }
  for (const filePath of rebaseTargetPaths.filter(isExcelPath)) {
    const entry = byPath.get(filePath) || { path: filePath, reasons: [] };
    entry.reasons.push("rebase-target");
    byPath.set(filePath, entry);
  }

  const files = [];
  for (const entry of byPath.values()) {
    const absolutePath = path.resolve(repoRoot, entry.path);
    const lock = await checkExclusiveLock(absolutePath);
    files.push({
      path: entry.path,
      absolutePath,
      reasons: entry.reasons,
      lockedExclusive: lock.lockedExclusive,
      lockError: lock.error,
      openInExcel: false
    });
  }

  if (!files.length || process.platform !== "win32") {
    return { checked: files.length > 0, excelProcessRunning: false, comChecked: false, files };
  }

  const excelProcess = await powershellJson("$p=@(Get-Process -Name EXCEL,wps,et -ErrorAction SilentlyContinue); [pscustomobject]@{ running=($p.Count -gt 0); count=$p.Count; processes=@($p | ForEach-Object { [pscustomobject]@{ ProcessName=$_.ProcessName; Id=$_.Id; MainWindowTitle=$_.MainWindowTitle; Path=$_.Path } }) }");
  const com = await powershellJson(`
    try {
      $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
      $items = @()
      foreach ($wb in $excel.Workbooks) {
        $items += [pscustomobject]@{ FullName = $wb.FullName; Name = $wb.Name; Saved = $wb.Saved }
      }
      [pscustomobject]@{ ok=$true; workbooks=$items }
    } catch {
      [pscustomobject]@{ ok=$false; workbooks=@(); error=$_.Exception.Message }
    }
  `);
  const workbooks = Array.isArray(com?.workbooks) ? com.workbooks : com?.workbooks ? [com.workbooks] : [];
  for (const file of files) {
    file.openInExcel = workbooks.some((book) => samePath(book.FullName, file.absolutePath));
  }

  return {
    checked: true,
    excelProcessRunning: Boolean(excelProcess?.running),
    excelProcessCount: Number(excelProcess?.count || 0),
    officeProcesses: excelProcess?.processes || [],
    comChecked: Boolean(com?.ok),
    comError: com?.error || "",
    openWorkbooks: workbooks,
    files
  };
}

async function checkExclusiveLock(filePath) {
  if (!existsSync(filePath)) {
    return { lockedExclusive: false, error: "file does not exist in worktree" };
  }
  try {
    const handle = await open(filePath, "r+");
    await handle.close();
    return { lockedExclusive: false, error: "" };
  } catch (error) {
    return { lockedExclusive: true, error: String(error?.message || error) };
  }
}

async function powershellJson(script) {
  const wrappedScript = `
    $ErrorActionPreference = 'Stop'
    & {
${script}
    } | ConvertTo-Json -Depth 8 -Compress
  `;
  const encoded = Buffer.from(wrappedScript, "utf16le").toString("base64");
  const result = await runProcess("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  try {
    return JSON.parse(String(result.stdout || "").trim());
  } catch {
    return null;
  }
}

function isExcelPath(filePath) {
  return /\.(xlsx|xlsm|xlsb|xls)$/i.test(filePath);
}

function isHighRiskPath(filePath) {
  return /\.(prefab|unity|mat|anim|controller|overrideController|asset|playable|meta|bytes|xlsx|xlsm|xlsb|xls|png|jpe?g|tga|psd|wav|mp3|ogg|mp4|mov|zip|rar|7z|dll|pdb)$/i.test(filePath);
}

function samePath(left, right) {
  return path.normalize(String(left || "")).toLowerCase() === path.normalize(String(right || "")).toLowerCase();
}

function commandView(result) {
  return {
    command: result.command,
    ok: result.ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function unique(values) {
  return [...new Set(values)];
}

function decodeStatusPath(filePath = "") {
  if (!filePath.startsWith("\"") || !filePath.endsWith("\"")) return filePath;
  return filePath
    .slice(1, -1)
    .replaceAll("\\\"", "\"")
    .replaceAll("\\\\", "\\");
}

function uniqueStatusItems(items) {
  const byPath = new Map();
  for (const item of items) {
    if (!item.path || byPath.has(item.path)) continue;
    byPath.set(item.path, item);
  }
  return [...byPath.values()];
}
