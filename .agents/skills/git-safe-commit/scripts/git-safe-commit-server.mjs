import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectGitState, summarizeState } from "./git-safe-commit-lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const skillDir = path.resolve(path.dirname(__filename), "..");
const panelDir = path.join(skillDir, "assets", "panel");
const panelPath = path.join(panelDir, "index.html");
const excelWorkbenchScript = path.join(skillDir, "scripts", "excel-conflict-workbench.py");
const guardVersion = "2026-06-17.ensure-server-v1";
const serverScript = path.normalize(__filename);
const repoRoot = await findRepoRoot(process.cwd());
const port = Number(process.env.GIT_SAFE_COMMIT_PORT || 17371);
const host = "127.0.0.1";
const backupRoot = path.join(repoRoot, ".git", "git-safe-commit-backups");
const sessionLogPath = path.join(backupRoot, "session-log.jsonl");
const statePath = path.join(backupRoot, "session-state.json");

let sessionState = await loadState();
const eventClients = new Set();

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "null",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body, null, 2));
}

function html(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function asset(res, contentType, body) {
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  res.end(body);
}

function text(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "access-control-allow-origin": "null",
    "cache-control": "no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
  res.write(": connected\n\n");
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastEvent(event, data) {
  for (const client of eventClients) {
    try {
      writeEvent(client, event, data);
    } catch {
      eventClients.delete(client);
    }
  }
}

async function openEventStream(req, res) {
  sse(res);
  eventClients.add(res);
  writeEvent(res, "state", sessionState);
  writeEvent(res, "logs", {
    sessionLogPath: relative(sessionLogPath),
    entries: await readSessionLog()
  });
  req.on("close", () => {
    eventClients.delete(res);
  });
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function findRepoRoot(cwd) {
  const result = await runRaw("git", ["rev-parse", "--show-toplevel"], cwd);
  if (result.code !== 0) {
    throw new Error(`Not inside a git repository: ${cwd}`);
  }
  return result.stdout.trim();
}

function runRaw(file, args, cwd = repoRoot, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      },
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 30,
      timeout: options.timeout || 120000
    }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      resolve({
        command: [file, ...args].join(" "),
        code,
        ok: code === 0,
        stdout,
        stderr,
        error: error ? error.message : ""
      });
    });
  });
}

function runBuffer(file, args, cwd = repoRoot, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd,
      windowsHide: true,
      encoding: "buffer",
      maxBuffer: 1024 * 1024 * 100,
      timeout: options.timeout || 120000
    }, (error, stdout, stderr) => {
      const code = typeof error?.code === "number" ? error.code : error ? 1 : 0;
      resolve({
        command: [file, ...args].join(" "),
        code,
        ok: code === 0,
        stdout,
        stderr: stderr.toString("utf8"),
        error: error ? error.message : ""
      });
    });
  });
}

async function runGit(args, options = {}) {
  return runRaw("git", args, repoRoot, options);
}

async function runPythonJson(args, options = {}) {
  const candidates = process.env.PYTHON
    ? [{ file: process.env.PYTHON, prefix: [] }]
    : [{ file: "python", prefix: [] }, { file: "py", prefix: ["-3"] }];
  const attempts = [];
  for (const candidate of candidates) {
    const result = await runRaw(candidate.file, [...candidate.prefix, ...args], repoRoot, {
      timeout: options.timeout || 120000
    });
    attempts.push(result);
    if (!result.ok) {
      const commandMissing = result.error.includes("ENOENT") || result.stderr.includes("not recognized");
      if (commandMissing && candidate !== candidates[candidates.length - 1]) {
        continue;
      }
    }
    if (!result.ok) {
      throw new Error(result.stderr || result.error || `${result.command} failed`);
    }
    try {
      return {
        data: JSON.parse(result.stdout || "{}"),
        result
      };
    } catch (error) {
      throw new Error(`Python helper returned invalid JSON: ${error.message}\n${result.stdout.slice(0, 2000)}`);
    }
  }
  throw new Error(`Python helper failed: ${attempts.map((item) => item.error || item.stderr).join("; ")}`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

async function loadState() {
  if (!existsSync(statePath)) {
    return defaultState();
  }
  try {
    return normalizeState({ ...defaultState(), ...JSON.parse(await readFile(statePath, "utf8")) });
  } catch {
    return defaultState();
  }
}

function defaultState() {
  return {
    phase: "Idle",
    blockers: [],
    note: "",
    activeRecovery: null,
    lastBinaryConflict: null,
    lastExcelConflict: null,
    updatedAt: new Date().toISOString()
  };
}

function normalizeState(state) {
  return state;
  if (!state?.lastExcelConflict?.localPair) {
    return state;
  }
  return {
    ...state,
    blockers: [],
    note: "已忽略旧的本地两表测试状态；正式工作台只处理真实 Git 冲突。",
    lastExcelConflict: null
  };
}

async function saveState(patch = {}) {
  sessionState = {
    ...sessionState,
    ...compactStatePatch(patch),
    updatedAt: new Date().toISOString()
  };
  await mkdir(backupRoot, { recursive: true });
  await writeFile(statePath, JSON.stringify(sessionState, null, 2), "utf8");
  broadcastEvent("state", sessionState);
  return sessionState;
}

async function appendSessionLog(event, payload = {}, result = null, error = null) {
  await mkdir(backupRoot, { recursive: true });
  const entry = {
    time: new Date().toISOString(),
    event,
    phase: sessionState.phase,
    payload: sanitizePayload(payload),
    recovery: result?.recovery || sessionState.activeRecovery,
    binaryConflict: result?.binaryConflict || null,
    excelConflict: compactExcelConflict(result?.excelConflict),
    excelCandidate: compactExcelCandidate(result?.excelCandidate),
    results: (result?.results || []).map((item) => ({
      label: item.label,
      command: item.command,
      code: item.code,
      ok: item.ok,
      stdout: truncateLogText(item.stdout),
      stderr: truncateLogText(item.stderr),
      error: item.error
    })),
    error: error ? String(error instanceof Error ? error.message : error) : ""
  };
  await appendFile(sessionLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  broadcastEvent("log", entry);
}

function compactStatePatch(patch) {
  const copy = { ...patch };
  if (copy.lastExcelCandidate) {
    copy.lastExcelCandidate = compactExcelCandidate(copy.lastExcelCandidate);
  }
  if (copy.lastExcelConflict?.sheets) {
    copy.lastExcelConflict = compactExcelConflict(copy.lastExcelConflict);
  }
  return copy;
}

function compactSessionState(state) {
  return {
    phase: state.phase,
    blockers: state.blockers,
    note: state.note,
    activeRecovery: state.activeRecovery,
    lastBinaryConflict: state.lastBinaryConflict,
    lastExcelConflict: compactExcelConflict(state.lastExcelConflict),
    lastExcelCandidate: compactExcelCandidate(state.lastExcelCandidate),
    updatedAt: state.updatedAt
  };
}

function compactExcelConflict(excelConflict) {
  if (!excelConflict) return null;
  return {
    path: excelConflict.path,
    base: excelConflict.base,
    ours: excelConflict.ours,
    theirs: excelConflict.theirs,
    finalPath: excelConflict.finalPath,
    summary: excelConflict.summary,
    sheetCount: excelConflict.sheetCount,
    structureMismatch: Boolean(excelConflict.structureMismatch),
    localPair: Boolean(excelConflict.localPair),
    manualPair: Boolean(excelConflict.manualPair),
    sheets: Array.isArray(excelConflict.sheets) ? excelConflict.sheets.map(compactExcelSheet) : undefined
  };
}

function compactExcelCandidate(candidate) {
  if (!candidate) return null;
  return {
    path: candidate.path,
    base: candidate.base,
    candidate: candidate.candidate,
    choices: candidate.choices,
    finalPath: candidate.finalPath,
    applied: candidate.applied,
    appliedChoices: candidate.appliedChoices,
    preview: candidate.preview ? {
      summary: candidate.preview.summary,
      sheetCount: candidate.preview.sheetCount,
      structureMismatch: Boolean(candidate.preview.structureMismatch),
      sheets: Array.isArray(candidate.preview.sheets) ? candidate.preview.sheets.map(compactExcelSheet) : []
    } : null
  };
}

function compactExcelSheet(sheet) {
  return {
    sheetIndex: sheet.sheetIndex,
    name: sheet.name,
    classification: sheet.classification,
    alignment: sheet.alignment,
    diffCount: sheet.diffCount,
    autoMergeCount: sheet.autoMergeCount,
    conflictCount: sheet.conflictCount,
    usedRows: sheet.usedRows,
    usedCols: sheet.usedCols,
    visibleRows: sheet.visibleRows,
    visibleCols: sheet.visibleCols,
    truncated: Boolean(sheet.truncated)
  };
}

function sanitizePayload(payload) {
  const copy = { ...payload };
  for (const key of Object.keys(copy)) {
    if (typeof copy[key] === "string" && copy[key].length > 500) {
      copy[key] = `${copy[key].slice(0, 500)}...`;
    }
  }
  return copy;
}

function truncateLogText(value) {
  if (Buffer.isBuffer(value)) {
    return `<${value.length} bytes>`;
  }
  if (typeof value !== "string") {
    return value;
  }
  const limit = 80000;
  return value.length > limit ? `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]` : value;
}

async function readSessionLog() {
  if (!existsSync(sessionLogPath)) {
    return [];
  }
  const body = await readFile(sessionLogPath, "utf8");
  return body
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-200)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { time: "", event: "invalid-log-line", error: line };
      }
    });
}

function safeRelativePath(value) {
  if (!value || typeof value !== "string") {
    throw new Error("path is required");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("\0") || normalized.includes("../") || normalized === "..") {
    throw new Error(`unsafe path: ${value}`);
  }
  const resolved = path.resolve(repoRoot, normalized);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes repository: ${value}`);
  }
  return normalized;
}

function backupPath(ts, name) {
  if (!/^\d{8}-\d{6}$/.test(ts)) {
    throw new Error("invalid timestamp");
  }
  return path.join(backupRoot, ts, name);
}

function safeBackupRelativePath(value) {
  if (!value || typeof value !== "string") {
    throw new Error("path is required");
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.includes("\0") || normalized.includes("../") || normalized === "..") {
    throw new Error(`unsafe path: ${value}`);
  }
  const resolved = path.resolve(repoRoot, normalized);
  const backupRelative = path.relative(backupRoot, resolved);
  if (backupRelative.startsWith("..") || path.isAbsolute(backupRelative)) {
    throw new Error(`local workbook path must be under .git/git-safe-commit-backups: ${value}`);
  }
  return normalized;
}

function safeBackupReadPath(value) {
  const normalized = safeBackupRelativePath(value);
  const resolved = path.resolve(repoRoot, normalized);
  const relativePath = path.relative(backupRoot, resolved);
  if (relativePath.split(path.sep).some((part) => part.startsWith("."))) {
    throw new Error(`backup path contains hidden segments: ${value}`);
  }
  return { normalized, resolved };
}

const TextConflictExtensions = new Set([
  ".cs", ".asmdef", ".asmref", ".js", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".ps1", ".sh", ".bat", ".cmd",
  ".java", ".kt", ".cpp", ".h", ".hpp", ".c", ".go", ".rs", ".md", ".txt", ".json", ".jsonc", ".xml",
  ".yml", ".yaml", ".toml", ".ini", ".editorconfig", ".gitignore", ".gitattributes", ".shader", ".hlsl",
  ".cginc", ".compute", ".uss", ".uxml"
]);

function assertTextConflict(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();
  if (!TextConflictExtensions.has(ext) && !TextConflictExtensions.has(name)) {
    throw new Error(`text conflict workbench does not support this file type: ${filePath}`);
  }
}

async function statusBundle() {
  const [
    status,
    branch,
    upstream,
    head,
    upstreamHead,
    aheadBehind,
    staged,
    unstaged,
    untracked,
    unmerged,
    rebaseMerge,
    rebaseApply
  ] = await Promise.all([
    runGit(["status", "--short", "--branch"]),
    runGit(["branch", "--show-current"]),
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
    runGit(["rev-parse", "HEAD"]),
    runGit(["rev-parse", "@{u}"]),
    runGit(["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
    runGit(["diff", "--cached", "--name-status"]),
    runGit(["diff", "--name-status"]),
    runGit(["ls-files", "--others", "--exclude-standard"]),
    runGit(["diff", "--name-only", "--diff-filter=U"]),
    runGit(["rev-parse", "--git-path", "rebase-merge"]),
    runGit(["rev-parse", "--git-path", "rebase-apply"])
  ]);

  const blockers = [];
  if (!upstream.ok) {
    blockers.push("当前分支没有 upstream，AI 不应继续同步或推送。");
  }
  if (unmerged.stdout.trim()) {
    blockers.push("存在未解决冲突，禁止 continue/commit/push。");
  }

  const aheadBehindText = aheadBehind.ok ? aheadBehind.stdout.trim() : "";
  const [ahead = "", behind = ""] = aheadBehindText.split(/\s+/);
  return {
    repoRoot,
    status: commandView(status),
    branch: branch.stdout.trim(),
    upstream: upstream.ok ? upstream.stdout.trim() : "",
    head: head.ok ? head.stdout.trim() : "",
    upstreamHead: upstreamHead.ok ? upstreamHead.stdout.trim() : "",
    ahead,
    behind,
    staged: parseLines(staged.stdout),
    unstaged: parseLines(unstaged.stdout),
    untracked: parseLines(untracked.stdout),
    unmerged: parseLines(unmerged.stdout),
    rebaseMergePath: rebaseMerge.stdout.trim(),
    rebaseApplyPath: rebaseApply.stdout.trim(),
    rebaseInProgress: existsSync(path.resolve(repoRoot, rebaseMerge.stdout.trim())) || existsSync(path.resolve(repoRoot, rebaseApply.stdout.trim())),
    blockers
  };
}

async function scopeBundle() {
  const [status, stagedNames, stagedStat, stagedDiff, unstagedNames] = await Promise.all([
    runGit(["status", "--short", "--branch"]),
    runGit(["diff", "--cached", "--name-only"]),
    runGit(["diff", "--cached", "--stat"]),
    runGit(["diff", "--cached"], { timeout: 300000 }),
    runGit(["diff", "--name-only"])
  ]);
  return {
    status: commandView(status),
    stagedNames: parseLines(stagedNames.stdout),
    stagedStat: stagedStat.stdout,
    stagedDiff: stagedDiff.stdout,
    unstagedNames: parseLines(unstagedNames.stdout)
  };
}

async function conflictBundle() {
  const [status, unmerged, stages, unstagedCheck, stagedCheck] = await Promise.all([
    runGit(["status"]),
    runGit(["diff", "--name-only", "--diff-filter=U"]),
    runGit(["ls-files", "-u"]),
    runGit(["diff", "--check"], { timeout: 300000 }),
    runGit(["diff", "--cached", "--check"], { timeout: 300000 })
  ]);
  const checkText = [unstagedCheck.stdout, stagedCheck.stdout, unstagedCheck.stderr, stagedCheck.stderr]
    .filter(Boolean)
    .join("\n");
  const markerText = checkText
    .split(/\r?\n/)
    .filter((line) => /leftover conflict marker/i.test(line))
    .join("\n");
  return {
    status: commandView(status),
    unmerged: parseLines(unmerged.stdout),
    stages: stages.stdout,
    markers: markerText,
    unstagedCheck: commandView(unstagedCheck),
    stagedCheck: commandView(stagedCheck)
  };
}

function parseLines(value) {
  return value.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
}

function commandView(result) {
  return {
    command: result.command,
    code: result.code,
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}

async function createRecovery() {
  const ts = timestamp();
  let backupBranch = `backup/git-safe-commit/${ts}`;
  const backupDir = path.join(backupRoot, ts);
  const stagedPatch = path.join(backupDir, "staged.patch");
  const unstagedPatch = path.join(backupDir, "unstaged.patch");
  const statusFile = path.join(backupDir, "status.txt");
  const headFile = path.join(backupDir, "head.txt");
  const untrackedManifest = path.join(backupDir, "untracked-manifest.txt");

  await mkdir(backupDir, { recursive: true });

  const status = await runGit(["status", "--short", "--branch"]);
  const head = await runGit(["rev-parse", "HEAD"]);
  const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard"]);
  const unstagedDiff = await runBuffer("git", ["diff", "--binary"]);
  const stagedDiff = await runBuffer("git", ["diff", "--cached", "--binary"]);

  // 如果 git diff --binary 为空，但 status 显示有修改，则用 git diff HEAD 兜底
  // 解决 Windows Git skip-worktree / CRLF / index 不一致导致 diff 为空但 status 有脏文件的问题
  let unstagedDiffFallback = null;
  const hasStatusMods = /^[AMDR]/m.test(status.stdout);
  if (unstagedDiff.ok && !unstagedDiff.stdout.length && hasStatusMods) {
    unstagedDiffFallback = await runBuffer("git", ["diff", "--binary", "HEAD"]);
  }

  const evidence = [
    ["status snapshot", status],
    ["head snapshot", head],
    ["upstream snapshot", upstream],
    ["untracked manifest", untracked],
    ["unstaged patch", unstagedDiff],
    ["staged patch", stagedDiff]
  ];
  const failedEvidence = evidence.filter(([, result]) => !result.ok);
  if (failedEvidence.length) {
    const results = failedEvidence.map(([label, result]) => ({ label, ...result }));
    await saveState({
      phase: "Inspecting",
      blockers: failedEvidence.map(([label]) => `恢复点证据生成失败：${label}`),
      note: "恢复点证据不完整，未创建 backup branch，未执行 stash。"
    });
    return { recovery: sessionState.activeRecovery, results };
  }

  await writeFile(statusFile, status.stdout, "utf8");
  await writeFile(headFile, `HEAD ${head.stdout.trim()}\nUPSTREAM ${upstream.ok ? upstream.stdout.trim() : ""}\n`, "utf8");
  await writeFile(untrackedManifest, untracked.stdout, "utf8");
  // 优先用 fallback diff（git diff HEAD），它比 git diff（vs index）更可靠
  await writeFile(unstagedPatch, unstagedDiffFallback?.ok ? unstagedDiffFallback.stdout : unstagedDiff.stdout);
  await writeFile(stagedPatch, stagedDiff.stdout);

  const usedFallback = unstagedDiffFallback?.ok && !unstagedDiff.stdout.length;
  const results = [
    { label: "status snapshot", ...status, stdout: `wrote ${relative(statusFile)}` },
    { label: "head snapshot", ...head, stdout: `wrote ${relative(headFile)}` },
    { label: "untracked manifest", ...untracked, stdout: `wrote ${relative(untrackedManifest)}` },
    { label: "unstaged patch", ...unstagedDiff, stdout: `wrote ${relative(unstagedPatch)}${usedFallback ? " (fallback: git diff HEAD)" : ""}` },
    { label: "staged patch", ...stagedDiff, stdout: `wrote ${relative(stagedPatch)}` }
  ];

  const branch = await runGit(["branch", backupBranch]);
  results.push({ label: "backup branch", ...branch });
  if (!branch.ok) {
    return { recovery: sessionState.activeRecovery, results };
  }

  const stashListBefore = await runGit(["stash", "list"]);
  results.push({ label: "stash list before", ...stashListBefore });
  if (!stashListBefore.ok) {
    await saveState({
      phase: "RecoveryCreated",
      blockers: ["无法读取 stash list，未执行 stash push。"],
      activeRecovery: null,
      note: "恢复点未完成。"
    });
    return { recovery: sessionState.activeRecovery, results };
  }

  const stash = await runGit(["stash", "push", "--include-untracked", "-m", `git-safe-commit: preserve local work ${ts}`], { timeout: 300000 });
  results.push({ label: "stash push", ...stash });

  let stashHash = "";
  let stashEmptyWarning = "";
  let dirtyCommitSha = "";
  let usedDirtyCommit = false;
  const stashListAfter = await runGit(["stash", "list"]);
  results.push({ label: "stash list after", ...stashListAfter });
  const stashCountBefore = parseLines(stashListBefore.stdout).length;
  const stashCountAfter = parseLines(stashListAfter.stdout).length;
  if (stash.ok && stashListAfter.ok && stashCountAfter > stashCountBefore) {
    const hash = await runGit(["rev-parse", "stash@{0}"]);
    results.push({ label: "stash hash", ...hash });
    if (hash.ok) {
      stashHash = hash.stdout.trim();
    }
  }

  // stash 为空但 status 显示有修改 → 尝试 dirty commit 兜底（参考 Aider 的 commit-before-undo 模式）
  if (!stashHash && hasStatusMods) {
    // 先检查 git diff HEAD 是否真的有内容（排除 CRLF/skip-worktree 幻影修改）
    const headDiffCheck = await runBuffer("git", ["diff", "--binary", "HEAD"]);
    if (headDiffCheck.ok && headDiffCheck.stdout.length > 0) {
      // 真实修改：用 dirty commit 保护
      const dirtyBranch = `backup/git-safe-commit/${ts}-dirty`;
      const dirtyStash = await runGit(["stash", "push", "--include-untracked", "-m", `git-safe-commit: untracked files ${ts}`]);
      const dirtyBranchResult = await runGit(["branch", dirtyBranch]);
      const dirtyAdd = await runGit(["add", "-A"]);
      const dirtyCommit = await runGit(["commit", "-m", `git-safe-commit: preserve local work ${ts}`, "--allow-empty"]);
      const dirtyShaResult = await runGit(["rev-parse", "HEAD"]);
      const dirtyReset = await runGit(["reset", "--mixed", "HEAD~1"]);

      results.push(
        { label: "dirty stash (untracked)", ...dirtyStash },
        { label: "dirty branch", ...dirtyBranchResult },
        { label: "dirty add", ...dirtyAdd },
        { label: "dirty commit", ...dirtyCommit },
        { label: "dirty commit sha", ...dirtyShaResult },
        { label: "dirty reset mixed", ...dirtyReset }
      );

      if (dirtyShaResult.ok) {
        dirtyCommitSha = dirtyShaResult.stdout.trim();
        usedDirtyCommit = true;
        stashEmptyWarning = "";
        backupBranch = dirtyBranch; // 替换为 dirty 分支名，AI 用它恢复
      } else {
        stashEmptyWarning = "dirty commit 失败，unstaged.patch 已用 git diff HEAD 保存作为兜底。";
        results.push({ label: "dirty commit warning", ok: false, error: stashEmptyWarning });
      }
    } else {
      // git diff HEAD 也是空的 → 幻影修改（CRLF/skip-worktree），可以安全丢弃
      stashEmptyWarning = "git status 显示有修改，但 git diff 和 git diff HEAD 均为空。这是 CRLF/skip-worktree 幻影修改，可以安全忽略。";
      results.push({ label: "phantom changes", ok: true, stdout: stashEmptyWarning });
    }
  }

  const recovery = {
    timestamp: ts,
    backupBranch,
    backupDir: relative(backupDir),
    stagedPatch: relative(stagedPatch),
    unstagedPatch: relative(unstagedPatch),
    statusFile: relative(statusFile),
    headFile: relative(headFile),
    untrackedManifest: relative(untrackedManifest),
    stashHash,
    stashEmptyWarning: stashEmptyWarning || undefined,
    usedFallbackDiff: Boolean(usedFallback),
    dirtyCommitSha: dirtyCommitSha || undefined,
    usedDirtyCommit
  };

  await saveState({
    phase: "RecoveryCreated",
    blockers: [
      ...(!stash.ok && !usedDirtyCommit ? ["stash push 失败，AI 不应进入 rebase。"] : []),
      ...(stashEmptyWarning && !usedDirtyCommit ? [stashEmptyWarning] : [])
    ],
    activeRecovery: recovery,
    note: usedDirtyCommit
      ? "恢复点已创建（dirty commit 模式）。rebase 后必须核对 dirtyCommitSha 和 patch，用非 hard-reset 的路径级 restore 或 patch 恢复。"
      : stashEmptyWarning
        ? "恢复点已创建，但 stash 不可用。AI 必须检查 unstaged.patch 内容确认修改已保存，再决定是否继续。"
        : "恢复点已创建。后续 Git 主流程必须由 AI 执行。"
  });

  return { recovery, results };
}

function relative(target) {
  return path.relative(repoRoot, target).replaceAll("\\", "/");
}

async function validateCommand(body) {
  const command = String(body.command || "").trim();
  const args = Array.isArray(body.args) ? body.args.map(String) : [];
  const full = [command, ...args].join(" ");
  const reasons = [];

  if (command !== "git") {
    reasons.push("guard 只校验 git 命令；其他命令需要 AI 自行解释风险。");
  }
  if (command === "git" && args[0] === "pull") {
    reasons.push("禁止 git pull；必须使用 fetch --prune + rebase @{u}。");
  }
  if (command === "git" && args[0] === "reset" && args.includes("--hard")) {
    reasons.push("禁止 git reset --hard。");
  }
  if (command === "git" && args[0] === "clean") {
    reasons.push("禁止 git clean。");
  }
  if (command === "git" && args[0] === "stash" && args[1] === "pop") {
    reasons.push("禁止 git stash pop；只能 apply，确认安全后再由用户决定是否 drop。");
  }
  if (command === "git" && args[0] === "stash" && args[1] === "drop") {
    reasons.push("默认禁止 stash drop，除非用户明确要求清理恢复点。");
  }
  if (command === "git" && args[0] === "push" && args.some((arg) => arg === "--force" || arg.startsWith("--force="))) {
    reasons.push("禁止普通 force push。");
  }
  if (command === "git" && args[0] === "push" && args.some((arg) => arg === "--force-with-lease" || arg.startsWith("--force-with-lease="))) {
    if (body.forceWithLeaseApproved !== true || !body.branchOwnershipEvidence) {
      reasons.push("force-with-lease 需要用户明确授权和分支归属证据。");
    }
  }
  if (command === "git" && args[0] === "rebase" && !sessionState.activeRecovery) {
    reasons.push("没有恢复点，禁止 rebase。");
  }

  const status = await statusBundle();
  const conflicts = await conflictBundle();
  if (command === "git" && args[0] === "rebase" && !["--abort", "--continue", "--skip"].includes(args[1])) {
    const gitState = await collectGitState(repoRoot, {
      autoCloseSavedExcel: body.autoCloseSavedExcel === true || process.env.GIT_SAFE_COMMIT_AUTOCLOSE_SAVED_EXCEL === "1"
    });
    const summary = summarizeState(gitState);
    for (const blocker of summary.blockers) {
      reasons.push(`pre-rebase blocker: ${blocker}`);
    }
  }
  if (command === "git" && ["commit", "push"].includes(args[0]) && status.unmerged.length) {
    reasons.push("存在 unresolved conflict，禁止 commit/push。");
  }
  if (command === "git" && ["commit", "push"].includes(args[0]) && conflicts.markers.trim()) {
    reasons.push("仍存在冲突 marker，禁止 commit/push。");
  }
  if (command === "git" && args[0] === "rebase" && args[1] === "--continue" && status.unmerged.length) {
    reasons.push("存在 unresolved conflict，禁止 rebase --continue。");
  }
  if (command === "git" && args[0] === "rebase" && args[1] === "--continue" && conflicts.markers.trim()) {
    reasons.push("仍存在冲突 marker，禁止 rebase --continue。");
  }

  return {
    allowed: reasons.length === 0,
    command: full,
    reasons,
    status,
    conflicts
  };
}

async function exportBinaryConflict(body) {
  const recovery = sessionState.activeRecovery;
  if (!recovery?.timestamp) {
    throw new Error("create recovery before exporting binary conflicts");
  }
  const filePath = safeRelativePath(body.path);
  const filename = path.basename(filePath);
  const ext = path.extname(filename) || ".bin";
  const binaryDir = backupPath(recovery.timestamp, "binary-conflicts");
  await mkdir(binaryDir, { recursive: true });

  const oursPath = path.join(binaryDir, `${filename}.ours${ext}`);
  const theirsPath = path.join(binaryDir, `${filename}.theirs${ext}`);
  const basePath = path.join(binaryDir, `${filename}.base${ext}`);
  const base = await runBuffer("git", ["show", `:1:${filePath}`]);
  const ours = await runBuffer("git", ["show", `:2:${filePath}`]);
  const theirs = await runBuffer("git", ["show", `:3:${filePath}`]);
  const stages = await runGit(["ls-files", "-u", "--", filePath]);
  const allUnmerged = await runGit(["ls-files", "-u"]);
  const failed = [];
  if (!stages.ok || !stages.stdout.trim()) {
    failed.push("未找到该路径的 unmerged stages。");
  }
  if (!ours.ok) {
    failed.push("导出 OURS 失败。");
  }
  if (!theirs.ok) {
    failed.push("导出 THEIRS 失败。");
  }
  if (failed.length) {
    if (allUnmerged.ok && !allUnmerged.stdout.trim()) {
      await saveState({
        phase: "Complete",
        blockers: [],
        note: `当前没有 Git 冲突，已忽略过期的冲突导出请求：${filePath}`
      });
    } else {
      await saveState({
        phase: "ConflictBlocked",
        blockers: failed,
        note: `二进制冲突导出失败：${filePath}`
      });
    }
    return {
      recovery,
      results: [
        { label: "export ours", ...ours, stdout: "" },
        { label: "export theirs", ...theirs, stdout: "" },
        { label: "unmerged stages", ...stages },
        { label: "all unmerged stages", ...allUnmerged }
      ]
    };
  }
  if (ours.ok) {
    await writeFile(oursPath, ours.stdout);
  }
  if (theirs.ok) {
    await writeFile(theirsPath, theirs.stdout);
  }
  if (base.ok) {
    await writeFile(basePath, base.stdout);
  }
  const binaryConflict = {
    path: filePath,
    base: base.ok ? relative(basePath) : "",
    ours: relative(oursPath),
    theirs: relative(theirsPath),
    finalPath: filePath
  };

  await saveState({
    phase: "UserResolutionPending",
    lastBinaryConflict: binaryConflict,
    blockers: [`等待用户对比并确认二进制冲突：${filePath}`],
    note: "二进制冲突已导出，最终文件必须放回原冲突路径。"
  });

  return {
    recovery,
    binaryConflict,
    results: [
      { label: "export base", ...base, stdout: base.ok ? `wrote ${relative(basePath)}` : "" },
      { label: "export ours", ...ours, stdout: ours.ok ? `wrote ${relative(oursPath)}` : "" },
      { label: "export theirs", ...theirs, stdout: theirs.ok ? `wrote ${relative(theirsPath)}` : "" },
      { label: "unmerged stages", ...stages }
    ]
  };
}

function assertXlsxConflict(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".xlsx") {
    throw new Error("Excel workbench currently supports only .xlsx conflicts");
  }
}

async function loadExcelConflict(body) {
  const filePath = safeRelativePath(body.path);
  assertXlsxConflict(filePath);
  let exported = null;
  let conflict = null;
  const localPair = Boolean(body.ours || body.theirs || body.base);
  if (localPair) {
    const ours = safeBackupRelativePath(body.ours || "");
    const theirs = safeBackupRelativePath(body.theirs || "");
    const base = body.base ? safeBackupRelativePath(body.base) : "";
    conflict = {
      path: filePath,
      base,
      ours,
      theirs,
      finalPath: filePath
    };
  } else {
    const recovery = sessionState.activeRecovery;
    const parsed = path.parse(filePath);
    const manualOursPath = path.join(repoRoot, parsed.dir, `${parsed.name}_OURS_test${parsed.ext}`);
    const manualTheirsPath = path.join(repoRoot, parsed.dir, `${parsed.name}_THEIRS_test${parsed.ext}`);
    if (recovery?.timestamp && existsSync(manualOursPath) && existsSync(manualTheirsPath)) {
      const conflictDir = backupPath(recovery.timestamp, "binary-conflicts");
      await mkdir(conflictDir, { recursive: true });
      const oursPath = path.join(conflictDir, `${path.basename(filePath)}.manual.ours${parsed.ext}`);
      const theirsPath = path.join(conflictDir, `${path.basename(filePath)}.manual.theirs${parsed.ext}`);
      await copyFile(manualOursPath, oursPath);
      await copyFile(manualTheirsPath, theirsPath);
      conflict = {
        path: filePath,
        base: "",
        ours: relative(oursPath),
        theirs: relative(theirsPath),
        finalPath: filePath,
        manualPair: true
      };
      exported = {
        recovery,
        results: [
          { label: "manual ours workbook", ok: true, stdout: `copied ${relative(manualOursPath)} -> ${conflict.ours}` },
          { label: "manual theirs workbook", ok: true, stdout: `copied ${relative(manualTheirsPath)} -> ${conflict.theirs}` }
        ]
      };
    } else {
      exported = await exportBinaryConflict({ path: filePath });
      conflict = exported.binaryConflict;
    }
    if (!conflict) {
      throw new Error(`no unmerged Excel stages found for ${filePath}; the table merge workbench only opens real Git conflicts`);
    }
  }

  const { data, result } = await runPythonJson([
    excelWorkbenchScript,
    "--mode", "load",
    "--ours", path.resolve(repoRoot, conflict.ours),
    "--theirs", path.resolve(repoRoot, conflict.theirs),
    ...(conflict.base ? ["--base", path.resolve(repoRoot, conflict.base)] : []),
    "--max-rows", String(Number(body.maxRows || 500)),
    "--max-cols", String(Number(body.maxCols || 80))
  ]);
  if (!data.ok) {
    throw new Error(data.error || "Excel workbench load failed");
  }

  const excelConflict = {
    path: filePath,
    base: conflict.base,
    ours: conflict.ours,
    theirs: conflict.theirs,
    finalPath: conflict.finalPath,
    summary: data.summary,
    sheetCount: data.sheetCount,
    structureMismatch: data.structureMismatch,
    sheets: data.sheets
  };

  await saveState({
    phase: "UserResolutionPending",
    lastBinaryConflict: conflict,
    lastExcelConflict: {
      path: excelConflict.path,
      base: excelConflict.base,
      ours: excelConflict.ours,
      theirs: excelConflict.theirs,
      finalPath: excelConflict.finalPath,
      summary: excelConflict.summary,
      sheetCount: excelConflict.sheetCount,
      structureMismatch: excelConflict.structureMismatch,
      localPair: localPair || Boolean(conflict.manualPair),
      manualPair: Boolean(conflict.manualPair)
    },
    blockers: [`等待用户在 Excel 合并工作台确认：${filePath}`],
    note: "Excel 冲突已加载到工作台。页面只能生成候选合并文件，不会 git add 或继续 rebase。"
  });

  return {
    recovery: exported?.recovery || sessionState.activeRecovery,
    binaryConflict: conflict,
    excelConflict,
    results: [
      ...((exported && exported.results) || []),
      { label: "excel workbench load", ...result, stdout: `loaded ${data.sheetCount} sheet(s), summary=${data.summary}` }
    ]
  };
}

async function readGitStageText(filePath, stage) {
  const result = await runBuffer("git", ["show", `:${stage}:${filePath}`]);
  if (!result.ok) {
    return {
      stage,
      available: false,
      content: "",
      error: result.stderr || result.error || `stage ${stage} is unavailable`
    };
  }
  return {
    stage,
    available: true,
    content: result.stdout.toString("utf8"),
    byteLength: result.stdout.length
  };
}

async function loadTextConflict(body) {
  const recovery = sessionState.activeRecovery;
  if (!recovery?.timestamp) {
    throw new Error("create recovery before opening text conflict workbench");
  }
  const filePath = safeRelativePath(body.path);
  assertTextConflict(filePath);

  const stages = await runGit(["ls-files", "-u", "--", filePath]);
  if (!stages.ok || !stages.stdout.trim()) {
    throw new Error(`no unmerged text stages found for ${filePath}`);
  }

  const [base, ours, theirs] = await Promise.all([
    readGitStageText(filePath, 1),
    readGitStageText(filePath, 2),
    readGitStageText(filePath, 3)
  ]);

  let current = "";
  let currentError = "";
  try {
    current = await readFile(path.resolve(repoRoot, filePath), "utf8");
  } catch (error) {
    currentError = error instanceof Error ? error.message : String(error);
  }

  const textConflict = {
    path: filePath,
    finalPath: filePath,
    base,
    ours,
    theirs,
    current: {
      available: currentError === "",
      content: current,
      error: currentError
    },
    stages: stages.stdout
  };

  await saveState({
    phase: "UserResolutionPending",
    lastTextConflict: {
      path: filePath,
      finalPath: filePath,
      hasBase: base.available,
      hasOurs: ours.available,
      hasTheirs: theirs.available
    },
    blockers: [`等待用户在文本合并工作台确认：${filePath}`],
    note: "文本冲突已加载到工作台。页面只能生成候选文本文件，不会覆盖原路径，不会 git add 或继续 rebase。"
  });

  return {
    recovery,
    textConflict,
    results: [
      { label: "unmerged stages", ...stages },
      { label: "read base stage", ok: base.available, code: base.available ? 0 : 1, stdout: base.available ? `${base.byteLength} bytes` : "", stderr: base.error || "" },
      { label: "read ours stage", ok: ours.available, code: ours.available ? 0 : 1, stdout: ours.available ? `${ours.byteLength} bytes` : "", stderr: ours.error || "" },
      { label: "read theirs stage", ok: theirs.available, code: theirs.available ? 0 : 1, stdout: theirs.available ? `${theirs.byteLength} bytes` : "", stderr: theirs.error || "" }
    ]
  };
}

async function writeTextCandidate(body) {
  const recovery = sessionState.activeRecovery;
  if (!recovery?.timestamp) {
    throw new Error("create recovery before writing text merge candidates");
  }
  const filePath = safeRelativePath(body.path);
  assertTextConflict(filePath);
  const content = String(body.content ?? "");
  if (content.length > 5 * 1024 * 1024) {
    throw new Error("text candidate is too large");
  }

  const candidateDir = backupPath(recovery.timestamp, "text-merge-candidates");
  await mkdir(candidateDir, { recursive: true });
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext).replace(/[^a-zA-Z0-9._-]/g, "_") || "merged";
  const outputPath = path.join(candidateDir, `${baseName}.merged.${timestamp()}${ext || ".txt"}`);
  const choicePath = path.join(candidateDir, `${baseName}.choices.${timestamp()}.json`);
  const choices = {
    path: filePath,
    source: String(body.source || "edited"),
    lineChoices: Array.isArray(body.lineChoices) ? body.lineChoices : [],
    contentLength: content.length,
    finalPath: filePath
  };
  await writeFile(outputPath, content, "utf8");
  await writeFile(choicePath, JSON.stringify(choices, null, 2), "utf8");

  const candidate = {
    path: filePath,
    candidate: relative(outputPath),
    choices: relative(choicePath),
    finalPath: filePath,
    source: choices.source
  };

  await saveState({
    phase: "UserResolutionPending",
    lastTextCandidate: candidate,
    blockers: [`文本候选合并文件已生成，等待确认后由 Codex 放回原路径：${filePath}`],
    note: "文本候选合并文件已生成。guard 未覆盖原冲突文件，未执行 git add。"
  });

  return {
    recovery,
    textCandidate: candidate,
    results: [
      { label: "text workbench write candidate", ok: true, code: 0, command: "write text candidate", stdout: `wrote ${candidate.candidate}`, stderr: "" }
    ]
  };
}

function safeChoicePayload(value) {
  const rowChoices = Array.isArray(value?.rowChoices) ? value.rowChoices : [];
  const cellChoices = Array.isArray(value?.cellChoices) ? value.cellChoices : [];
  const optionalNumber = (input) => {
    const value = Number(input);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const rowMeta = (item) => ({
    rowKey: String(item?.rowKey || ""),
    baseRow: optionalNumber(item?.baseRow),
    oursRow: optionalNumber(item?.oursRow),
    theirsRow: optionalNumber(item?.theirsRow)
  });
  const cellMeta = (item) => ({
    ...rowMeta(item),
    baseCell: String(item?.baseCell || ""),
    oursCell: String(item?.oursCell || ""),
    theirsCell: String(item?.theirsCell || "")
  });
  const safeChoice = (item) => {
    if (item?.action === "keep-both") {
      const primary = item.primary === "theirs" ? "theirs" : "ours";
      const secondary = item.secondary === "ours" ? "ours" : "theirs";
      return {
        action: "keep-both",
        primary,
        secondary: primary === secondary ? (primary === "ours" ? "theirs" : "ours") : secondary,
        placement: String(item.placement || ""),
      };
    }
    return {
      action: "choose",
      source: item?.source === "theirs" ? "theirs" : "ours",
    };
  };
  return {
    rowChoices: rowChoices.map((item) => ({
      sheetIndex: Number(item.sheetIndex),
      row: Number(item.row),
      ...rowMeta(item),
      ...safeChoice(item)
    })),
    cellChoices: cellChoices.map((item) => ({
      sheetIndex: Number(item.sheetIndex),
      cell: String(item.cell || ""),
      ...cellMeta(item),
      ...safeChoice(item)
    }))
  };
}

async function writeExcelCandidate(body) {
  const recovery = sessionState.activeRecovery;
  if (!recovery?.timestamp) {
    throw new Error("create recovery before writing Excel merge candidates");
  }
  const filePath = safeRelativePath(body.path);
  assertXlsxConflict(filePath);

  const oursSource = body.ours || sessionState.lastExcelConflict?.ours || "";
  const theirsSource = body.theirs || sessionState.lastExcelConflict?.theirs || "";
  const baseSource = body.base || sessionState.lastExcelConflict?.base || "";
  const ours = oursSource ? safeBackupRelativePath(oursSource) : "";
  const theirs = theirsSource ? safeBackupRelativePath(theirsSource) : "";
  const base = baseSource ? safeBackupRelativePath(baseSource) : "";
  if (!ours || !theirs) {
    throw new Error("load the Excel conflict before writing a candidate");
  }

  const candidateDir = backupPath(recovery.timestamp, "excel-merge-candidates");
  await mkdir(candidateDir, { recursive: true });
  const choicePayload = safeChoicePayload(body.choices || {});
  const choicePath = path.join(candidateDir, `${path.basename(filePath)}.choices.json`);
  await writeFile(choicePath, JSON.stringify(choicePayload, null, 2), "utf8");

  const outputName = `${path.basename(filePath, ".xlsx")}.merged.${timestamp()}.xlsx`;
  const outputPath = path.join(candidateDir, outputName);
  const { data, result } = await runPythonJson([
    excelWorkbenchScript,
    "--mode", "write-candidate",
    "--ours", path.resolve(repoRoot, ours),
    "--theirs", path.resolve(repoRoot, theirs),
    ...(base ? ["--base", path.resolve(repoRoot, base)] : []),
    "--choices", choicePath,
    "--output", outputPath
  ]);
  if (!data.ok) {
    throw new Error(data.error || "Excel candidate write failed");
  }

  const { data: previewData } = await runPythonJson([
    excelWorkbenchScript,
    "--mode", "load",
    "--ours", outputPath,
    "--theirs", outputPath,
    "--choices", choicePath,
    "--max-rows", "50",
    "--max-cols", "20"
  ]);
  if (!previewData.ok) {
    throw new Error(previewData.error || "Excel candidate preview failed");
  }

  const candidate = {
    path: filePath,
    base,
    candidate: relative(outputPath),
    choices: relative(choicePath),
    finalPath: filePath,
    applied: data.applied,
    appliedChoices: choicePayload,
    preview: {
      summary: previewData.summary,
      sheetCount: previewData.sheetCount,
      structureMismatch: previewData.structureMismatch,
      sheets: previewData.sheets
    }
  };

  await saveState({
    phase: "UserResolutionPending",
    lastExcelCandidate: candidate,
    blockers: [`Excel 候选合并文件已生成，等待用户确认后放回原路径：${filePath}`],
    note: "候选合并文件已生成。guard 未覆盖原冲突文件，未执行 git add。"
  });

  return {
    recovery: recovery || null,
    excelCandidate: compactExcelCandidate(candidate),
    results: [
      { label: "excel workbench write candidate", ...result, stdout: `wrote ${candidate.candidate}` }
    ]
  };
}

async function previewExcelCandidate(body) {
  const candidate = safeBackupRelativePath(body.candidate);
  const candidatePath = path.resolve(repoRoot, candidate);
  const finalPath = body.finalPath ? safeRelativePath(body.finalPath) : safeRelativePath(body.path);
  if (!existsSync(candidatePath)) {
    throw new Error(`Excel candidate does not exist: ${body.candidate}`);
  }

  const { data, result } = await runPythonJson([
    excelWorkbenchScript,
    "--mode", "load",
    "--ours", candidatePath,
    "--theirs", candidatePath,
    ...(body.choices ? ["--choices", path.resolve(repoRoot, safeBackupRelativePath(body.choices))] : []),
    "--max-rows", String(Number(body.maxRows || 500)),
    "--max-cols", String(Number(body.maxCols || 80))
  ]);
  if (!data.ok) {
    throw new Error(data.error || "Excel candidate preview failed");
  }

  return {
    excelCandidatePreview: {
      path: finalPath,
      finalPath,
      candidate,
      summary: data.summary,
      sheetCount: data.sheetCount,
      structureMismatch: data.structureMismatch,
      sheets: data.sheets
    },
    results: [
      { label: "excel candidate preview", ...result, stdout: `loaded ${data.sheetCount} sheet(s), summary=${data.summary}` }
    ]
  };
}

async function readBackupFile(body) {
  const { normalized, resolved } = safeBackupReadPath(body.path);
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new Error(`backup path is not a file: ${normalized}`);
  }
  const maxBytes = 1024 * 1024;
  if (info.size > maxBytes) {
    throw new Error(`backup file is too large to preview: ${normalized}`);
  }
  return {
    ok: true,
    path: normalized,
    size: info.size,
    content: await readFile(resolved, "utf8")
  };
}

async function openBackupFile(body) {
  const { normalized, resolved } = safeBackupReadPath(body.path);
  const info = await stat(resolved);
  if (!info.isFile()) {
    throw new Error(`backup path is not a file: ${normalized}`);
  }
  const command = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", resolved]]
    : process.platform === "darwin"
      ? ["open", [resolved]]
      : ["xdg-open", [resolved]];
  const result = await runRaw(command[0], command[1], repoRoot, { timeout: 10000 });
  return {
    ok: result.ok,
    path: normalized,
    fullPath: resolved,
    results: [
      { label: "open backup file", ...result, stdout: result.stdout || resolved }
    ]
  };
}

async function cleanupRecovery() {
  const recovery = sessionState.activeRecovery;
  if (!recovery) {
    return { ok: true, results: [], note: "没有活跃的恢复点需要清理。" };
  }
  const results = [];

  // 删除当前 session 的备份分支（可能是普通分支或 dirty 分支）
  if (recovery.backupBranch) {
    const del = await runGit(["branch", "-D", recovery.backupBranch]);
    results.push({ label: `delete branch ${recovery.backupBranch}`, ...del });
  }

  // 删除当前 session 的所有相关 stash（普通 stash + dirty commit 的 untracked stash）
  const stashList = await runGit(["stash", "list"]);
  const stashLines = stashList.stdout.split(/\r?\n/).filter(Boolean);
  const ts = recovery.timestamp;
  for (let i = stashLines.length - 1; i >= 0; i--) {
    const isMatch = (recovery.stashHash && stashLines[i].includes(recovery.stashHash))
      || (ts && stashLines[i].includes(`git-safe-commit:`) && stashLines[i].includes(ts));
    if (!isMatch) continue;
    const del = await runGit(["stash", "drop", `stash@{${i}}`]);
    results.push({ label: `delete stash@{${i}}`, ...del, stdout: stashLines[i] });
  }

  // 删除当前 session 的备份目录
  if (recovery.backupDir) {
    const dirPath = path.resolve(repoRoot, recovery.backupDir);
    if (existsSync(dirPath)) {
      const { rm } = await import("node:fs/promises");
      await rm(dirPath, { recursive: true, force: true });
      results.push({ label: `delete backup dir ${recovery.backupDir}`, ok: true, command: `rm -rf ${recovery.backupDir}` });
    }
  }

  // 重置 session state
  await saveState({
    phase: "Complete",
    blockers: [],
    activeRecovery: null,
    note: "恢复点已清理。"
  });

  return { ok: true, results };
}

async function routePost(pathname, body) {
  if (pathname === "/api/log") {
    await appendSessionLog("ai-log", body, { results: [] });
    return { ok: true };
  }
  if (pathname === "/api/state") {
    const state = await saveState({
      phase: String(body.phase || sessionState.phase),
      blockers: Array.isArray(body.blockers) ? body.blockers.map(String) : sessionState.blockers,
      note: String(body.note || "")
    });
    await appendSessionLog("state", body, { results: [] });
    return { ok: true, state };
  }
  if (pathname === "/api/recovery/create") {
    const result = await createRecovery();
    await appendSessionLog("recovery-create", body, result);
    return { ok: true, ...result };
  }
  if (pathname === "/api/recovery/cleanup") {
    const result = await cleanupRecovery();
    await appendSessionLog("recovery-cleanup", body, result);
    return result;
  }
  if (pathname === "/api/guard/validate-command") {
    const result = await validateCommand(body);
    await appendSessionLog("guard-validate-command", body, { results: [] });
    return { ok: true, ...result };
  }
  if (pathname === "/api/binary-conflict/export") {
    const result = await exportBinaryConflict(body);
    await appendSessionLog("binary-conflict-export", body, result);
    return { ok: true, ...result };
  }
  if (pathname === "/api/excel-conflict/load") {
    const result = await loadExcelConflict(body);
    await appendSessionLog("excel-conflict-load", body, result);
    return { ok: true, ...result };
  }
  if (pathname === "/api/excel-conflict/write-candidate") {
    const result = await writeExcelCandidate(body);
    await appendSessionLog("excel-conflict-write-candidate", body, result);
    return { ok: true, ...result };
  }
  if (pathname === "/api/excel-candidate/preview") {
    const result = await previewExcelCandidate(body);
    await appendSessionLog("excel-candidate-preview", body, result);
    return { ok: true, ...result };
  }
  if (pathname === "/api/text-conflict/load") {
    const result = await loadTextConflict(body);
    await appendSessionLog("text-conflict-load", body, result);
    return { ok: true, ...result };
  }
  if (pathname === "/api/text-conflict/write-candidate") {
    const result = await writeTextCandidate(body);
    await appendSessionLog("text-conflict-write-candidate", body, result);
    return { ok: true, ...result };
  }
  if (pathname === "/api/backup-file/read") {
    const result = await readBackupFile(body);
    await appendSessionLog("backup-file-read", body, { results: [] });
    return result;
  }
  if (pathname === "/api/backup-file/open") {
    const result = await openBackupFile(body);
    await appendSessionLog("backup-file-open", body, result);
    return result;
  }
  if (pathname === "/api/user-note") {
    await appendSessionLog("user-note", body, { results: [] });
    return { ok: true };
  }
  throw new Error(`unknown endpoint: ${pathname}`);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      json(res, 200, { ok: true });
      return;
    }

    const url = new URL(req.url, `http://${host}:${port}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      html(res, await readFile(panelPath, "utf8"));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/panel/")) {
      const relativeAsset = url.pathname.slice("/panel/".length);
      if (relativeAsset.includes("..") || path.isAbsolute(relativeAsset)) {
        text(res, 404, "not found");
        return;
      }
      const extension = path.extname(relativeAsset);
      const contentType = extension === ".css"
        ? "text/css; charset=utf-8"
        : extension === ".mjs" || extension === ".js"
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream";
      asset(res, contentType, await readFile(path.join(panelDir, relativeAsset), "utf8"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      await openEventStream(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/info") {
      json(res, 200, {
        ok: true,
        guardVersion,
        pid: process.pid,
        repoRoot,
        skillDir,
        serverScript,
        port,
        sessionLogPath: relative(sessionLogPath),
        statePath: relative(statePath),
        state: sessionState
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      json(res, 200, { ok: true, state: sessionState });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, 200, { ok: true, status: await statusBundle() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/scope") {
      json(res, 200, { ok: true, scope: await scopeBundle() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/conflicts") {
      json(res, 200, { ok: true, conflicts: await conflictBundle() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/logs") {
      json(res, 200, {
        ok: true,
        sessionLogPath: relative(sessionLogPath),
        entries: await readSessionLog()
      });
      return;
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      try {
        json(res, 200, await routePost(url.pathname, body));
      } catch (error) {
        await appendSessionLog(url.pathname, body, null, error);
        throw error;
      }
      return;
    }

    text(res, 404, "not found");
  } catch (error) {
    json(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      state: compactSessionState(sessionState)
    });
  }
});

server.listen(port, host, () => {
  console.log("Git Safe Commit guard server");
  console.log(`Version: ${guardVersion}`);
  console.log(`PID: ${process.pid}`);
  console.log(`Repo: ${repoRoot}`);
  console.log(`Open: http://${host}:${port}`);
});
