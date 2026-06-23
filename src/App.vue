<script setup>
import { computed, onMounted, reactive, ref } from "vue";
import {
  loadAiInstallations,
  loadConfig,
  loadGraph as loadGraphApi,
  loadState,
  openEvents as openEventStream,
  runAction as runActionApi,
  saveSettings as saveSettingsApi,
  suggestMessage as suggestMessageApi
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
  aiPush: "推送到远端",
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
  safety: "安全状态",
  blockers: "阻断项",
  noBlockers: "当前没有阻断项。",
  next: "下一步",
  recoveryPoint: "恢复点",
  noRecovery: "本轮还没有恢复点。",
  pushConfirm: "我确认这次推送只包含当前分支上已经完成的提交",
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
const view = reactive({
  config: null,
  state: null,
  logs: [],
  result: null,
  details: zh.waiting,
  busy: "",
  connection: zh.connecting,
  connected: false,
  configState: "未保存",
  commits: [],
  graphError: "",
  aiInstallations: []
});

const appClasses = computed(() => [
  `theme-${themeMode.value}`,
  { "rail-collapsed": railCollapsed.value }
]);
const summary = computed(() => view.result?.summary || null);
const status = computed(() => view.result?.status || null);
const blockers = computed(() => view.state?.blockers || summary.value?.blockers || []);
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
  selectable: section.selectable
}))));
const selectableFiles = computed(() => files.value.filter((file) => file.selectable));
const conflictFiles = computed(() => files.value.filter((file) => !file.selectable));
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
  if (blockers.value.length) return "先处理阻断项；冲突、diff 检查失败或缺少上游时不会提交或推送。";
  if (summary.value.behind && !recovery.value) return "分支落后时先创建恢复点，再同步远端。";
  if (summary.value.behind) return "可以同步远端。同步使用 fetch + rebase，不执行 git pull。";
  if (summary.value.ahead) return "可以推送。若启用了推送确认，需要先勾选确认框。";
  return "选择要提交的文件，或在需要时同步/推送。";
});

onMounted(init);

async function init() {
  try {
    await loadConfigAndState();
    connect(true);
    openEvents();
    await loadGraph();
    if (view.config?.repoPath) await runAction("inspect");
  } catch (error) {
    connect(false, error.message);
  }
}

async function loadConfigAndState() {
  const [config, state, aiInstallations] = await Promise.all([
    loadConfig(),
    loadState(),
    loadAiInstallations()
  ]);
  view.config = config;
  view.state = state.state;
  view.logs = state.logs || [];
  view.aiInstallations = aiInstallations;
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

async function runAction(action, payload = {}) {
  view.busy = action;
  log("界面操作", { action: labelAction(action), payload: publicPayload(payload) });
  try {
    const result = await runActionApi(action, payload);
    if (result.status || result.summary) view.result = { status: result.status, summary: result.summary };
    view.details = JSON.stringify(result, null, 2);
    log("操作完成", { action: labelAction(action) });
    if (action === "inspect" || action === "create-recovery" || action === "fetch" || action === "commit" || action.startsWith("ai-")) {
      await Promise.all([loadConfigAndState(), loadGraph()]);
      if (action === "commit" || action === "ai-commit") commitResetKey.value += 1;
    }
  } catch (error) {
    view.details = `错误\n${error.message}`;
    log("操作失败", { action: labelAction(action), message: error.message });
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

async function runCommit(payload) {
  await runAction("commit", payload);
}

async function runPush(payload) {
  await runAction("ai-push", payload);
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
    commit: zh.aiCommit,
    "ai-commit": zh.aiCommit,
    "ai-sync": zh.aiSync,
    "ai-push": zh.aiPush
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
          :sections="sections"
          :files="files"
          :selectable-files="selectableFiles"
          :conflict-files="conflictFiles"
          :selected-ai="selectedAi"
          :config="view.config"
          :blockers="blockers"
          :recovery="recovery"
          :logs="view.logs"
          :details="view.details"
          :busy="view.busy"
          :commit-reset-key="commitResetKey"
          :readiness="readiness"
          :next-step="nextStep"
          :require-confirm-before-push="view.config?.workflow?.requireConfirmBeforePush ?? true"
          @action="runAction"
          @commit="runCommit"
          @push="runPush"
          @suggest-message="suggestCommitMessage"
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
