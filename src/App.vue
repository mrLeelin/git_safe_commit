<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import {
  applyConflictCandidate as applyConflictCandidateApi,
  chooseRepoFolder as chooseRepoFolderApi,
  loadAiInstallations,
  loadConfig,
  loadBinaryConflict as loadBinaryConflictApi,
  loadGraph as loadGraphApi,
  loadHealth,
  loadRepoFileDiff as loadRepoFileDiffApi,
  loadState,
  openEvents as openEventStream,
  exportBinaryConflict as exportBinaryConflictApi,
  openRepoFile as openRepoFileApi,
  loadTableConflict as loadTableConflictApi,
  loadTextConflict as loadTextConflictApi,
  refreshAudit as refreshAuditApi,
  reviewAuditWithAi as reviewAuditWithAiApi,
  runAction as runActionApi,
  saveSettings as saveSettingsApi,
  suggestMessage as suggestMessageApi,
  writeBinaryCandidate as writeBinaryCandidateApi,
  writeTableCandidate as writeTableCandidateApi,
  writeTextCandidate as writeTextCandidateApi
} from "./client/api.js";
import Rail from "./components/Rail.vue";
import GitGraphView from "./views/GitGraphView.vue";
import SettingsView from "./views/SettingsView.vue";
import WorkflowView from "./views/WorkflowView.vue";
import LogsView from "./views/LogsView.vue";

const zh = {
  title: "Git 安全提交",
  desc: "面向脏工作区的本地提交与推送控制台。只提交你确认过的路径。",
  connected: "本地服务已连接",
  connecting: "正在连接",
  noRepoPath: "尚未配置仓库路径",
  workflow: "提交工作流",
  inspectRepo: "检查仓库",
  createRecovery: "创建恢复点",
  fetchRemote: "获取远端",
  aiCommit: "提交选中文件",
  aiSync: "同步远端",
  aiPush: "直接推送到远端",
  repo: "仓库",
  branch: "分支",
  upstream: "上游",
  phase: "阶段",
  ahead: "领先",
  behind: "落后",
  worktree: "工作区",
  clean: "干净",
  dirty: "有改动",
  unchecked: "未检查",
  commitQueue: "提交队列",
  commitMessage: "提交说明",
  commitMessagePlaceholder: "用一句话说明这次提交为什么存在",
  selectableFiles: "可提交文件",
  conflictFiles: "冲突文件",
  conflictWorkbench: "冲突工作台",
  openTextWorkbench: "打开文本工作台",
  openTableWorkbench: "打开表格工作台",
  openBinaryWorkbench: "打开二进制工作台",
  exportBinaryConflict: "导出二进制版本",
  writeConflictCandidate: "生成候选文件",
  safety: "安全状态",
  blockers: "阻断项",
  noBlockers: "当前没有阻断项。",
  next: "推送和拉取",
  recoveryPoint: "恢复点",
  noRecovery: "本轮还没有恢复点。",
  graph: "Git 提交树",
  refresh: "刷新",
  noGraph: "暂无提交图。",
  status: "状态",
  path: "路径",
  group: "分组",
  fileHint: "先检查仓库后显示文件列表。",
  staged: "已暂存",
  unstaged: "未暂存",
  untracked: "未跟踪",
  conflicts: "冲突",
  logs: "日志",
  settings: "设置",
  output: "最近输出",
  eventLog: "事件日志",
  saveLocal: "保存到本地 config.json。读取配置时 API Key 会被脱敏。",
  repoPath: "仓库路径",
  chooseFolder: "选择文件夹",
  savedRepositories: "已记录仓库",
  aiBase: "AI 地址",
  model: "模型",
  temp: "温度",
  confirmPush: "推送前要求浏览器确认",
  saveSettings: "保存设置",
  reload: "重新读取",
  waiting: "等待检查仓库状态。",
  missingMessage: "先填写提交说明。",
  missingFiles: "先选择要提交的文件。",
  blocked: "被安全检查阻断",
  ready: "可执行",
  needsInspect: "需要检查",
  protectedRules: "保护规则",
  forbidPull: "禁止 git pull",
  forbidReset: "禁止 reset --hard",
  forbidClean: "禁止 git clean",
  forbidStashPop: "禁止 stash pop",
  forbidForcePush: "禁止 force push"
};

const activeView = ref("workflow");
const themeMode = ref("dark");
const railCollapsed = ref(false);
const commitResetKey = ref(0);
const conflictCandidates = ref({});
const operationNotice = ref(null);
const AuditRefreshIntervalMs = 3000;
const pushSuccessActions = new Set(["push", "ai-push", "continue-rebase-and-push", "abort-rebase", "ai-sync-and-push", "restore-tool-stashes"]);
const repositoryChangingActions = new Set([
  "inspect",
  "create-recovery",
  "fetch",
  "sync",
  "push",
  "ai-sync-and-push",
  "resolve-conflict",
  "commit",
  "discard-selected",
  "restore-tool-stashes",
  "continue-rebase-and-push",
  "abort-rebase",
  "ai-commit",
  "ai-sync",
  "ai-push"
]);
const view = reactive({
  config: null,
  state: null,
  logs: [],
  result: null,
  audit: null,
  details: zh.waiting,
  busy: "",
  connection: zh.connecting,
  connected: false,
  configState: "未保存",
  commits: [],
  graphError: "",
  aiInstallations: [],
  toolVersion: ""
});
let auditRefreshTimer = 0;
let auditRefreshRunning = false;

const appClasses = computed(() => [
  `theme-${themeMode.value}`,
  { "rail-collapsed": railCollapsed.value }
]);
const summary = computed(() => view.result?.summary || null);
const status = computed(() => view.result?.status || null);
const audit = computed(() => view.audit || view.result?.audit || null);
const riskByPath = computed(() => new Map((audit.value?.riskFiles || []).map((risk) => [risk.path, risk])));
const blockers = computed(() => view.state?.blockers || summary.value?.blockers || []);
const displayedBlockers = computed(() => {
  const unmerged = status.value?.unmerged || [];
  const candidateCount = unmerged.filter((path) => conflictCandidates.value[path]?.candidate).length;
  const unmergedCount = unmerged.length;
  return blockers.value.map((blocker) => formatBlocker(blocker, candidateCount, unmergedCount));
});
const recovery = computed(() => view.state?.activeRecovery || null);
const repoName = computed(() => (view.config?.repoPath || "").split(/[\\/]/).filter(Boolean).at(-1) || "未配置仓库");
const installedAi = computed(() => view.aiInstallations || []);
const selectedAi = computed(() => {
  const selected = view.config?.ai?.selected || view.config?.ai?.activeProvider;
  return installedAi.value.find((ai) => ai.id === selected) || null;
});
const sections = computed(() => [
  { id: "staged", name: zh.staged, files: status.value?.staged || [], selectable: true },
  { id: "unstaged", name: zh.unstaged, files: status.value?.unstaged || [], selectable: true },
  { id: "untracked", name: zh.untracked, files: (status.value?.untracked || []).map((path) => ({ status: "??", path })), selectable: true },
  { id: "conflicts", name: zh.conflicts, files: (status.value?.unmerged || []).map((path) => ({ status: "UU", path })), selectable: false }
]);
const files = computed(() => sections.value.flatMap((section) => section.files.map((file) => ({
  ...file,
  group: section.name,
  sectionId: section.id,
  selectable: section.selectable,
  risk: riskByPath.value.get(file.path) || null
}))));
const selectableFiles = computed(() => files.value.filter((file) => file.selectable));
const conflictFiles = computed(() => files.value
  .filter((file) => !file.selectable)
  .map((file) => ({
    ...file,
    candidate: conflictCandidates.value[file.path]?.candidate || "",
    candidateType: conflictCandidates.value[file.path]?.type || ""
  })));
const setupItems = computed(() => [
  { label: "配置仓库", ok: Boolean(view.config?.repoPath), detail: view.config?.repoPath || "未配置" },
  { label: "选择 AI", ok: Boolean(selectedAi.value), detail: selectedAi.value ? `${selectedAi.value.label} 已就绪` : (view.config?.ai?.selected || "未选择") },
  { label: "读取状态", ok: Boolean(summary.value), detail: summary.value ? "已检查" : "等待检查" }
]);

const readiness = computed(() => {
  if (!summary.value) return { label: zh.needsInspect, tone: "warn" };
  if (blockers.value.length) return { label: zh.blocked, tone: "bad" };
  return { label: zh.ready, tone: "ok" };
});
const nextStep = computed(() => {
  if (!view.config?.repoPath) return "先在设置里填写仓库路径。";
  if (!selectedAi.value) return "先在设置里选择一个本机可用的 AI。";
  if (!summary.value) return "先检查仓库，确认分支、上游、工作区、冲突和 diff 检查结果。";
  if (blockers.value.length) return "先处理冲突；未合并文件或冲突标记会阻止提交或推送。";
  if (summary.value.behind && !recovery.value) return "分支落后时先创建恢复点，再同步远端。";
  if (summary.value.behind) return "可以同步远端。同步使用 fetch + rebase，不执行 git pull。";
  if (summary.value.ahead) return "可以推送。若启用了推送确认，需要先勾选确认框。";
  return "选择要提交的文件，或在需要时同步/推送。";
});

onMounted(init);
onBeforeUnmount(stopAuditRefresh);

async function init() {
  try {
    await loadConfigAndState();
    connect(true);
    openEvents();
    await loadGraph();
    if (view.config?.repoPath) await runAction("inspect");
    startAuditRefresh();
  } catch (error) {
    connect(false, error.message);
  }
}

async function loadConfigAndState() {
  const [config, state, aiInstallations, health] = await Promise.all([
    loadConfig(),
    loadState(),
    loadAiInstallations(),
    loadHealth()
  ]);
  view.config = config;
  view.state = state.state;
  view.logs = state.logs || [];
  view.aiInstallations = aiInstallations;
  view.toolVersion = health.version || "";
  view.configState = selectedAi.value ? "已选择" : "未选择";
}

async function loadGraph() {
  try {
    const result = await loadGraphApi();
    view.commits = result.commits || [];
    view.graphError = "";
  } catch (error) {
    view.commits = [];
    view.graphError = error.message;
  }
}

async function refreshRepositoryView({ inspect = false } = {}) {
  const tasks = [loadConfigAndState(), loadGraph()];
  if (inspect && view.config?.repoPath) {
    tasks.push(runActionApi("inspect").then((result) => {
      if (result.status || result.summary) {
        view.result = { status: result.status, summary: result.summary, audit: result.audit };
        view.audit = result.audit || null;
      }
    }));
  }
  await Promise.all(tasks);
  clearStaleOperationNotice();
}

function startAuditRefresh() {
  if (auditRefreshTimer) return;
  auditRefreshTimer = setInterval(refreshAuditNow, AuditRefreshIntervalMs);
  window.addEventListener("visibilitychange", refreshAuditNow);
}

function stopAuditRefresh() {
  if (auditRefreshTimer) {
    clearInterval(auditRefreshTimer);
    auditRefreshTimer = 0;
  }
  window.removeEventListener("visibilitychange", refreshAuditNow);
}

function canRefreshAudit() {
  return Boolean(view.config?.repoPath)
    && activeView.value === "workflow"
    && document.visibilityState !== "hidden";
}

async function refreshAuditNow() {
  if (view.busy) return;
  if (auditRefreshRunning || !canRefreshAudit()) return;
  auditRefreshRunning = true;
  try {
    const result = await refreshAuditApi();
    if (view.busy) return;
    if (result.status || result.summary) {
      view.result = { status: result.status, summary: result.summary, audit: result.audit };
      view.audit = result.audit || null;
    }
    clearStaleOperationNotice();
  } catch (error) {
    log("审计刷新失败", { message: error.message });
  } finally {
    auditRefreshRunning = false;
  }
}

async function runAction(action, payload = {}) {
  view.busy = action;
  if (pushSuccessActions.has(action)) clearOperationNotice();
  log("界面操作", { action: labelAction(action), payload: publicPayload(payload) });
  try {
    const result = await runActionApi(action, payload);
    if (result.status || result.summary) view.result = { status: result.status, summary: result.summary, audit: result.audit };
    if (result.audit) view.audit = result.audit;
    view.details = JSON.stringify(result, null, 2);
    log("操作完成", { action: labelAction(action), message: result.message || "" });
    showOperationNotice(action, result);
    if (repositoryChangingActions.has(action)) {
      await refreshRepositoryView();
      if (action === "commit" || action === "ai-commit") commitResetKey.value += 1;
    }
  } catch (error) {
    view.details = `错误\n${error.message}`;
    const failureAudit = error.data?.audit || null;
    if (failureAudit) view.audit = failureAudit;
    log("操作失败", { action: labelAction(action), message: error.message });
    showOperationFailureNotice(action, error);
    if (repositoryChangingActions.has(action)) {
      try {
        await refreshRepositoryView({ inspect: true });
        if (failureAudit) view.audit = failureAudit;
      } catch (refreshError) {
        log("刷新失败", { action: labelAction(action), message: refreshError.message });
      }
    }
  } finally {
    view.busy = "";
  }
}

function toggleTheme() {
  themeMode.value = themeMode.value === "dark" ? "light" : "dark";
}

function toggleRail() {
  railCollapsed.value = !railCollapsed.value;
}

function setDetails(message) {
  view.details = message;
}

function showOperationNotice(action, result = {}) {
  if (!pushSuccessActions.has(action) || result?.ok === false) return;
  const branch = result.summary?.branch || summary.value?.branch || "";
  const title = action === "continue-rebase-and-push"
    ? "变基已继续并推送成功"
    : action === "restore-tool-stashes"
      ? "stash 已恢复并清理"
    : action === "abort-rebase"
      ? "变基已复位"
    : action === "ai-sync-and-push"
      ? "AI 已同步并推送成功"
      : "推送成功";
  const message = action === "abort-rebase"
    ? "已执行 git rebase --abort，工作区回到 rebase 之前的状态。"
    : action === "restore-tool-stashes"
    ? `已恢复 ${result.restoredToolStashes?.restored?.length || 0} 个工具 stash，并在恢复成功后删除。`
    : action === "ai-sync-and-push" && branch
    ? `分支 ${branch} 已同步远端并推送。`
    : branch
      ? `分支 ${branch} 已经推送到远端。`
      : "远端已经收到当前分支的提交。";
  operationNotice.value = {
    tone: "success",
    title,
    message
  };
}

function showOperationFailureNotice(action, error = {}) {
  if (isRemoteAdvancedPushFailure(error)) {
    operationNotice.value = {
      tone: "warning",
      action: "ai-sync-and-push",
      title: "AI 判断：先同步远端",
      message: "远端已有新提交，本次推送已取消。再次点击推送按钮时，AI 会先同步远端，成功后继续推送；不会 force push。"
    };
    return;
  }
  const notice = explainFailure(action, error);
  if (notice) operationNotice.value = notice;
}

function isRemoteAdvancedPushFailure(error = {}) {
  return error.data?.reason === "remote advanced before push"
    || error.data?.recommendedAction === "ai-sync-and-push"
    || isRemoteAdvancedPushMessage(error.message);
}

function isRemoteAdvancedPushMessage(message = "") {
  return /远端已有新提交|remote advanced before push|fetch first|non-fast-forward|updates were rejected/i.test(message);
}

function explainFailure(action, error = {}) {
  const message = String(error.message || "");
  const auditVerdict = error.data?.audit?.verdict;
  const auditFindings = error.data?.audit?.findings || [];
  if (auditFindings.some((finding) => finding.code === "selected-paths-stale")) {
    return {
      tone: "warning",
      title: "选择已过期",
      message: "选中的文件已经不在当前变更列表中。刷新仓库状态后重新选择要提交的文件。"
    };
  }
  if (/staged files outside selected commit scope/i.test(message) || auditVerdict === "blocked") {
    return {
      tone: "warning",
      title: "提交安全检查已拦截",
      message: "暂存区包含不在本次选择范围内的文件。先检查暂存区，避免把别的改动一起提交。"
    };
  }
  if (/push requires clean worktree/i.test(message)) {
    return {
      tone: "warning",
      title: "不能直接推送",
      message: "当前还有未提交修改。可以使用 AI 同步后推送，工具会临时保存这些修改，推送后再恢复。"
    };
  }
  if (/temporary stash restore failed/i.test(message)) {
    return {
      tone: "warning",
      title: "临时修改恢复失败",
      message: "远端操作已经停止或完成，但本地临时 stash 没有恢复干净。请先处理恢复提示，不要继续提交或推送。"
    };
  }
  if (/tool stash restore failed|tool stash cleanup failed|tool stash ref is unavailable/i.test(message)) {
    return {
      tone: "warning",
      title: "工具 stash 恢复失败",
      message: "工具已经停止，没有删除失败的 stash。先处理工作区冲突或报错，再重新检查。"
    };
  }
  if (/rebase|unmerged|conflict/i.test(message)) {
    return {
      tone: "warning",
      title: "需要先处理冲突",
      message: "当前仓库处在 rebase 或冲突状态。先处理冲突文件，再继续 rebase 或推送。"
    };
  }
  if (action === "commit") {
    return {
      tone: "warning",
      title: "提交失败",
      message: message || "提交没有完成。请检查审计卡和日志里的阻塞原因。"
    };
  }
  return null;
}

function clearOperationNotice() {
  operationNotice.value = null;
}

function clearStaleOperationNotice() {
  if (operationNotice.value?.action !== "ai-sync-and-push") return;
  if (!summary.value) return;
  if (summary.value.ahead || summary.value.behind || summary.value.rebaseInProgress) return;
  clearOperationNotice();
}

function rememberConflictCandidate(payload) {
  if (!payload?.path || !payload?.candidate) return;
  conflictCandidates.value = {
    ...conflictCandidates.value,
    [payload.path]: {
      candidate: payload.candidate,
      type: payload.type || "candidate"
    }
  };
}

function formatBlocker(blocker, candidateCount, unmergedCount) {
  if (blocker === "unmerged files present") {
    return candidateCount
      ? `候选文件只是草稿，还没有应用到原冲突文件（已生成 ${candidateCount}/${unmergedCount}）。确认无误后，点击绿色候选行里的“应用候选并暂存”。`
      : `还有 ${unmergedCount} 个 Git 冲突文件没有处理。`;
  }
  if (blocker === "conflict markers present") {
    return "原文件仍包含冲突标记（<<<<<<< / ======= / >>>>>>>），Git 不能提交。";
  }
  return blocker;
}

async function runCommit(payload) {
  await runAction("commit", payload);
}

async function suggestCommitMessage(paths, done) {
  try {
    const result = await suggestMessageApi({ paths });
    done(result.message || "");
  } catch (error) {
    view.details = `AI 生成提交说明失败: ${error.message}`;
    done("");
  }
}

async function reviewAuditWithAi(payload, done) {
  view.busy = "ai-audit-review";
  try {
    const result = await reviewAuditWithAiApi(payload);
    view.details = result.review || "";
    log("AI 审查完成", { paths: result.paths || [], reviewLength: result.review?.length || 0 });
    done(result);
  } catch (error) {
    view.details = `AI 审查失败: ${error.message}`;
    log("AI 审查失败", { message: error.message });
    done({ ok: false, error: error.message });
  } finally {
    view.busy = "";
  }
}

async function loadTextConflict(payload, done) {
  try {
    done(await loadTextConflictApi(payload));
  } catch (error) {
    view.details = `加载文本冲突失败: ${error.message}`;
    done({ ok: false, error: error.message });
  }
}

async function writeTextCandidate(payload, done) {
  try {
    done(await writeTextCandidateApi(payload));
  } catch (error) {
    view.details = `生成文本候选失败: ${error.message}`;
    done({ ok: false, error: error.message });
  }
}

async function loadTableConflict(payload, done) {
  try {
    done(await loadTableConflictApi(payload));
  } catch (error) {
    view.details = `加载表格冲突失败: ${error.message}`;
    done({ ok: false, error: error.message });
  }
}

async function writeTableCandidate(payload, done) {
  try {
    done(await writeTableCandidateApi(payload));
  } catch (error) {
    view.details = `生成表格候选失败: ${error.message}`;
    done({ ok: false, error: error.message });
  }
}

async function loadBinaryConflict(payload, done) {
  try {
    done(await loadBinaryConflictApi(payload));
  } catch (error) {
    view.details = `加载二进制冲突失败: ${error.message}`;
    done({ ok: false, error: error.message });
  }
}

async function writeBinaryCandidate(payload, done) {
  try {
    done(await writeBinaryCandidateApi(payload));
  } catch (error) {
    view.details = `生成二进制候选失败: ${error.message}`;
    done({ ok: false, error: error.message });
  }
}

async function applyConflictCandidate(payload, done) {
  view.busy = "apply-candidate";
  try {
    const result = await applyConflictCandidateApi(payload);
    view.details = JSON.stringify(result, null, 2);
    log("候选已应用并暂存", { path: payload.path, candidate: payload.candidate });
    done(result);
    await runAction("inspect");
  } catch (error) {
    view.details = `应用候选失败: ${error.message}`;
    done({ ok: false, error: error.message });
  } finally {
    if (view.busy === "apply-candidate") view.busy = "";
  }
}

async function openRepoFile(payload, done) {
  try {
    done(await openRepoFileApi(payload));
  } catch (error) {
    view.details = `打开候选文件失败: ${error.message}`;
    done({ ok: false, error: error.message });
  }
}

async function loadRepoFileDiff(payload, done) {
  try {
    done(await loadRepoFileDiffApi(payload));
  } catch (error) {
    view.details = `读取文件变更失败: ${error.message}`;
    done({ ok: false, error: error.message });
  }
}

async function exportBinaryConflict(payload, done) {
  try {
    done(await exportBinaryConflictApi(payload));
  } catch (error) {
    view.details = `导出二进制冲突失败: ${error.message}`;
    done({ ok: false, error: error.message });
  }
}

async function saveSettings(payload) {
  view.configState = "正在保存";
  try {
    const result = await saveSettingsApi(payload);
    view.config = result.config;
    view.state = result.state || view.state;
    view.configState = selectedAi.value ? "已选择" : "未选择";
    await loadGraph();
  } catch (error) {
    view.configState = error.message;
  }
}

async function switchRepo(payload) {
  await saveSettings(payload);
  if (view.config?.repoPath) await runAction("inspect");
}

async function chooseRepoFolder(done) {
  view.configState = "正在选择文件夹";
  try {
    const result = await chooseRepoFolderApi();
    if (result.cancelled) {
      view.configState = "已取消选择";
      done?.("");
      return;
    }
    done?.(result.path || "");
    view.configState = result.path ? "已选择，正在保存" : "已取消选择";
  } catch (error) {
    view.configState = error.message;
    done?.("");
  }
}

function openEvents() {
  openEventStream({
    onOpen: () => connect(true),
    onError: (message) => connect(false, message),
    onState: (data) => {
      view.state = data.state || view.state;
      if (Array.isArray(data.logs)) view.logs = data.logs;
    },
    onLog: (data, name = "log") => log(name, data),
    onPhase: (data) => {
      view.state = { ...(view.state || {}), phase: data.phase, note: data.note };
      log("phase", data);
    }
  });
}

function connect(ok, note = "") {
  view.connected = ok;
  view.connection = ok ? zh.connected : `连接断开${note ? `：${note}` : ""}`;
}

function log(event, data) {
  view.logs.push({ time: new Date().toISOString(), event, data });
}

function labelAction(action) {
  return ({
    inspect: zh.inspectRepo,
    "create-recovery": zh.createRecovery,
    fetch: zh.fetchRemote,
    sync: zh.aiSync,
    "resolve-conflict": zh.conflictFiles,
    commit: zh.aiCommit,
    "discard-selected": "丢弃选中",
    "restore-tool-stashes": "恢复并清理 stash",
    push: zh.aiPush,
    "ai-commit": zh.aiCommit,
    "ai-sync": zh.aiSync,
    "ai-push": zh.aiPush,
    "ai-sync-and-push": "AI 同步后推送",
    "continue-rebase-and-push": "继续变基并推送",
    "abort-rebase": "复位 rebase"
  })[action] || action;
}

function publicPayload(payload) {
  return { ...payload, message: payload.message ? "[commit message]" : undefined };
}
</script>

<template>
  <div class="app-shell" :class="appClasses">
    <Rail
      :labels="zh"
      :active-view="activeView"
      :connected="view.connected"
      :connection="view.connection"
      :repo-name="repoName"
      :repo-path="view.config?.repoPath || ''"
      :setup-items="setupItems"
      :theme-mode="themeMode"
      :rail-collapsed="railCollapsed"
      :tool-version="view.toolVersion"
      @select-view="activeView = $event"
      @toggle-theme="toggleTheme"
      @toggle-rail="toggleRail"
    />

    <main class="workspace" :class="{ 'settings-workspace': activeView !== 'graph' }">
      <section v-show="activeView === 'workflow'" class="view-pane">
        <WorkflowView
          :labels="zh"
          :summary="summary"
          :status="status"
          :audit="audit"
          :sections="sections"
          :files="files"
          :selectable-files="selectableFiles"
          :conflict-files="conflictFiles"
          :selected-ai="selectedAi"
          :config="view.config"
          :blockers="displayedBlockers"
          :recovery="recovery"
          :logs="view.logs"
          :details="view.details"
          :busy="view.busy"
          :commit-reset-key="commitResetKey"
          :operation-notice="operationNotice"
          :readiness="readiness"
          :next-step="nextStep"
          :theme-mode="themeMode"
          @action="runAction"
          @clear-operation-notice="clearOperationNotice"
          @commit="runCommit"
          @load-text-conflict="loadTextConflict"
          @write-text-candidate="writeTextCandidate"
          @load-table-conflict="loadTableConflict"
          @write-table-candidate="writeTableCandidate"
          @load-binary-conflict="loadBinaryConflict"
          @write-binary-candidate="writeBinaryCandidate"
          @apply-candidate="applyConflictCandidate"
          @open-repo-file="openRepoFile"
          @load-file-diff="loadRepoFileDiff"
          @export-binary-conflict="exportBinaryConflict"
          @candidate-created="rememberConflictCandidate"
          @suggest-message="suggestCommitMessage"
          @review-audit="reviewAuditWithAi"
          @blocked="setDetails"
        />
      </section>

      <section v-show="activeView === 'graph'" class="view-pane">
        <GitGraphView
          :commits="view.commits"
          :repo-name="repoName"
          :branch="summary?.branch || 'main'"
          :graph-error="view.graphError"
          :labels="zh"
          @refresh="loadGraph"
        />
      </section>

      <section v-show="activeView === 'settings'" class="view-pane">
        <SettingsView
          :labels="zh"
          :config="view.config"
          :config-state="view.configState"
          :installed-ai="installedAi"
          @reload="loadConfigAndState"
          @save="saveSettings"
          @choose-repo-folder="chooseRepoFolder"
          @switch-repo="switchRepo"
        />
      </section>

      <section v-show="activeView === 'logs'" class="view-pane">
        <LogsView
          :labels="zh"
          :logs="view.logs"
          :details="view.details"
        />
      </section>
    </main>
  </div>
</template>
