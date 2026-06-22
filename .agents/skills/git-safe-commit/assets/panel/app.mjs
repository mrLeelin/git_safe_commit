import { apiBase, request } from "./api.mjs";
import { $, commandText, escapeHtml, list } from "./dom.mjs";
import { bindBackdropClose, closeModal, openModal } from "./components/modal.mjs";
import { appendOutput, bindOutputViewer, openResultViewer, setOutput } from "./components/output-viewer.mjs";
import { createExcelWorkbench } from "./workbenches/excel-workbench.mjs";
import { createWorkbenchRegistry } from "./workbenches/registry.mjs";
import { createScriptWorkbench } from "./workbenches/script-workbench.mjs";
import { createTextWorkbench } from "./workbenches/text-workbench.mjs";

const view = {
  info: null,
  status: null,
  logs: [],
  excel: null,
  text: null,
  textDraft: "",
  textDraftSource: "current",
  activeSheetIndex: 1,
  rowChoices: new Map(),
  cellChoices: new Map()
};

const BlockerPathPattern = /[^\s:;"'<>，。；：、]+(?:\.(?:xlsx|xlsm|xlsb|xls|cs|asmdef|asmref|mjs|js|cjs|py|ps1|bat|cmd|sh|ts|tsx|java|kt|cpp|h|hpp|c|go|rs|md|txt|json|jsonc|xml|yml|yaml|toml|ini|editorconfig|gitignore|gitattributes|shader|hlsl|cginc|compute|uss|uxml))/i;

const ThemeStorageKey = "git-safe-commit-theme";

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("theme-dark", isDark);
  const button = $("#themeToggleBtn");
  const label = $("#themeToggleText");
  if (button) button.setAttribute("aria-pressed", String(isDark));
  if (label) label.textContent = isDark ? "夜晚模式" : "白天模式";
}

function preferredTheme() {
  const saved = localStorage.getItem(ThemeStorageKey);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function bindThemeToggle() {
  applyTheme(preferredTheme());
  $("#themeToggleBtn")?.addEventListener("click", () => {
    const nextTheme = document.body.classList.contains("theme-dark") ? "light" : "dark";
    localStorage.setItem(ThemeStorageKey, nextTheme);
    applyTheme(nextTheme);
  });
}

function bindSideActions() {
  document.querySelectorAll("[data-click-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const target = document.getElementById(button.dataset.clickTarget);
      target?.click();
    });
  });
}

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function currentRelevantPathSet(state = view.info?.state || {}, status = view.status) {
  const paths = new Set((status?.unmerged || []).map(normalizePath));
  for (const blocker of state.blockers || []) {
    const path = String(blocker || "").replaceAll("\\", "/").match(BlockerPathPattern)?.[0];
    if (path) paths.add(normalizePath(path));
  }
  if (state.lastExcelConflict?.path) paths.add(normalizePath(state.lastExcelConflict.path));
  if (state.lastBinaryConflict?.path) paths.add(normalizePath(state.lastBinaryConflict.path));
  return paths;
}

function isCurrentCandidate(candidate, relevantPaths) {
  if (!candidate?.path) return false;
  return relevantPaths.has(normalizePath(candidate.path)) || relevantPaths.has(normalizePath(candidate.finalPath));
}

function recentCandidates(state = view.info?.state || {}) {
  const candidates = [];
  const relevantPaths = currentRelevantPathSet(state);
  if (state.lastTextCandidate) {
    const candidate = {
      kind: "Text",
      title: "文本候选记录",
      ...state.lastTextCandidate
    };
    if (isCurrentCandidate(candidate, relevantPaths)) candidates.push(candidate);
  }
  if (state.lastExcelCandidate) {
    const candidate = {
      kind: "Excel",
      title: "表格候选记录",
      ...state.lastExcelCandidate
    };
    if (isCurrentCandidate(candidate, relevantPaths)) candidates.push(candidate);
  }
  return candidates;
}

async function copyToClipboard(value, button) {
  await navigator.clipboard.writeText(String(value || ""));
  const previous = button.textContent;
  button.textContent = "已复制";
  setTimeout(() => { button.textContent = previous; }, 900);
}

async function showBackupFile(filePath, title) {
  setOutput(`正在读取 ${filePath}...`, title, false);
  try {
    const data = await request("/api/backup-file/read", {
      method: "POST",
      body: JSON.stringify({ path: filePath })
    });
    setOutput([
      `path: ${data.path}`,
      `size: ${data.size} bytes`,
      "",
      data.content
    ].join("\n"), title);
  } catch (error) {
    setOutput(`ERROR\n${error.message}`, title);
  }
}

async function openBackupFile(filePath, title, button) {
  const previous = button?.textContent;
  if (button) button.textContent = "正在打开...";
  try {
    const data = await request("/api/backup-file/open", {
      method: "POST",
      body: JSON.stringify({ path: filePath })
    });
    setOutput(`已打开候选文件:\n${data.fullPath || data.path}`, title);
  } catch (error) {
    setOutput(`ERROR\n${error.message}`, title);
  } finally {
    if (button) button.textContent = previous;
  }
}

function appendCandidateCard(parent, candidate) {
  const card = document.createElement("div");
  card.className = "candidate-card";

  const summary = document.createElement("div");
  summary.className = "candidate-summary";
  summary.textContent = [
    `${candidate.title}: ${candidate.path}`,
    `candidate: ${candidate.candidate}`,
    `choices: ${candidate.choices}`,
    `final path: ${candidate.finalPath}`,
    `source: ${candidate.source || "workbench"}`
  ].join("\n");
  card.appendChild(summary);

  const actions = document.createElement("div");
  actions.className = "candidate-actions";

  const copyCandidate = document.createElement("button");
  copyCandidate.type = "button";
  copyCandidate.className = "btn secondary";
  copyCandidate.textContent = "复制候选路径";
  copyCandidate.onclick = () => copyToClipboard(candidate.candidate, copyCandidate);
  actions.appendChild(copyCandidate);

  const copyFinal = document.createElement("button");
  copyFinal.type = "button";
  copyFinal.className = "btn secondary";
  copyFinal.textContent = "复制原路径";
  copyFinal.onclick = () => copyToClipboard(candidate.finalPath, copyFinal);
  actions.appendChild(copyFinal);

  if (candidate.kind === "Text") {
    const viewCandidate = document.createElement("button");
    viewCandidate.type = "button";
    viewCandidate.className = "btn secondary";
    viewCandidate.textContent = "查看候选内容";
    viewCandidate.onclick = () => showBackupFile(candidate.candidate, "文本候选内容");
    actions.appendChild(viewCandidate);
  }

  if (candidate.kind === "Excel") {
    const openExcelFile = document.createElement("button");
    openExcelFile.type = "button";
    openExcelFile.className = "btn";
    openExcelFile.textContent = "打开合并文件";
    openExcelFile.onclick = () => openBackupFile(candidate.candidate, "打开 Excel 候选文件", openExcelFile);
    actions.appendChild(openExcelFile);

    const previewExcel = document.createElement("button");
    previewExcel.type = "button";
    previewExcel.className = "btn secondary";
    previewExcel.textContent = "预览最终表格";
    previewExcel.onclick = () => excelWorkbench.previewExcelCandidate(candidate);
    actions.appendChild(previewExcel);

    const viewExcelChoices = document.createElement("button");
    viewExcelChoices.type = "button";
    viewExcelChoices.className = "btn secondary";
    viewExcelChoices.textContent = "查看选择记录";
    viewExcelChoices.onclick = () => showBackupFile(candidate.choices, "表格选择记录");
    actions.appendChild(viewExcelChoices);
  } else {
    const viewChoices = document.createElement("button");
    viewChoices.type = "button";
    viewChoices.className = "btn secondary";
    viewChoices.textContent = "查看选择记录";
    viewChoices.onclick = () => showBackupFile(candidate.choices, `${candidate.kind} choices`);
    actions.appendChild(viewChoices);
  }

  card.appendChild(actions);

  const note = document.createElement("div");
  note.className = "candidate-note";
  note.textContent = "这是最近生成的候选记录，不代表当前仍有 Git 阻断。页面只负责查看和复制；是否放回原路径由 Codex 在终端验证后处理。";
  card.appendChild(note);

  parent.appendChild(card);
}

function appendCandidatePanel(parent) {
  const candidates = recentCandidates();
  if (!candidates.length) return false;

  const panel = document.createElement("div");
  panel.className = "candidate-list";
  for (const candidate of candidates) {
    appendCandidateCard(panel, candidate);
  }
  parent.appendChild(panel);
  return true;
}

function renderCandidates() {
  const candidatePanel = $("#candidatePanel");
  const candidateBox = $("#candidateBox");
  if (!candidatePanel || !candidateBox) return;

  const candidates = recentCandidates();
  candidatePanel.hidden = !candidates.length;
  candidateBox.className = "box";
  candidateBox.innerHTML = "";
  if (!candidates.length) {
    candidateBox.textContent = "暂无候选记录。";
    return;
  }

  const note = document.createElement("div");
  note.className = "candidate-note";
  note.textContent = "这些是最近由合并工作台生成的候选文件，仅供查看和复制；当前阻断项仍以右上方“阻断项”区域为准。";
  candidateBox.appendChild(note);
  appendCandidatePanel(candidateBox);
}

function blockerKey(blocker) {
  const text = String(blocker || "");
  const path = text.replaceAll("\\", "/").match(BlockerPathPattern)?.[0] || text;
  return normalizePath(path);
}

function mergeBlockerItems(blockers, unmerged) {
  const entries = new Map();
  for (const blocker of blockers) {
    const text = String(blocker || "");
    if (text) entries.set(blockerKey(text), text);
  }
  for (const path of unmerged) {
    const text = String(path || "");
    if (text && !entries.has(blockerKey(text))) entries.set(blockerKey(text), text);
  }
  return [...entries.values()];
}

function renderBlockers(blockers, status = view.status) {
  const blockerBox = $("#blockerBox");
  const unmerged = status?.unmerged || [];
  const blockerItems = mergeBlockerItems(blockers, unmerged);
  blockerBox.className = blockerItems.length ? "box bad" : "box";
  blockerBox.innerHTML = "";
  if (!blockerItems.length) {
    blockerBox.textContent = "暂无阻断项。";
    return;
  }

  const list = document.createElement("div");
  list.className = "blocker-list";
  for (const blocker of blockerItems) {
    const item = document.createElement("div");
    item.className = "blocker-item";

    const text = document.createElement("span");
    text.textContent = blocker;
    item.appendChild(text);

    const workbench = workbenchRegistry.resolve(blocker);
    if (workbench) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn secondary";
      button.textContent = workbench.label;
      button.onclick = workbench.open;
      item.appendChild(button);
    }

    list.appendChild(item);
  }
  blockerBox.appendChild(list);
}

function renderInfo() {
  const info = view.info;
  const state = info?.state || {};
  const phase = state.phase || "Idle";
  const blockers = state.blockers || [];
  const recovery = state.activeRecovery;

  $("#phaseText").textContent = `阶段：${phase}`;
  $("#phaseDot").className = `dot ${blockers.length ? "bad" : phase === "Complete" ? "ok" : ""}`;
  $("#headline").textContent = blockers.length ? "存在阻断项" : phase === "Complete" ? "已完成" : "观察中";
  $("#phaseNote").textContent = state.note || "页面仅显示状态和证据，不执行 Git 主流程。";

  renderBlockers(blockers);
  renderCandidates();

  if (recovery) {
    $("#recoveryBox").className = "box";
    $("#recoveryBox").textContent = [
      `timestamp: ${recovery.timestamp}`,
      `backup branch: ${recovery.backupBranch}`,
      `backup dir: ${recovery.backupDir}`,
      `staged patch: ${recovery.stagedPatch}`,
      `unstaged patch: ${recovery.unstagedPatch}`,
      `untracked manifest: ${recovery.untrackedManifest}`,
      `stash hash: ${recovery.stashHash || "no stash created"}`
    ].join("\n");
  } else {
    $("#recoveryBox").className = "box warn";
    $("#recoveryBox").textContent = "尚未创建当前会话恢复点。任何 rebase 或显式 merge 前都应先创建恢复点。";
  }
}

function statusText(status) {
  return [
    `repo: ${status.repoRoot}`,
    `branch: ${status.branch || "(unknown)"}`,
    `upstream: ${status.upstream || "(none)"}`,
    `ahead/behind: ${status.ahead || "0"}/${status.behind || "0"}`,
    `HEAD: ${status.head || "(unknown)"}`,
    "",
    "staged:",
    list(status.staged),
    "",
    "unstaged:",
    list(status.unstaged),
    "",
    "untracked:",
    list(status.untracked),
    "",
    "unmerged:",
    list(status.unmerged),
    "",
    `rebase in progress: ${status.rebaseInProgress ? "yes" : "no"}`
  ].join("\n");
}

function renderStatus(status) {
  view.status = status;
  const clean = !status.staged.length && !status.unstaged.length && !status.untracked.length && !status.unmerged.length;
  const blockerCount = (view.info?.state?.blockers || []).length;
  const hasConflict = status.unmerged.length > 0;
  const inRebase = Boolean(status.rebaseInProgress);

  $("#branchPill").textContent = `分支：${status.branch || "(unknown)"} -> ${status.upstream || "(no upstream)"}`;
  $("#syncPill").textContent = `同步：ahead ${status.ahead || "0"} / behind ${status.behind || "0"}`;
  $("#aheadValue").textContent = status.ahead || "0";
  $("#behindValue").textContent = status.behind || "0";
  $("#dirtyValue").textContent = clean ? "干净" : "有改动";

  const risks = [];
  if (!status.upstream) risks.push("当前分支没有 upstream。");
  if (status.ahead && status.behind && Number(status.ahead) > 0 && Number(status.behind) > 0) risks.push("本地和远端同时前进，默认需要 recovery 后 rebase；仅在用户明确说 merge/合并时才进入显式 merge。");
  if (!clean) risks.push("工作区不干净，提交前必须做路径级 scope review。");
  if (hasConflict) risks.push("存在未解决冲突。");
  if (inRebase) risks.push("当前存在 rebase 状态。");
  if (blockerCount) risks.push("guard state 中存在阻断项。");
  if (!risks.length) risks.push("未发现状态级阻断；仍需以 preflight/final-verify 输出为准。");

  $("#riskBox").className = risks.length && risks[0] !== "未发现状态级阻断；仍需以 preflight/final-verify 输出为准。" ? "box warn" : "box";
  $("#riskBox").textContent = risks.join("\n");

  $("#nextBox").textContent = suggestNext(status, clean, hasConflict, inRebase, blockerCount);

  $("#statusBox").textContent = statusText(status);
  renderBlockers(view.info?.state?.blockers || [], status);
}

function suggestNext(status, clean, hasConflict, inRebase, blockerCount) {
  if (blockerCount) return "先处理阻断项。页面不执行修复，只显示状态和证据。";
  if (hasConflict) return "查看冲突；文本冲突由 Codex 结合代码处理，Excel/二进制冲突先导出 OURS/THEIRS。";
  if (inRebase) return "检查 staged、unmerged 和 conflict marker；满足条件后由 Codex 在终端继续 rebase。显式 merge 冲突则改由 Codex 验证后提交 merge commit。";
  if (!status.upstream) return "先设置或确认 upstream。";
  if (!clean) return "先做 scope review，明确哪些路径属于本次提交。";
  if (Number(status.behind || 0) > 0) return "默认同步前必须创建恢复点，然后由 Codex 执行 fetch + rebase；只有用户明确说 merge/合并时才走 fetch + merge。";
  if (Number(status.ahead || 0) > 0) return "可以进入 push gate：先跑 preflight，再由 Codex 执行 git push。";
  return "当前看起来已同步。最终结论仍以 final-verify 为准。";
}

function renderState(nextState) {
  view.info = view.info || {};
  view.info.state = nextState || {};
  renderInfo();
  if (view.status) renderStatus(view.status);
}

function formatResults(data) {
  const chunks = [];
  if (data.binaryConflict) {
    chunks.push("二进制冲突已导出");
    chunks.push(`冲突原路径: ${data.binaryConflict.path}`);
    chunks.push(`OURS: ${data.binaryConflict.ours}`);
    chunks.push(`THEIRS: ${data.binaryConflict.theirs}`);
    chunks.push(`最终文件必须放回: ${data.binaryConflict.finalPath}`);
    chunks.push("");
  }
  if (data.excelConflict) {
    chunks.push("Excel 工作台已加载");
    chunks.push(`summary: ${data.excelConflict.summary}`);
    chunks.push(`sheets: ${data.excelConflict.sheetCount}`);
    chunks.push(`structure mismatch: ${data.excelConflict.structureMismatch ? "yes" : "no"}`);
    chunks.push("");
  }
  if (data.excelCandidate) {
    chunks.push("Excel 候选合并文件已生成");
    chunks.push(`candidate: ${data.excelCandidate.candidate}`);
    chunks.push(`choices: ${data.excelCandidate.choices}`);
    chunks.push(`最终确认后手工放回: ${data.excelCandidate.finalPath}`);
    chunks.push("");
  }
  if (data.textCandidate) {
    chunks.push("Text compare/merge candidate written");
    chunks.push(`candidate: ${data.textCandidate.candidate}`);
    chunks.push(`choices: ${data.textCandidate.choices}`);
    chunks.push(`final path: ${data.textCandidate.finalPath}`);
    chunks.push(`source: ${data.textCandidate.source || "workbench"}`);
    chunks.push("");
  }
  for (const item of data.results || []) {
    chunks.push(`$ ${item.command || item.label}`);
    chunks.push(`code: ${item.code}`);
    if (item.stdout) chunks.push(String(item.stdout).trimEnd());
    if (item.stderr) chunks.push(String(item.stderr).trimEnd());
    if (item.error) chunks.push(String(item.error));
    chunks.push("");
  }
  return chunks.join("\n") || JSON.stringify(data, null, 2);
}

function formatLogEntry(entry) {
  const chunks = [`[${entry.time}] ${entry.event} phase=${entry.phase || ""}${entry.error ? " ERROR" : ""}`];
  if (entry.error) chunks.push(entry.error);
  for (const item of entry.results || []) {
    chunks.push(`  $ ${item.command || item.label}`);
    chunks.push(`  code: ${item.code}`);
    if (item.stdout) chunks.push(`  stdout: ${String(item.stdout).trimEnd()}`);
    if (item.stderr) chunks.push(`  stderr: ${String(item.stderr).trimEnd()}`);
  }
  return chunks.join("\n");
}

function renderLogEntries(payload) {
  view.logs = Array.isArray(payload) ? payload : payload?.entries || [];
  setOutput(view.logs.length ? view.logs.map(formatLogEntry).join("\n\n") : "暂无日志。", "查看日志", false);
}

function appendLogEntry(entry) {
  view.logs.push(entry);
  appendOutput(formatLogEntry(entry));
}

function openExcelModal() {
  openModal("#excelModalBackdrop");
}

function closeExcelModal() {
  closeModal("#excelModalBackdrop");
}

function openTextModal() {
  openModal("#textModalBackdrop");
}

function closeTextModal() {
  closeModal("#textModalBackdrop");
}

async function refreshAll(showViewer = false) {
  try {
    const info = await request("/api/info");
    view.info = info;
    $("#serverDot").className = "dot ok";
    $("#serverText").textContent = "本地服务已连接";
    $("#repoRoot").textContent = info.repoRoot;
    renderInfo();

    const status = await request("/api/status");
    renderStatus(status.status);
    if (showViewer) {
      setOutput(statusText(status.status), "刷新状态");
    }
  } catch (error) {
    $("#serverDot").className = "dot bad";
    $("#serverText").textContent = "本地服务未连接";
    $("#repoRoot").textContent = "在仓库根目录运行：node .kiro/skills/git-safe-commit/scripts/git-safe-commit-server.mjs";
    setOutput(`ERROR\n${error.message}`, "刷新状态失败");
  }
}

function connectEvents() {
  if (!window.EventSource) {
    $("#eventDot").className = "dot bad";
    $("#eventText").textContent = "浏览器不支持实时事件";
    return;
  }

  const events = new EventSource(`${apiBase}/api/events`);
  events.onopen = () => {
    $("#eventDot").className = "dot ok";
    $("#eventText").textContent = "实时事件已连接";
  };
  events.onerror = () => {
    $("#eventDot").className = "dot bad";
    $("#eventText").textContent = "实时事件断开，浏览器会自动重连";
  };
  events.addEventListener("state", (event) => renderState(JSON.parse(event.data)));
  events.addEventListener("logs", (event) => renderLogEntries(JSON.parse(event.data)));
  events.addEventListener("log", (event) => appendLogEntry(JSON.parse(event.data)));
}

async function showScope() {
  setOutput("正在读取提交范围...", "查看提交范围");
  try {
    const data = await request("/api/scope");
    const scope = data.scope;
    setOutput([
      "staged names:",
      list(scope.stagedNames),
      "",
      "unstaged names:",
      list(scope.unstagedNames),
      "",
      "staged stat:",
      scope.stagedStat || "(empty)",
      "",
      "staged diff:",
      scope.stagedDiff || "(empty)"
    ].join("\n"), "查看提交范围");
  } catch (error) {
    setOutput(`ERROR\n${error.message}`, "查看提交范围失败");
  }
}

async function showConflicts() {
  setOutput("正在读取冲突...", "查看冲突");
  try {
    const data = await request("/api/conflicts");
    const conflicts = data.conflicts;
    setOutput([
      "unmerged files:",
      list(conflicts.unmerged),
      "",
      "index stages:",
      conflicts.stages || "(empty)",
      "",
      "conflict markers:",
      conflicts.markers || "(none)",
      "",
      "diff check:",
      commandText(conflicts.unstagedCheck) || "(unstaged ok)",
      commandText(conflicts.stagedCheck) || "(staged ok)",
      "",
      "status:",
      conflicts.status.stdout || conflicts.status.stderr
    ].join("\n"), "查看冲突");
  } catch (error) {
    setOutput(`ERROR\n${error.message}`, "查看冲突失败");
  }
}

async function showLogs() {
  setOutput("正在读取日志...", "查看日志");
  try {
    const data = await request("/api/logs");
    const chunks = [`log: ${data.sessionLogPath}`, ""];
    for (const entry of data.entries || []) {
      chunks.push(formatLogEntry(entry));
      chunks.push("");
    }
    setOutput(chunks.join("\n") || "暂无日志。", "查看日志");
  } catch (error) {
    setOutput(`ERROR\n${error.message}`, "查看日志失败");
  }
}

const excelWorkbench = createExcelWorkbench({ view, formatResults, openExcelModal, refreshAll });
const scriptWorkbench = createScriptWorkbench();
const textWorkbench = createTextWorkbench({ view, formatResults, openTextModal, refreshAll });
const workbenchRegistry = createWorkbenchRegistry({ view, excelWorkbench, scriptWorkbench, textWorkbench });

$("#refreshBtn").onclick = () => refreshAll(true);
$("#scopeBtn").onclick = showScope;
$("#conflictBtn").onclick = showConflicts;
$("#logsBtn").onclick = showLogs;
$("#outputBtn").onclick = openResultViewer;
$("#resetExcelChoicesBtn").onclick = excelWorkbench.resetExcelChoices;
$("#writeCandidateBtn").onclick = excelWorkbench.writeExcelCandidate;
$("#closeExcelModalBtn").onclick = closeExcelModal;
$("#writeTextCandidateBtn").onclick = textWorkbench.writeTextCandidate;
$("#closeTextModalBtn").onclick = closeTextModal;
bindOutputViewer();
bindThemeToggle();
bindSideActions();
bindBackdropClose("#excelModalBackdrop", closeExcelModal);
bindBackdropClose("#textModalBackdrop", closeTextModal);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeExcelModal();
    closeTextModal();
    closeModal("#viewerBackdrop");
  }
});

refreshAll();
connectEvents();
