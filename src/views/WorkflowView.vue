<script setup>
import { computed, nextTick, ref, watch } from "vue";
import {
  buildTableMerge,
  buildLineMergeRows,
  composeLineDraft,
  composeTableDraft,
  composeTableRows,
  isMergeChoice,
  isTableChoice,
  lineChoiceSummary,
  tableChoiceSummary
} from "../conflict-merge-model.js";

const props = defineProps({
  labels: { type: Object, required: true },
  summary: { type: Object, default: null },
  status: { type: Object, default: null },
  sections: { type: Array, default: () => [] },
  files: { type: Array, default: () => [] },
  selectableFiles: { type: Array, default: () => [] },
  conflictFiles: { type: Array, default: () => [] },
  selectedAi: { type: Object, default: null },
  config: { type: Object, default: null },
  blockers: { type: Array, default: () => [] },
  recovery: { type: Object, default: null },
  busy: { type: String, default: "" },
  commitResetKey: { type: Number, default: 0 },
  operationNotice: { type: Object, default: null },
  readiness: { type: Object, required: true },
  nextStep: { type: String, default: "" }
});

const emit = defineEmits(["action", "commit", "load-text-conflict", "write-text-candidate", "load-table-conflict", "write-table-candidate", "load-binary-conflict", "write-binary-candidate", "apply-candidate", "open-repo-file", "export-binary-conflict", "candidate-created", "suggest-message", "blocked", "clear-operation-notice"]);

const selectedPaths = ref([]);
const commitMessage = ref("");
const suggestingMessage = ref(false);
const selectionQuery = ref("");
const lastSelectedPath = ref("");
const confirmAction = ref(null);
const activeConflictPath = ref("");
const textConflict = ref(null);
const textCandidate = ref("");
const textDraftSource = ref("current");
const textLineRows = ref([]);
const tableConflict = ref(null);
const tableMerge = ref(null);
const tableCandidate = ref("");
const selectedTableCellId = ref("");
const tableRowBulkChoice = ref("ours");
const tableBothStrategy = ref("rows");
const binaryConflict = ref(null);
const binaryChoice = ref("ours");
const candidatePath = ref("");
const candidateResultsByPath = ref({});
const workbenchMessage = ref("");
const candidateHighlight = ref(null);
const applyingCandidatePath = ref("");
const tableSideScrollers = { ours: null, theirs: null };
const tablePreviewScroller = ref(null);
let syncingTableSideScroll = false;
const workbenchActive = computed(() => Boolean(activeConflictPath.value));

const selectedFileCount = computed(() => selectedPaths.value.length);
const selectedFilesLabel = computed(() => `${selectedFileCount.value} / ${props.selectableFiles.length}`);
const changedCount = computed(() => props.files.length);
const rebaseInProgress = computed(() => Boolean(props.summary?.rebaseInProgress || props.status?.rebaseInProgress));
const canCommit = computed(() => !commitBlockReason.value && !props.busy);
const canPush = computed(() => !pushBlockReason.value && !props.busy);
const visibleSelectableFiles = computed(() => {
  const query = selectionQuery.value.trim().toLowerCase();
  if (!query) return props.selectableFiles;
  return props.selectableFiles.filter((file) => {
    return [file.path, file.group, file.status].some((value) => String(value || "").toLowerCase().includes(query));
  });
});
const directoryOptions = computed(() => {
  const counts = new Map();
  for (const file of props.selectableFiles) {
    const directory = topDirectory(file.path);
    counts.set(directory, (counts.get(directory) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => left.name.localeCompare(right.name));
});
const tableConflictItems = computed(() => {
  return (tableMerge.value?.cells || [])
    .flatMap((row) => row)
    .filter((cell) => cell.kind === "conflict");
});
const selectedTableConflict = computed(() => {
  return tableConflictItems.value.find((cell) => cell.id === selectedTableCellId.value) || tableConflictItems.value[0] || null;
});
const tableRowsWithDiff = computed(() => {
  return (tableMerge.value?.cells || []).filter((row) => row.some(tableCellHasDiff));
});
const tableColumnIndexes = computed(() => {
  const columns = new Set();
  for (const row of tableRowsWithDiff.value) {
    row.forEach((cell, index) => {
      if (tableCellHasDiff(cell)) columns.add(index);
    });
  }
  if (!columns.size && tableMerge.value?.columnCount) {
    for (let index = 0; index < tableMerge.value.columnCount; index++) columns.add(index);
  }
  return [...columns].sort((left, right) => left - right);
});
const tablePreviewRows = computed(() => composeTableRows(tableMerge.value, { bothStrategy: tableBothStrategy.value }));
const tablePreviewColumnIndexes = computed(() => {
  const width = Math.max(...tablePreviewRows.value.map((row) => row.length), 0);
  return Array.from({ length: width }, (_, index) => index);
});

const commitBlockReason = computed(() => {
  if (!props.config?.repoPath) return "缺少仓库路径";
  if (!props.summary) return "先检查仓库";
  if (rebaseInProgress.value) return "正在 rebase，请继续变基并推送，不要重新 commit";
  if (props.blockers.length) return "存在阻断项";
  if (!selectedPaths.value.length) return "先选择文件";
  return "";
});

const pushBlockReason = computed(() => {
  if (!props.config?.repoPath) return "缺少仓库路径";
  if (!props.summary) return "先检查仓库";
  if (props.blockers.length) return "存在阻断项";
  return "";
});

watch(() => props.selectableFiles, (nextFiles) => {
  const allowed = new Set(nextFiles.map((file) => file.path));
  selectedPaths.value = selectedPaths.value.filter((path) => allowed.has(path));
}, { immediate: true });

watch(() => props.commitResetKey, () => {
  commitMessage.value = "";
  selectedPaths.value = [];
});

function togglePath(path, event) {
  if (event?.shiftKey && lastSelectedPath.value) {
    selectRange(lastSelectedPath.value, path);
  } else {
    selectedPaths.value = selectedPaths.value.includes(path)
      ? selectedPaths.value.filter((item) => item !== path)
      : [...selectedPaths.value, path];
  }
  lastSelectedPath.value = path;
}

function selectAll() {
  selectedPaths.value = props.selectableFiles.map((file) => file.path);
}

function selectVisible() {
  addPaths(visibleSelectableFiles.value.map((file) => file.path));
}

function selectSection(sectionId) {
  const picked = props.files.filter((file) => file.selectable && file.sectionId === sectionId).map((file) => file.path);
  addPaths(picked);
}

function selectDirectory(directory) {
  const picked = props.selectableFiles
    .filter((file) => topDirectory(file.path) === directory)
    .map((file) => file.path);
  addPaths(picked);
}

function invertVisibleSelection() {
  const visiblePaths = new Set(visibleSelectableFiles.value.map((file) => file.path));
  const selected = new Set(selectedPaths.value);
  for (const path of visiblePaths) {
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
  }
  selectedPaths.value = [...selected];
}

function clearSelection() {
  selectedPaths.value = [];
  lastSelectedPath.value = "";
}

function selectRange(fromPath, toPath) {
  const paths = visibleSelectableFiles.value.map((file) => file.path);
  const fromIndex = paths.indexOf(fromPath);
  const toIndex = paths.indexOf(toPath);
  if (fromIndex === -1 || toIndex === -1) {
    addPaths([toPath]);
    return;
  }
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  addPaths(paths.slice(start, end + 1));
}

function addPaths(paths) {
  selectedPaths.value = [...new Set([...selectedPaths.value, ...paths])];
}

function topDirectory(filePath) {
  const parts = String(filePath || "").split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts[0] : ".";
}

async function runCommit() {
  if (commitBlockReason.value) {
    alert(commitBlockReason.value);
    emit("blocked", commitBlockReason.value);
    return;
  }
  const message = await ensureCommitMessage();
  if (!message) {
    const reason = "AI 未能生成提交说明，请手动填写后再提交";
    alert(reason);
    emit("blocked", reason);
    return;
  }
  emit("commit", { paths: selectedPaths.value, message });
}

function runPush() {
  if (pushBlockReason.value) {
    alert(pushBlockReason.value);
    emit("blocked", pushBlockReason.value);
    return;
  }
  confirmAction.value = rebaseInProgress.value ? "continue-rebase-and-push" : "push";
}

function runSync() {
  confirmAction.value = "sync";
}

function confirmExecute() {
  const action = confirmAction.value;
  confirmAction.value = null;
  if (action === "push") {
    emit("action", "push", { confirmed: true });
  } else if (action === "continue-rebase-and-push") {
    emit("action", "continue-rebase-and-push", { confirmed: true });
  } else if (action === "sync") {
    emit("action", "ai-sync");
  }
}

function cancelConfirm() {
  confirmAction.value = null;
}

function closeWorkbench() {
  activeConflictPath.value = "";
  textConflict.value = null;
  textCandidate.value = "";
  textDraftSource.value = "current";
  textLineRows.value = [];
  tableConflict.value = null;
  tableMerge.value = null;
  tableCandidate.value = "";
  selectedTableCellId.value = "";
  tableRowBulkChoice.value = "ours";
  tableBothStrategy.value = "rows";
  binaryConflict.value = null;
  binaryChoice.value = "ours";
  candidatePath.value = "";
  workbenchMessage.value = "";
}

function rememberCandidateResult(path, candidate, message) {
  if (!path || !candidate) return;
  candidateResultsByPath.value = {
    ...candidateResultsByPath.value,
    [path]: { candidate, message }
  };
}

function restoreCandidateResult(path, fallbackMessage) {
  const result = candidateResultsByPath.value[path];
  candidatePath.value = result?.candidate || "";
  workbenchMessage.value = result?.message || fallbackMessage;
}

function conflictCandidateFor(file) {
  return file?.candidate || candidateResultsByPath.value[file?.path]?.candidate || "";
}

async function applyCandidateFor(file) {
  const path = file?.path || "";
  const candidate = conflictCandidateFor(file);
  if (!path || !candidate) return;
  applyingCandidatePath.value = path;
  const result = await new Promise((resolve) => {
    emit("apply-candidate", { path, candidate }, resolve);
  });
  applyingCandidatePath.value = "";
  if (result.ok) {
    const message = `候选内容已应用回冲突文件并暂存：${path}`;
    workbenchMessage.value = message;
    rememberCandidateResult(path, candidate, message);
  } else {
    workbenchMessage.value = result.error || "应用候选失败";
  }
}

function applyCurrentCandidate() {
  applyCandidateFor({ path: activeConflictPath.value, candidate: candidatePath.value });
}

function conflictRowClass(file) {
  const hasCandidate = Boolean(conflictCandidateFor(file));
  return {
    "candidate-ready": hasCandidate,
    "candidate-missing": !hasCandidate
  };
}

function isTextConflict(file) {
  return /\.(cs|asmdef|asmref|js|ts|tsx|mjs|cjs|py|ps1|sh|bat|cmd|java|kt|cpp|h|hpp|c|go|rs|md|txt|json|jsonc|xml|ya?ml|toml|ini|editorconfig|gitignore|gitattributes|shader|hlsl|cginc|compute|uss|uxml)$/i.test(file.path);
}

function isTableConflict(file) {
  return /\.(csv|tsv|xlsx)$/i.test(file.path);
}

async function openTextWorkbench(path) {
  activeConflictPath.value = path;
  tableConflict.value = null;
  tableMerge.value = null;
  tableCandidate.value = "";
  selectedTableCellId.value = "";
  tableRowBulkChoice.value = "ours";
  tableBothStrategy.value = "rows";
  binaryConflict.value = null;
  binaryChoice.value = "ours";
  candidatePath.value = "";
  workbenchMessage.value = "正在加载文本冲突...";
  const result = await new Promise((resolve) => {
    emit("load-text-conflict", { path }, resolve);
  });
  if (!result.ok) {
    workbenchMessage.value = result.error || "加载失败";
    return;
  }
  textConflict.value = result.textConflict;
  textLineRows.value = buildLineMergeRows(
    result.textConflict.ours?.content || "",
    result.textConflict.theirs?.content || ""
  );
  textDraftSource.value = "line";
  textCandidate.value = composeLineDraft(textLineRows.value);
  restoreCandidateResult(path, "文本冲突已加载。上方编辑候选内容，或在按行对比中选择 OURS / THEIRS / BOTH / NONE；只会生成候选文件。");
}

async function openTableWorkbench(path) {
  activeConflictPath.value = path;
  textConflict.value = null;
  textCandidate.value = "";
  textLineRows.value = [];
  selectedTableCellId.value = "";
  tableRowBulkChoice.value = "ours";
  tableBothStrategy.value = "rows";
  binaryConflict.value = null;
  binaryChoice.value = "ours";
  candidatePath.value = "";
  workbenchMessage.value = "正在加载表格冲突...";
  const result = await new Promise((resolve) => {
    emit("load-table-conflict", { path }, resolve);
  });
  if (!result.ok) {
    workbenchMessage.value = result.error || "加载失败";
    return;
  }
  tableConflict.value = result.tableConflict;
  tableMerge.value = result.tableConflict.merge || buildTableMerge(
    result.tableConflict.base?.content || "",
    result.tableConflict.ours?.content || "",
    result.tableConflict.theirs?.content || ""
  );
  selectedTableCellId.value = tableConflictItems.value[0]?.id || "";
  refreshTableCandidate();
  restoreCandidateResult(path, `表格冲突已加载。同格冲突 ${tableMerge.value.conflictCount} 个；不同格自动合并 ${tableMerge.value.autoCount} 个。候选文件只会写入备份目录。`);
}

async function openBinaryWorkbench(path) {
  activeConflictPath.value = path;
  textConflict.value = null;
  textCandidate.value = "";
  textDraftSource.value = "current";
  textLineRows.value = [];
  tableConflict.value = null;
  tableMerge.value = null;
  tableCandidate.value = "";
  selectedTableCellId.value = "";
  tableRowBulkChoice.value = "ours";
  tableBothStrategy.value = "rows";
  binaryConflict.value = null;
  binaryChoice.value = "ours";
  candidatePath.value = "";
  workbenchMessage.value = "正在加载二进制冲突...";
  const result = await new Promise((resolve) => {
    emit("load-binary-conflict", { path }, resolve);
  });
  if (!result.ok) {
    workbenchMessage.value = result.error || "加载失败";
    return;
  }
  binaryConflict.value = result.binaryConflict;
  restoreCandidateResult(path, "二进制冲突已加载。不可文本合并，只能选择 OURS 或 THEIRS 生成候选文件。");
}

async function saveTextCandidate() {
  if (!textConflict.value) return;
  const result = await new Promise((resolve) => {
    emit("write-text-candidate", {
      path: textConflict.value.path,
      content: textCandidate.value,
      source: textDraftSource.value,
      lineChoices: lineChoiceSummary(textLineRows.value)
    }, resolve);
  });
  if (result.ok) {
    const message = `候选文件已生成：${result.textCandidate.candidate}`;
    candidatePath.value = result.textCandidate.candidate;
    workbenchMessage.value = message;
    rememberCandidateResult(textConflict.value.path, result.textCandidate.candidate, message);
    emit("candidate-created", { path: textConflict.value.path, candidate: result.textCandidate.candidate, type: "text" });
  } else {
    candidatePath.value = "";
    workbenchMessage.value = result.error || "生成候选失败";
  }
}

function setDraftFromSource(source) {
  if (!textConflict.value) return;
  textDraftSource.value = source;
  textCandidate.value = textConflict.value[source]?.content || "";
}

function setLineChoice(rowId, choice) {
  if (!isMergeChoice(choice)) return;
  const row = textLineRows.value.find((item) => item.id === Number(rowId));
  if (!row || row.kind !== "changed") return;
  row.choice = choice;
  textDraftSource.value = "line";
  textCandidate.value = composeLineDraft(textLineRows.value);
}

function setAllLineChoices(choice) {
  if (!isMergeChoice(choice)) return;
  for (const row of textLineRows.value) {
    if (row.kind === "changed") row.choice = choice;
  }
  textDraftSource.value = "line";
  textCandidate.value = composeLineDraft(textLineRows.value);
}

function syncCandidateHighlightScroll(event) {
  if (!candidateHighlight.value) return;
  candidateHighlight.value.scrollTop = event.target.scrollTop;
  candidateHighlight.value.scrollLeft = event.target.scrollLeft;
}

function setTableSideScroller(side, element) {
  tableSideScrollers[side] = element;
}

function syncTableSideScroll(side, event) {
  if (syncingTableSideScroll) return;
  const targetSide = side === "ours" ? "theirs" : "ours";
  const target = tableSideScrollers[targetSide];
  if (!target) return;
  syncingTableSideScroll = true;
  target.scrollTop = event.target.scrollTop;
  target.scrollLeft = event.target.scrollLeft;
  requestAnimationFrame(() => {
    syncingTableSideScroll = false;
  });
}

function setTableChoice(rowIndex, columnIndex, choice) {
  if (!isTableChoice(choice) || !tableMerge.value) return;
  const cell = tableMerge.value.cells?.[rowIndex]?.[columnIndex];
  if (!cell || cell.kind !== "conflict") return;
  cell.choice = choice;
  selectedTableCellId.value = cell.id;
  tableRowBulkChoice.value = choice;
  refreshTableCandidate();
  scrollTablePanesToCell(cell);
}

function selectTableConflict(cell) {
  selectedTableCellId.value = cell?.id || "";
  if (isTableChoice(cell?.choice)) tableRowBulkChoice.value = cell.choice;
  scrollTablePanesToCell(cell);
}

function scrollTablePanesToCell(cell) {
  if (!cell) return;
  nextTick(() => {
    scrollTableScrollerToCell(tableSideScrollers.ours, cell);
    scrollTableScrollerToCell(tableSideScrollers.theirs, cell);
    scrollTableScrollerToCell(tablePreviewScroller.value, {
      ...cell,
      row: tablePreviewRowForCell(cell),
      column: tablePreviewColumnForCell(cell)
    });
  });
}

function scrollTableScrollerToCell(scroller, cell) {
  const target = scroller?.querySelector?.(`[data-table-row="${cell.row}"][data-table-column="${cell.column}"]`);
  if (!target) return;
  scroller.scrollTop = Math.max(0, target.offsetTop - (scroller.clientHeight - target.clientHeight) / 2);
  scroller.scrollLeft = Math.max(0, target.offsetLeft - (scroller.clientWidth - target.clientWidth) / 2);
}

function tablePreviewRowForCell(cell) {
  if (tableBothStrategy.value !== "rows") return cell.row;
  let outputRow = 0;
  for (let rowIndex = 0; rowIndex < cell.row; rowIndex++) {
    const row = tableMerge.value?.cells?.[rowIndex] || [];
    outputRow += row.some(isDistinctBothTableCell) ? 2 : 1;
  }
  return outputRow;
}

function tablePreviewColumnForCell(cell) {
  if (tableBothStrategy.value !== "columns") return cell.column;
  const shiftedColumns = new Set();
  for (const row of tableMerge.value?.cells || []) {
    for (const candidate of row) {
      if (candidate.column < cell.column && isDistinctBothTableCell(candidate)) shiftedColumns.add(candidate.column);
    }
  }
  return cell.column + shiftedColumns.size;
}

function isDistinctBothTableCell(cell) {
  return cell?.kind === "conflict" && cell.choice === "both" && cell.ours !== cell.theirs;
}

function setTableRowChoice(rowIndex, choice) {
  if (!isTableChoice(choice) || !tableMerge.value) return;
  const row = tableMerge.value.cells?.[rowIndex] || [];
  for (const cell of row) {
    if (cell.kind === "conflict") cell.choice = choice;
  }
  const firstConflict = row.find((cell) => cell.kind === "conflict");
  if (firstConflict) selectedTableCellId.value = firstConflict.id;
  refreshTableCandidate();
  scrollTablePanesToCell(firstConflict);
}

function applySelectedTableRowChoice() {
  if (!selectedTableConflict.value) return;
  setTableRowChoice(selectedTableConflict.value.row, tableRowBulkChoice.value);
}

function setTableBothStrategy(strategy) {
  tableBothStrategy.value = strategy === "columns" ? "columns" : "rows";
  refreshTableCandidate();
}

function refreshTableCandidate() {
  tableCandidate.value = composeTableDraft(tableMerge.value, { bothStrategy: tableBothStrategy.value });
}

function tableCellHasDiff(cell) {
  return Boolean(cell && !["same", "same-change"].includes(cell.kind));
}

function tableSideCellValue(cell, side) {
  return side === "theirs" ? (cell?.theirs ?? "") : (cell?.ours ?? "");
}

function tableSideCellClass(cell, side) {
  const selectedSource = cell?.choice || "ours";
  return {
    "table-cell-diff": tableCellHasDiff(cell),
    "table-cell-conflict": cell?.kind === "conflict",
    "table-cell-auto": cell?.kind === "auto-ours" || cell?.kind === "auto-theirs",
    "table-cell-selected": cell?.kind === "conflict" && (selectedSource === side || selectedSource === "both"),
    "table-cell-rejected": cell?.kind === "conflict" && selectedSource !== side && selectedSource !== "both"
  };
}

function tableSideChoiceLabel(cell, side) {
  if (cell?.choice === "both") return "都要";
  if (cell?.choice === "none") return "不要";
  return cell?.choice === side ? "采用" : "未选";
}

function tableColumnLabel(index) {
  let value = Number(index) + 1;
  let label = "";
  while (value > 0) {
    value--;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label || String(index + 1);
}

async function saveTableCandidate() {
  if (!tableConflict.value || !tableMerge.value) return;
  const candidateContent = composeTableDraft(tableMerge.value, { bothStrategy: tableBothStrategy.value });
  tableCandidate.value = candidateContent;
  const result = await new Promise((resolve) => {
    emit("write-table-candidate", {
      path: tableConflict.value.path,
      content: `${candidateContent}\n`,
      source: "table",
      cellChoices: tableChoiceSummary(tableMerge.value)
    }, resolve);
  });
  if (result.ok) {
    const message = `表格候选文件已生成：${result.tableCandidate.candidate}`;
    candidatePath.value = result.tableCandidate.candidate;
    workbenchMessage.value = message;
    rememberCandidateResult(tableConflict.value.path, result.tableCandidate.candidate, message);
    emit("candidate-created", { path: tableConflict.value.path, candidate: result.tableCandidate.candidate, type: "table" });
  } else {
    candidatePath.value = "";
    workbenchMessage.value = result.error || "生成候选失败";
  }
}

async function saveBinaryCandidate() {
  if (!binaryConflict.value) return;
  const result = await new Promise((resolve) => {
    emit("write-binary-candidate", {
      path: binaryConflict.value.path,
      choice: binaryChoice.value
    }, resolve);
  });
  if (result.ok) {
    const message = `二进制候选文件已生成：${result.binaryCandidate.candidate}（${result.binaryCandidate.choice.toUpperCase()}，${formatBytes(result.binaryCandidate.byteLength)}）`;
    candidatePath.value = result.binaryCandidate.candidate;
    workbenchMessage.value = message;
    rememberCandidateResult(binaryConflict.value.path, result.binaryCandidate.candidate, message);
    emit("candidate-created", { path: binaryConflict.value.path, candidate: result.binaryCandidate.candidate, type: "binary" });
  } else {
    candidatePath.value = "";
    workbenchMessage.value = result.error || "生成候选失败";
  }
}

async function openGeneratedCandidate() {
  if (!candidatePath.value) return;
  const result = await new Promise((resolve) => {
    emit("open-repo-file", { path: candidatePath.value }, resolve);
  });
  workbenchMessage.value = result.ok
    ? `已请求打开候选文件：${candidatePath.value}`
    : (result.error || "打开候选文件失败");
}

function sourceContent(source) {
  return textConflict.value?.[source]?.content || "";
}

function sourceDescription(source) {
  return {
    current: "Git 写在工作区的冲突文件，通常包含冲突标记。",
    base: "共同祖先，用来判断两边分别改了什么。",
    ours: "当前分支版本。",
    theirs: "合入分支版本。"
  }[source] || "";
}

function sourceLabel(source) {
  return {
    current: "CURRENT",
    base: "BASE",
    ours: "OURS",
    theirs: "THEIRS",
    line: "按行选择",
    edited: "手动编辑"
  }[source] || source;
}

function formatBytes(byteLength) {
  const size = Number(byteLength || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

const codeKeywords = [
  "namespace", "using", "public", "private", "protected", "internal", "sealed", "partial",
  "class", "struct", "interface", "enum", "record", "return", "bool", "int", "float",
  "double", "decimal", "string", "void", "const", "let", "var", "function", "export",
  "import", "from", "if", "else", "new", "async", "await", "static", "readonly", "override",
  "virtual", "abstract", "try", "catch", "finally", "for", "foreach", "while", "switch",
  "case", "break", "continue", "get", "set", "init", "this", "base", "ref", "out", "in",
  "is", "as", "where"
];
const codeKeywordPattern = new RegExp(`\\b(${codeKeywords.join("|")})\\b`, "g");
const codeReservedNames = new Set([
  ...codeKeywords,
  "true", "false", "null", "undefined", "typeof", "nameof", "sizeof", "default",
  "checked", "unchecked", "value"
]);

function highlightedCode(content) {
  return String(content || "")
    .split("\n")
    .map(highlightCodeLine)
    .join("\n");
}

function highlightCodeLine(line) {
  const escaped = escapeHtml(line);
  if (/^(&lt;&lt;&lt;&lt;&lt;&lt;&lt;.*|=======|&gt;&gt;&gt;&gt;&gt;&gt;&gt;.*)$/.test(escaped)) {
    return `<span class="tok-merge">${escaped}</span>`;
  }
  const tokens = new Map();
  let highlighted = protectTokens(escaped, /("([^"\\]|\\.)*"|'([^'\\]|\\.)*')/g, "tok-string", tokens);
  highlighted = protectTokens(highlighted, /(\/\/.*|#.*)$/g, "tok-comment", tokens);
  highlighted = protectCodeNames(highlighted, /\b([A-Za-z_][A-Za-z0-9_]*)\b(?=\s*\()/g, "tok-method", tokens);
  highlighted = protectCodeNames(highlighted, /(\.)([A-Za-z_][A-Za-z0-9_]*)\b/g, "tok-field", tokens);
  highlighted = protectFieldDeclarations(highlighted, tokens);
  highlighted = protectVariableNames(highlighted, tokens);
  highlighted = highlighted
    .replace(codeKeywordPattern, "<span class=\"tok-keyword\">$1</span>")
    .replace(/\b(true|false|null|undefined)\b/g, "<span class=\"tok-literal\">$1</span>")
    .replace(/\b(\d+)\b/g, "<span class=\"tok-number\">$1</span>");
  for (const [token, replacement] of tokens) highlighted = highlighted.replaceAll(token, replacement);
  return highlighted;
}

function protectFieldDeclarations(content, tokens) {
  const typeName = String.raw`[A-Za-z_][A-Za-z0-9_]*(?:&lt;[^&]*&gt;)?(?:\[\])?\??`;
  const declaration = new RegExp(String.raw`\b(${typeName})\s+([A-Za-z_][A-Za-z0-9_]*)\b(?=\s*(?:[=;,]|=&gt;))`, "g");
  return content.replace(declaration, (match, type, name) => {
    const token = `__CODETOKEN_${tokenKey(tokens.size)}__`;
    tokens.set(token, `${type} <span class="tok-field">${name}</span>`);
    return token;
  });
}

function protectVariableNames(content, tokens) {
  return content.replace(/\b([a-z_][A-Za-z0-9_]*)\b/g, (match, name) => {
    if (isSyntaxNameReserved(name)) return match;
    const token = `__CODETOKEN_${tokenKey(tokens.size)}__`;
    tokens.set(token, `<span class="tok-variable">${name}</span>`);
    return token;
  });
}

function protectCodeNames(content, pattern, className, tokens) {
  return content.replace(pattern, (match, prefixOrName, maybeName) => {
    const hasPrefix = typeof maybeName === "string";
    const prefix = hasPrefix ? prefixOrName : "";
    const name = hasPrefix ? maybeName : prefixOrName;
    if (isSyntaxNameReserved(name)) return match;
    const token = `__CODETOKEN_${tokenKey(tokens.size)}__`;
    tokens.set(token, `${prefix}<span class="${className}">${name}</span>`);
    return token;
  });
}

function isSyntaxNameReserved(name) {
  return codeReservedNames.has(name) || name.startsWith("__CODETOKEN_");
}

function protectTokens(content, pattern, className, tokens) {
  return content.replace(pattern, (match) => {
    const token = `__CODETOKEN_${tokenKey(tokens.size)}__`;
    tokens.set(token, `<span class="${className}">${match}</span>`);
    return token;
  });
}

function tokenKey(index) {
  let value = index;
  let key = "";
  do {
    key = String.fromCharCode(65 + (value % 26)) + key;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return key;
}

function escapeHtml(content) {
  return String(content || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function exportBinary(path) {
  activeConflictPath.value = path;
  textConflict.value = null;
  textCandidate.value = "";
  tableConflict.value = null;
  tableMerge.value = null;
  tableCandidate.value = "";
  binaryConflict.value = null;
  binaryChoice.value = "ours";
  candidatePath.value = "";
  workbenchMessage.value = "正在导出二进制冲突两边版本...";
  const result = await new Promise((resolve) => {
    emit("export-binary-conflict", { path }, resolve);
  });
  workbenchMessage.value = result.ok
    ? `已导出 OURS: ${result.binaryConflict.ours}\nTHEIRS: ${result.binaryConflict.theirs}`
    : (result.error || "导出失败");
}

async function suggestMessage() {
  if (!selectedPaths.value.length) return;
  await ensureCommitMessage({ force: true });
}

async function ensureCommitMessage({ force = false } = {}) {
  const existingMessage = commitMessage.value.trim();
  if (existingMessage && !force) return existingMessage;
  suggestingMessage.value = true;
  try {
    const message = await new Promise((resolve) => {
      emit("suggest-message", selectedPaths.value, resolve);
    });
    if (message) commitMessage.value = message.trim();
    return commitMessage.value.trim();
  } finally {
    suggestingMessage.value = false;
  }
}
</script>

<template>
  <template v-if="!workbenchActive">
  <header class="topbar settings-topbar">
    <div>
      <p class="eyebrow">{{ labels.workflow }}</p>
      <h2>检查、选择、提交、推送</h2>
    </div>
    <div class="command-bar">
      <button class="mini-command" type="button" :disabled="Boolean(busy)" @click="emit('action', 'inspect')">{{ labels.inspectRepo }}</button>
      <button class="mini-command" type="button" :disabled="!canCommit" @click="runCommit">{{ labels.aiCommit }}</button>
      <button class="mini-command danger" type="button" :disabled="!canPush" @click="runPush">{{ labels.aiPush }}</button>
    </div>
  </header>

  <div v-if="operationNotice" class="operation-notice" :class="operationNotice.tone" role="status">
    <div>
      <strong>{{ operationNotice.title }}</strong>
      <span>{{ operationNotice.message }}</span>
    </div>
    <button type="button" aria-label="关闭操作提示" @click='emit("clear-operation-notice")'>关闭</button>
  </div>

  <section class="status-metrics">
    <div class="metric" :class="readiness.tone"><span>{{ labels.safety }}</span><strong>{{ readiness.label }}</strong></div>
    <div class="metric"><span>{{ labels.branch }}</span><strong>{{ summary?.branch || "-" }}</strong></div>
    <div class="metric"><span>{{ labels.ahead }} / {{ labels.behind }}</span><strong>{{ summary ? `${summary.ahead} / ${summary.behind}` : "-" }}</strong></div>
    <div class="metric"><span>{{ labels.worktree }}</span><strong>{{ summary ? (summary.cleanWorktree ? labels.clean : labels.dirty) : labels.unchecked }}</strong></div>
  </section>

  <section class="primary-grid">
    <article class="commit-card">
      <div class="panel-head">
        <div>
          <h3>{{ labels.commitQueue }}</h3>
          <p class="muted">只提交勾选的路径；未勾选的本地改动会保留在工作区。</p>
        </div>
        <span class="counter">{{ selectedFilesLabel }}</span>
      </div>

      <div class="commit-message">
        <label>
          <span>{{ labels.commitMessage }}</span>
          <textarea v-model="commitMessage" :placeholder="labels.commitMessagePlaceholder" rows="3"></textarea>
        </label>
      </div>

      <div class="file-actions">
        <div class="selection-filter">
          <input v-model="selectionQuery" type="search" placeholder="搜索路径、状态或分组">
          <button class="text-button" type="button" @click="selectVisible">选择筛选结果</button>
        </div>
        <button class="text-button" type="button" @click="selectAll">全选可提交</button>
        <button class="text-button" type="button" @click="invertVisibleSelection">反选当前</button>
        <button class="text-button" type="button" @click="selectSection('staged')">只选已暂存</button>
        <button class="text-button" type="button" @click="selectSection('unstaged')">只选未暂存</button>
        <button class="text-button" type="button" @click="selectSection('untracked')">只选未跟踪</button>
        <button class="text-button" type="button" @click="clearSelection">清空选择</button>
        <button class="text-button" type="button" @click="emit('action', 'inspect')">{{ labels.refresh }}</button>
      </div>

      <div v-if="directoryOptions.length" class="directory-actions">
        <span>按目录选择</span>
        <button
          v-for="directory in directoryOptions"
          :key="directory.name"
          class="text-button"
          type="button"
          @click="selectDirectory(directory.name)"
        >{{ directory.name }} ({{ directory.count }})</button>
      </div>

      <div class="queue-list">
        <button
          v-for="file in visibleSelectableFiles"
          :key="`${file.group}:${file.path}`"
          class="queue-row"
          :class="{ selected: selectedPaths.includes(file.path) }"
          type="button"
          @click="togglePath(file.path, $event)"
        >
          <span class="checkmark" aria-hidden="true"></span>
          <span class="file-meta"><strong>{{ file.path }}</strong><small>{{ file.group }} · {{ file.status }}</small></span>
        </button>
        <div v-if="!selectableFiles.length" class="empty-state">{{ labels.fileHint }}</div>
      </div>

      <div class="commit-actions">
        <button class="btn secondary suggest" type="button" :disabled="suggestingMessage || !selectedPaths.length" @click="suggestMessage">{{ suggestingMessage ? '生成中...' : 'AI 生成说明' }}</button>
        <button class="btn" type="button" :disabled="!canCommit" @click="runCommit">{{ labels.aiCommit }}</button>
        <span class="disabled-reason">{{ commitBlockReason || "将按选中路径提交" }}</span>
      </div>
    </article>

    <aside class="action-card">
      <h3>{{ labels.next }}</h3>
      <p class="next-copy">{{ nextStep }}</p>
      <div class="action-row-pair">
        <button class="btn secondary" type="button" :disabled="Boolean(busy)" @click="emit('action', 'create-recovery')">{{ labels.createRecovery }}</button>
        <button class="btn secondary" type="button" :disabled="Boolean(busy)" @click="emit('action', 'fetch')">{{ labels.fetchRemote }}</button>
      </div>
      <button class="btn sync-btn" type="button" :disabled="Boolean(busy)" @click="runSync">{{ labels.aiSync }}</button>
      <div class="action-stack">
        <button class="btn danger" type="button" :disabled="!canPush" @click="runPush">{{ rebaseInProgress ? '继续变基并推送' : labels.aiPush }}</button>
        <span class="disabled-reason">{{ pushBlockReason || (rebaseInProgress ? "冲突已解决后继续 rebase，然后推送" : "推送门禁已满足") }}</span>
      </div>

      <div v-if="conflictFiles.length" class="conflict-box">
        <strong>{{ labels.conflictWorkbench }}</strong>
        <div v-for="file in conflictFiles" :key="file.path" class="conflict-row" :class="conflictRowClass(file)">
          <div class="conflict-file-meta">
            <code>{{ file.path }}</code>
            <span v-if="conflictCandidateFor(file)" class="candidate-ready-pill">候选已生成</span>
            <span v-else class="candidate-missing-pill">待生成候选</span>
          </div>
          <div class="conflict-actions">
            <button
              v-if="conflictCandidateFor(file)"
              class="text-button apply-candidate-btn"
              type="button"
              :disabled="Boolean(busy) || applyingCandidatePath === file.path"
              @click="applyCandidateFor(file)"
            >{{ applyingCandidatePath === file.path ? '应用中...' : '应用候选并暂存' }}</button>
            <button v-if="isTableConflict(file)" class="text-button open-workbench-btn" type="button" :disabled="Boolean(busy)" @click="openTableWorkbench(file.path)">{{ labels.openTableWorkbench }}</button>
            <button v-else-if="isTextConflict(file)" class="text-button open-workbench-btn" type="button" :disabled="Boolean(busy)" @click="openTextWorkbench(file.path)">{{ labels.openTextWorkbench }}</button>
            <button v-else class="text-button open-workbench-btn" type="button" :disabled="Boolean(busy)" @click="openBinaryWorkbench(file.path)">{{ labels.openBinaryWorkbench }}</button>
          </div>
        </div>
      </div>

      <div class="safety-box" :class="{ bad: blockers.length }">
        <strong>{{ labels.blockers }}</strong>
        <pre>{{ blockers.length ? blockers.join("\n") : labels.noBlockers }}</pre>
      </div>
      <div class="safety-box warn">
        <strong>{{ labels.recoveryPoint }}</strong>
        <pre>{{ recovery ? JSON.stringify(recovery, null, 2) : labels.noRecovery }}</pre>
      </div>
    </aside>
  </section>

  <section class="panel">
    <div class="panel-head compact-head"><h3>{{ labels.status }}</h3><span class="muted">{{ changedCount }} 个改动项</span></div>
    <div class="status-strip">
      <div v-for="section in sections" :key="section.name" class="status-card"><span>{{ section.name }}</span><strong>{{ section.files.length }}</strong></div>
    </div>
    <div class="file-table">
      <div class="table-head"><span>{{ labels.group }}</span><span>{{ labels.status }}</span><span>{{ labels.path }}</span></div>
      <div v-if="files.length">
        <div v-for="file in files" :key="`${file.group}:${file.status}:${file.path}`" class="file-row">
          <span>{{ file.group }}</span><span>{{ file.status }}</span><code>{{ file.path }}</code>
        </div>
      </div>
      <div v-else class="empty-state">{{ labels.fileHint }}</div>
    </div>
  </section>
  </template>

  <template v-if="workbenchActive">
  <header class="topbar settings-topbar">
    <div>
      <p class="eyebrow">{{ labels.conflictWorkbench }}</p>
      <h2>{{ activeConflictPath }}</h2>
    </div>
    <div class="command-bar">
      <button class="mini-command" type="button" @click="closeWorkbench">返回</button>
    </div>
  </header>

  <section v-if="conflictFiles.length" class="conflict-workbench-shell">
    <div v-if="textConflict" class="text-conflict-workbench">
      <div class="settings-card-head">
        <div>
          <h3>文本冲突工作台</h3>
          <p>候选文件只写入 .git/git-safe-commit-backups，不覆盖原冲突文件，不执行 git add。</p>
        </div>
      </div>
      <div class="workbench-body">
        <div class="text-candidate">
          <div class="text-pane-head">
            <div>
              <strong>候选合并内容</strong>
              <span>{{ textConflict.path }}</span>
            </div>
            <span class="source-pill">{{ sourceLabel(textDraftSource) }}</span>
          </div>
          <div class="code-editor-shell">
            <pre ref="candidateHighlight" class="code-highlight candidate-highlight" v-html="highlightedCode(textCandidate)"></pre>
            <textarea v-model="textCandidate" spellcheck="false" rows="18" wrap="off" @input="textDraftSource = 'edited'" @scroll="syncCandidateHighlightScroll"></textarea>
          </div>
        </div>

        <div class="text-relation">
          <strong>对比关系</strong>
          <span>BASE -> OURS：当前分支做了什么。</span>
          <span>BASE -> THEIRS：合入分支做了什么。</span>
          <span>CURRENT：Git 留在工作区的冲突标记文件。</span>
          <span>候选内容：确认后由 Codex 或用户复制回原路径再验证。</span>
        </div>

        <div class="text-line-merge">
          <div class="text-line-toolbar">
            <div>
              <strong>按行对比：OURS -> THEIRS</strong>
              <span>{{ textLineRows.length }} 行；冲突行可以逐行选择。</span>
            </div>
            <div class="toolbar">
              <button class="mini-btn text-choice-btn ours" type="button" @click="setAllLineChoices('ours')">全部 OURS</button>
              <button class="mini-btn text-choice-btn theirs" type="button" @click="setAllLineChoices('theirs')">全部 THEIRS</button>
              <button class="mini-btn" type="button" @click="setAllLineChoices('both')">全部 BOTH</button>
              <button class="mini-btn" type="button" @click="setAllLineChoices('none')">全部 NONE</button>
              <button class="mini-btn" type="button" @click="setDraftFromSource('current')">重置 CURRENT</button>
            </div>
          </div>
          <div class="text-line-table-wrap">
            <table class="text-line-table">
              <thead>
                <tr>
                  <th>O</th>
                  <th>OURS</th>
                  <th>T</th>
                  <th>THEIRS</th>
                  <th>选择</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in textLineRows" :key="row.id" :class="row.kind === 'changed' ? ['line-changed', `choice-${row.choice}`] : 'line-same'">
                  <td class="line-number">{{ row.oursLineNumber }}</td>
                  <td :class="{ 'line-ours-cell': row.kind === 'changed' }"><pre class="line-cell">{{ row.ours }}</pre></td>
                  <td class="line-number">{{ row.theirsLineNumber }}</td>
                  <td :class="{ 'line-theirs-cell': row.kind === 'changed' }"><pre class="line-cell">{{ row.theirs }}</pre></td>
                  <td class="line-choice">
                    <template v-if="row.kind === 'changed'">
                      <span class="text-conflict-label">冲突</span>
                      <span class="choice-current"><span class="choice-state-dot" :class="row.choice"></span>当前 {{ row.choice.toUpperCase() }}</span>
                      <button class="mini-btn text-choice-btn ours" :class="{ active: row.choice === 'ours' }" :aria-pressed="row.choice === 'ours'" type="button" @click="setLineChoice(row.id, 'ours')">OURS</button>
                      <button class="mini-btn text-choice-btn theirs" :class="{ active: row.choice === 'theirs' }" :aria-pressed="row.choice === 'theirs'" type="button" @click="setLineChoice(row.id, 'theirs')">THEIRS</button>
                      <button class="mini-btn text-choice-btn both" :class="{ active: row.choice === 'both' }" :aria-pressed="row.choice === 'both'" type="button" @click="setLineChoice(row.id, 'both')">BOTH</button>
                      <button class="mini-btn text-choice-btn none" :class="{ active: row.choice === 'none' }" :aria-pressed="row.choice === 'none'" type="button" @click="setLineChoice(row.id, 'none')">NONE</button>
                    </template>
                    <span v-else class="muted">same</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="text-grid">
          <div v-for="source in ['current', 'base', 'ours', 'theirs']" :key="source" class="text-pane" :class="{ active: textDraftSource === source }">
            <div class="text-pane-head">
              <div>
                <strong>{{ sourceLabel(source) }}</strong>
                <span>{{ sourceDescription(source) }}</span>
              </div>
              <button class="mini-btn" :class="{ active: textDraftSource === source }" type="button" @click="setDraftFromSource(source)">整份采用</button>
            </div>
            <pre class="text-source code-highlight source-highlight" v-html="highlightedCode(sourceContent(source))"></pre>
          </div>
        </div>

        <div class="workbench-actions">
          <button class="btn" type="button" @click="saveTextCandidate">{{ labels.writeConflictCandidate }}</button>
          <div class="candidate-result" v-if="candidatePath">
            <span>候选文件已生成：<code>{{ candidatePath }}</code></span>
            <button class="btn secondary apply-candidate-btn" type="button" :disabled="Boolean(busy) || applyingCandidatePath === activeConflictPath" @click="applyCurrentCandidate">{{ applyingCandidatePath === activeConflictPath ? '应用中...' : '应用候选并暂存' }}</button>
            <button class="btn secondary open-candidate-btn" type="button" @click="openGeneratedCandidate">打开候选文件</button>
          </div>
          <pre v-if="workbenchMessage" class="workbench-message">{{ workbenchMessage }}</pre>
        </div>
      </div>
    </div>

    <div v-if="tableConflict && tableMerge" class="table-conflict-workbench">
      <div class="settings-card-head">
        <div>
          <h3>表格冲突工作台</h3>
          <p>同一个格子双方都改时手动选择；不同格子的单边修改会自动进入候选表。不会覆盖原文件，不执行 git add。</p>
        </div>
      </div>
      <div class="workbench-body">
        <div class="table-workbench-hero">
          <div class="table-hero-main">
            <span class="choice-state-dot" :class="tableMerge.conflictCount ? 'theirs' : 'ours'"></span>
            <div>
              <strong>{{ tableMerge.conflictCount ? "需要人工决策" : "可自动合并" }}</strong>
              <p>默认以 OURS 为基底；只有显式选择 THEIRS 的格子会覆盖候选。不同格子的单边修改自动进入候选。</p>
            </div>
          </div>
          <div class="table-hero-metrics">
            <div class="excel-metric bad"><span>同格冲突</span><strong>{{ tableMerge.conflictCount }}</strong></div>
            <div class="excel-metric ok"><span>自动合并</span><strong>{{ tableMerge.autoCount }}</strong></div>
            <div class="excel-metric info"><span>显示行列</span><strong>{{ tableRowsWithDiff.length }} / {{ tableColumnIndexes.length }}</strong></div>
            <div class="excel-metric"><span>候选模式</span><strong>只写备份</strong></div>
          </div>
          <div class="table-hero-note">
            <strong>{{ tableConflict.path }}</strong>
            <span>候选文件不会覆盖原冲突文件，不执行 git add。</span>
          </div>
        </div>

        <div class="table-decision-grid" :class="{ 'no-conflicts': !tableConflictItems.length }">
          <section class="table-conflict-list">
            <div class="table-section-head">
              <strong>冲突队列</strong>
              <span class="source-pill" :class="{ auto: tableConflictItems.every((cell) => cell.choice) }">{{ tableConflictItems.filter((cell) => cell.choice).length }}/{{ tableConflictItems.length }} 已选择</span>
            </div>
            <div v-if="tableConflictItems.length" class="table-conflict-table-wrap">
              <table class="table-conflict-table">
                <thead>
                  <tr><th>格子</th><th>OURS</th><th>THEIRS</th><th>当前</th></tr>
                </thead>
                <tbody>
                  <tr
                    v-for="cell in tableConflictItems"
                    :key="cell.id"
                    :class="{ active: selectedTableConflict?.id === cell.id }"
                    @click="selectTableConflict(cell)"
                  >
                    <td><strong>{{ cell.label }}</strong></td>
                    <td>{{ cell.ours }}</td>
                    <td>{{ cell.theirs }}</td>
                    <td>{{ (cell.choice || "ours").toUpperCase() }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-else class="table-empty-decision">当前表格没有同格冲突，可以直接生成候选文件。</div>
          </section>

          <section v-if="selectedTableConflict" class="table-conflict-detail">
            <div class="table-section-head">
              <strong>{{ selectedTableConflict.label }} 决策</strong>
              <span class="source-pill">{{ (selectedTableConflict.choice || "ours").toUpperCase() }}</span>
            </div>
            <div class="table-value-grid">
              <div class="table-value-card base"><span>BASE</span><code>{{ selectedTableConflict.base }}</code></div>
              <div
                class="table-value-card ours"
                :class="{ active: selectedTableConflict.choice === 'ours' }"
                role="button"
                tabindex="0"
                @click="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'ours')"
                @keydown.enter.prevent="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'ours')"
                @keydown.space.prevent="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'ours')"
              >
                <span>OURS 当前分支</span><code>{{ selectedTableConflict.ours }}</code>
              </div>
              <div
                class="table-value-card theirs"
                :class="{ active: selectedTableConflict.choice === 'theirs' }"
                role="button"
                tabindex="0"
                @click="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'theirs')"
                @keydown.enter.prevent="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'theirs')"
                @keydown.space.prevent="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'theirs')"
              >
                <span>THEIRS 合入分支</span><code>{{ selectedTableConflict.theirs }}</code>
              </div>
            </div>
            <div class="table-choice-panel">
              <div class="table-choice-segment" aria-label="当前格子决策">
                <button class="table-choice-option ours" :class="{ active: selectedTableConflict.choice === 'ours' }" type="button" @click="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'ours')">
                  <strong>OURS</strong><span>当前分支</span>
                </button>
                <button class="table-choice-option theirs" :class="{ active: selectedTableConflict.choice === 'theirs' }" type="button" @click="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'theirs')">
                  <strong>THEIRS</strong><span>合入分支</span>
                </button>
                <button class="table-choice-option both" :class="{ active: selectedTableConflict.choice === 'both' }" type="button" @click="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'both')">
                  <strong>BOTH</strong><span>两个都要</span>
                </button>
                <button class="table-choice-option none" :class="{ active: selectedTableConflict.choice === 'none' }" type="button" @click="setTableChoice(selectedTableConflict.row, selectedTableConflict.column, 'none')">
                  <strong>NONE</strong><span>清空</span>
                </button>
              </div>
              <div v-if="selectedTableConflict.choice === 'both'" class="table-output-mode" aria-label="BOTH 输出方式">
                <span>BOTH 输出</span>
                <button class="mini-btn" :class="{ active: tableBothStrategy === 'rows' }" type="button" @click="setTableBothStrategy('rows')">新增行</button>
                <button class="mini-btn" :class="{ active: tableBothStrategy === 'columns' }" type="button" @click="setTableBothStrategy('columns')">新增列</button>
              </div>
              <div class="table-row-bulk">
                <span>应用到本行</span>
                <select v-model="tableRowBulkChoice">
                  <option value="ours">OURS</option>
                  <option value="theirs">THEIRS</option>
                  <option value="both">BOTH</option>
                  <option value="none">NONE</option>
                </select>
                <button class="mini-btn" type="button" @click="applySelectedTableRowChoice">应用</button>
              </div>
            </div>
            <p class="table-detail-note">BOTH 默认新增一行保留 OURS 和 THEIRS 两份记录；切到新增列时，会在冲突列后插入 THEIRS 列。NONE 会让该候选格子留空。</p>
          </section>
        </div>

        <div class="table-side-grid">
          <section v-for="side in ['ours', 'theirs']" :key="side" class="table-side-pane" :class="side">
            <div class="table-section-head">
              <strong>{{ side === 'ours' ? 'OURS 左侧' : 'THEIRS 右侧' }}</strong>
              <span>{{ side === 'ours' ? '当前分支版本' : '合入分支版本' }}</span>
            </div>
            <div class="table-sheet-wrap" :ref="(el) => setTableSideScroller(side, el)" @scroll="syncTableSideScroll(side, $event)">
              <table class="table-sheet">
                <thead>
                  <tr>
                    <th>#</th>
                    <th v-for="column in tableColumnIndexes" :key="column">{{ tableColumnLabel(column) }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in tableRowsWithDiff" :key="`${side}:${row[0]?.row}`">
                    <th>
                      <span>R{{ (row[0]?.row || 0) + 1 }}</span>
                    </th>
                    <td
                      v-for="column in tableColumnIndexes"
                      :key="`${side}:${row[0]?.row}:${column}`"
                      :data-table-kind="side"
                      :data-table-row="row[column]?.row"
                      :data-table-column="column"
                      :class="tableSideCellClass(row[column], side)"
                      @click="row[column]?.kind === 'conflict' && setTableChoice(row[column].row, row[column].column, side)"
                    >
                      <span v-if="row[column]?.kind === 'conflict'" class="chosen-cell-badge">{{ tableSideChoiceLabel(row[column], side) }}</span>
                      <span v-else-if="row[column]?.kind === `auto-${side}`" class="auto-merge-label">自动采用</span>
                      <code>{{ tableSideCellValue(row[column], side) }}</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section class="table-preview-pane">
          <div class="table-section-head">
            <strong>候选预览</strong>
            <span>{{ tableBothStrategy === 'rows' ? 'BOTH 会新增候选行。' : 'BOTH 会新增 THEIRS 列。' }}</span>
          </div>
          <div ref="tablePreviewScroller" class="table-sheet-wrap" data-table-preview>
            <table class="table-sheet preview-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th v-for="column in tablePreviewColumnIndexes" :key="column">{{ tableColumnLabel(column) }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in tablePreviewRows" :key="`preview:${rowIndex}`">
                  <th>{{ rowIndex === 0 ? 'HEADER' : `R${rowIndex + 1}` }}</th>
                  <td
                    v-for="column in tablePreviewColumnIndexes"
                    :key="`preview:${rowIndex}:${column}`"
                    data-table-kind="preview"
                    :data-table-row="rowIndex"
                    :data-table-column="column"
                    :class="{ 'table-cell-diff': rowIndex > 0 }"
                  >
                    <code>{{ row[column] ?? "" }}</code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="workbench-actions">
          <button class="btn" type="button" @click="saveTableCandidate">{{ labels.writeConflictCandidate }}</button>
          <div class="candidate-result" v-if="candidatePath">
            <span>候选文件已生成：<code>{{ candidatePath }}</code></span>
            <button class="btn secondary apply-candidate-btn" type="button" :disabled="Boolean(busy) || applyingCandidatePath === activeConflictPath" @click="applyCurrentCandidate">{{ applyingCandidatePath === activeConflictPath ? '应用中...' : '应用候选并暂存' }}</button>
            <button class="btn secondary open-candidate-btn" type="button" @click="openGeneratedCandidate">打开候选文件</button>
          </div>
          <pre v-if="workbenchMessage" class="workbench-message">{{ workbenchMessage }}</pre>
        </div>
      </div>
    </div>

    <div v-if="binaryConflict" class="binary-conflict-workbench">
      <div class="settings-card-head">
        <div>
          <h3>二进制冲突工作台</h3>
          <p>二进制文件不做文本合并。这里只能选择 OURS 或 THEIRS 生成候选文件，不覆盖原冲突文件，不执行 git add。</p>
        </div>
      </div>
      <div class="workbench-body">
        <div class="binary-summary">
          <span class="source-pill">BINARY</span>
          <span>{{ binaryConflict.path }}</span>
          <span>BASE {{ binaryConflict.base.available ? formatBytes(binaryConflict.base.byteLength) : "不可用" }}</span>
        </div>

        <div class="binary-choice-grid">
          <button
            class="binary-choice-card ours"
            :class="{ active: binaryChoice === 'ours' }"
            type="button"
            :aria-pressed="binaryChoice === 'ours'"
            @click="binaryChoice = 'ours'"
          >
            <span class="binary-choice-kicker">当前分支</span>
            <strong>OURS</strong>
            <small>stage {{ binaryConflict.ours.stage }} · {{ formatBytes(binaryConflict.ours.byteLength) }}</small>
            <em>{{ binaryChoice === 'ours' ? '将写入候选文件' : '点击选择左侧版本' }}</em>
          </button>

          <button
            class="binary-choice-card theirs"
            :class="{ active: binaryChoice === 'theirs' }"
            type="button"
            :aria-pressed="binaryChoice === 'theirs'"
            @click="binaryChoice = 'theirs'"
          >
            <span class="binary-choice-kicker">合入分支</span>
            <strong>THEIRS</strong>
            <small>stage {{ binaryConflict.theirs.stage }} · {{ formatBytes(binaryConflict.theirs.byteLength) }}</small>
            <em>{{ binaryChoice === 'theirs' ? '将写入候选文件' : '点击选择右侧版本' }}</em>
          </button>
        </div>

        <div class="workbench-actions">
          <button class="btn" type="button" @click="saveBinaryCandidate">生成 {{ binaryChoice.toUpperCase() }} 候选文件</button>
          <div class="candidate-result" v-if="candidatePath">
            <span>候选文件已生成：<code>{{ candidatePath }}</code></span>
            <button class="btn secondary apply-candidate-btn" type="button" :disabled="Boolean(busy) || applyingCandidatePath === activeConflictPath" @click="applyCurrentCandidate">{{ applyingCandidatePath === activeConflictPath ? '应用中...' : '应用候选并暂存' }}</button>
            <button class="btn secondary open-candidate-btn" type="button" @click="openGeneratedCandidate">打开候选文件</button>
          </div>
          <pre v-if="workbenchMessage" class="workbench-message">{{ workbenchMessage }}</pre>
        </div>
      </div>
    </div>
  </section>
  </template>

  <Teleport to="body">
    <div v-if="confirmAction" class="confirm-overlay" @click.self="cancelConfirm">
      <div class="confirm-dialog">
        <h3>{{ confirmAction === 'push' ? '确认推送' : confirmAction === 'continue-rebase-and-push' ? '确认继续变基并推送' : '确认同步' }}</h3>
        <p v-if="confirmAction === 'push'">即将推送到远端，请确认当前分支的提交已经完成。</p>
        <p v-else-if="confirmAction === 'continue-rebase-and-push'">当前处于 rebase 流程。将执行 git rebase --continue，成功后直接推送到远端，不会再创建一遍普通提交。</p>
        <p v-else>即将获取远端最新状态并执行 rebase，本地提交会被变基。</p>
        <div class="confirm-actions">
          <button class="btn secondary" type="button" @click="cancelConfirm">取消</button>
          <button class="btn" :class="{ danger: confirmAction === 'push' }" type="button" @click="confirmExecute">确认执行</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
