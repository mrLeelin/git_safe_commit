import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

export function runGit(args, options = {}) {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 20
    }, (error, stdout, stderr) => {
      resolve({
        command: `git ${args.join(" ")}`,
        code: error?.code ?? 0,
        ok: !error,
        stdout: stdout || "",
        stderr: stderr || "",
        error: error ? String(error.message || error) : ""
      });
    });
  });
}

export function runGitBuffer(args, options = {}) {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd: options.cwd || process.cwd(),
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 100
    }, (error, stdout, stderr) => {
      resolve({
        command: `git ${args.join(" ")}`,
        code: error?.code ?? 0,
        ok: !error,
        stdout: stdout || Buffer.alloc(0),
        stderr: stderr?.toString("utf8") || "",
        error: error ? String(error.message || error) : ""
      });
    });
  });
}

export async function findRepoRoot(startDir = process.cwd()) {
  const result = await runGit(["rev-parse", "--show-toplevel"], { cwd: startDir });
  if (!result.ok || !result.stdout.trim()) {
    throw new Error(`not inside a git repository: ${startDir}`);
  }
  return path.normalize(result.stdout.trim());
}

export function splitLines(text) {
  return text ? text.split(/\r?\n/).filter(Boolean) : [];
}

export async function collectGitState(repoRoot = null, options = {}) {
  repoRoot = repoRoot || await findRepoRoot();
  const [
    status,
    branch,
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
    runGit(["status", "--short", "--branch"], { cwd: repoRoot }),
    runGit(["branch", "--show-current"], { cwd: repoRoot }),
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { cwd: repoRoot }),
    runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"], { cwd: repoRoot }),
    runGit(["rev-parse", "HEAD"], { cwd: repoRoot }),
    runGit(["rev-parse", "@{u}"], { cwd: repoRoot }),
    runGit(["diff", "--cached", "--name-status"], { cwd: repoRoot }),
    runGit(["diff", "--name-status"], { cwd: repoRoot }),
    runGit(["ls-files", "--others", "--exclude-standard"], { cwd: repoRoot }),
    runGit(["ls-files", "-u"], { cwd: repoRoot }),
    runGit(["diff", "--check"], { cwd: repoRoot }),
    runGit(["diff", "--cached", "--check"], { cwd: repoRoot })
  ]);

  const counts = aheadBehind.ok ? aheadBehind.stdout.trim().split(/\s+/) : [];
  const changedPaths = [...new Set([
    ...splitLines(staged.stdout).map(nameFromNameStatus),
    ...splitLines(unstaged.stdout).map(nameFromNameStatus),
    ...splitLines(unmerged.stdout).map((line) => line.split(/\s+/).at(-1)),
    ...splitLines(untracked.stdout)
  ].filter(Boolean))];
  const markerSearch = changedPaths.length
    ? await runGit(["grep", "-n", "-I", "-E", "^(<<<<<<< |=======|>>>>>>> )", "--", ...changedPaths], { cwd: repoRoot })
    : { command: "git grep marker -- changed paths", code: 1, ok: false, stdout: "", stderr: "", error: "" };
  const rebaseMergePath = path.join(repoRoot, ".git", "rebase-merge");
  const rebaseApplyPath = path.join(repoRoot, ".git", "rebase-apply");
  const stagedPaths = splitLines(staged.stdout).map(nameFromNameStatus).filter(Boolean);
  const rebaseTarget = await collectRebaseTargetState(repoRoot, upstream.ok);
  const excel = await collectExcelState(repoRoot, {
    stagedPaths,
    rebaseTargetPaths: rebaseTarget.paths,
    autoCloseSaved: Boolean(options.autoCloseSavedExcel)
  });

  return {
    repoRoot,
    status,
    branch: branch.ok ? branch.stdout.trim() : "",
    upstream: upstream.ok ? upstream.stdout.trim() : "",
    head: head.ok ? head.stdout.trim() : "",
    upstreamHead: upstreamHead.ok ? upstreamHead.stdout.trim() : "",
    ahead: counts[0] || "",
    behind: counts[1] || "",
    staged: splitLines(staged.stdout),
    unstaged: splitLines(unstaged.stdout),
    untracked: splitLines(untracked.stdout),
    unmerged: splitLines(unmerged.stdout),
    conflictMarkers: markerSearch.code === 1 ? [] : splitLines(markerSearch.stdout),
    checks: {
      unstaged: unstagedCheck,
      staged: stagedCheck,
      markerSearch
    },
    rebase: {
      mergePath: ".git/rebase-merge",
      applyPath: ".git/rebase-apply",
      inProgress: existsSync(rebaseMergePath) || existsSync(rebaseApplyPath)
    },
    excel,
    rebaseTarget
  };
}

export function summarizeState(state) {
  const blockers = [];
  if (!state.upstream) blockers.push("missing upstream");
  if (state.unmerged.length) blockers.push("unmerged files present");
  if (state.conflictMarkers.length) blockers.push("conflict markers present");
  if (!state.checks.unstaged.ok) blockers.push("unstaged diff check failed");
  if (!state.checks.staged.ok) blockers.push("staged diff check failed");
  for (const file of state.excel.files) {
    if (file.lockedExclusive || file.openInExcel) {
      const scope = file.reasons.includes("rebase-target") ? "即将被 rebase 覆盖的" : "已暂存的";
      blockers.push(`请先关闭${scope} Excel 文件再继续: ${file.path}`);
    }
  }

  return {
    branch: state.branch,
    upstream: state.upstream,
    ahead: state.ahead || "0",
    behind: state.behind || "0",
    cleanWorktree: !state.staged.length && !state.unstaged.length && !state.untracked.length && !state.unmerged.length,
    stagedCount: state.staged.length,
    unstagedCount: state.unstaged.length,
    untrackedCount: state.untracked.length,
    unmergedCount: state.unmerged.length,
    markerCount: state.conflictMarkers.length,
    excelCount: state.excel.files.length,
    openExcelCount: state.excel.files.filter((file) => file.lockedExclusive || file.openInExcel).length,
    rebaseTargetCount: state.rebaseTarget.paths.length,
    rebaseTargetExcelCount: state.rebaseTarget.excelPaths.length,
    rebaseTargetHighRiskCount: state.rebaseTarget.highRiskPaths.length,
    rebaseInProgress: state.rebase.inProgress,
    blockers
  };
}

function nameFromNameStatus(line) {
  const parts = line.split("\t").filter(Boolean);
  return parts.at(-1) || "";
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function collectRebaseTargetState(repoRoot, hasUpstream) {
  if (!hasUpstream) {
    return { paths: [], excelPaths: [], highRiskPaths: [] };
  }

  const diff = await runGit(["diff", "--name-only", "HEAD", "@{u}"], { cwd: repoRoot });
  const paths = diff.ok ? splitLines(diff.stdout) : [];
  return {
    command: diff.command,
    ok: diff.ok,
    paths,
    excelPaths: paths.filter(isExcelPath),
    highRiskPaths: paths.filter(isHighRiskPath)
  };
}

async function collectExcelState(repoRoot, options) {
  const stagedPaths = options.stagedPaths || [];
  const rebaseTargetPaths = options.rebaseTargetPaths || [];
  const autoCloseSaved = Boolean(options.autoCloseSaved);
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
    let autoCloseResult = null;
    if (autoCloseSaved) {
      autoCloseResult = await closeSavedExcelWorkbook(absolutePath);
    }
    const lock = await checkExclusiveLock(absolutePath);
    files.push({
      path: entry.path,
      absolutePath,
      reasons: entry.reasons,
      lockedExclusive: lock.lockedExclusive,
      lockError: lock.error,
      openInExcel: false,
      autoCloseResult
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

async function closeSavedExcelWorkbook(filePath) {
  if (process.platform !== "win32") {
    return { attempted: false, closed: false, reason: "auto close is only supported on Windows" };
  }

  const target = psQuote(path.normalize(filePath));
  const result = await powershellJson(`
    $target = ${target}
    try {
      $targetFull = [System.IO.Path]::GetFullPath($target).ToLowerInvariant()
      $excel = [Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
      $matched = @()
      foreach ($wb in $excel.Workbooks) {
        $fullName = $wb.FullName
        if (-not $fullName) { continue }
        $full = [System.IO.Path]::GetFullPath($fullName).ToLowerInvariant()
        if ($full -eq $targetFull) {
          $item = [pscustomobject]@{ FullName=$wb.FullName; Name=$wb.Name; Saved=$wb.Saved; Closed=$false; Reason='' }
          if ($wb.Saved -eq $true) {
            $wb.Close($false)
            $item.Closed = $true
          } else {
            $item.Reason = 'workbook has unsaved changes'
          }
          $matched += $item
        }
      }
      [pscustomobject]@{ ok=$true; attempted=$true; matched=$matched; closed=(@($matched | Where-Object { $_.Closed }).Count -gt 0) }
    } catch {
      [pscustomobject]@{ ok=$false; attempted=$true; matched=@(); closed=$false; error=$_.Exception.Message }
    }
  `);

  return result || { attempted: true, closed: false, error: "failed to parse close result" };
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
  const result = await new Promise((resolve) => {
    execFile("powershell", ["-NoProfile", "-EncodedCommand", encoded], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || "", stderr: stderr || "" });
    });
  });
  try {
    return JSON.parse(result.stdout.trim());
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
  return String(left || "").toLowerCase() === String(right || "").toLowerCase();
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
