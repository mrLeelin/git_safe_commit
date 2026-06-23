<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  buildSettingsPayload,
  createDefaultSettingsForm,
  fillSettingsFormFromConfig
} from "./settings-model.js";

const zh = {
  title: "Git 安全提交",
  desc: "面向脏工作区的本地提交与推送控制台。只提交你确认过的路径。",
  connected: "本地服务已连接",
  connecting: "正在连接",
  noRepoPath: "尚未配置仓库路径",
  workflow: "提交工作流",
  inspectRepo: "检查仓库",
  createRecovery: "创建恢复点",
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
const activeSettingsTab = ref("general");
const themeMode = ref("dark");
const railCollapsed = ref(false);
const selectedPaths = ref([]);
const commitMessage = ref("");
const pushConfirmed = ref(false);
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
const form = reactive(createDefaultSettingsForm());

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
const selectedAi = computed(() => installedAi.value.find((ai) => ai.id === form.selectedAi) || null);
const settingsTabs = [
  { id: "general", label: "通用设置" },
  { id: "repo", label: "仓库路径" },
  { id: "ai", label: "AI 服务" },
  { id: "safety", label: "安全确认" },
  { id: "local", label: "本地配置" }
];
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
const selectedFileCount = computed(() => selectedPaths.value.length);
const selectedFilesLabel = computed(() => `${selectedFileCount.value} / ${selectableFiles.value.length}`);
const changedCount = computed(() => files.value.length);
const canCommit = computed(() => !commitBlockReason.value && !view.busy);
const canPush = computed(() => !pushBlockReason.value && !view.busy);
const setupItems = computed(() => [
  { label: "配置仓库", ok: Boolean(view.config?.repoPath), detail: view.config?.repoPath || "未配置" },
  { label: "选择 AI", ok: Boolean(selectedAi.value), detail: selectedAi.value ? `${selectedAi.value.label} 已就绪` : (view.config?.ai?.selected || "未选择") },
  { label: "读取状态", ok: Boolean(summary.value), detail: summary.value ? "已检查" : "等待检查" }
]);

const syncText = computed(() => {
  const s = summary.value;
  if (!s) return "未知";
  if (s.ahead && s.behind) return `领先 ${s.ahead} / 落后 ${s.behind}`;
  if (s.ahead) return `领先 ${s.ahead}`;
  if (s.behind) return `落后 ${s.behind}`;
  return "已同步";
});
const readiness = computed(() => {
  if (!summary.value) return { label: zh.needsInspect, tone: "warn" };
  if (blockers.value.length) return { label: zh.blocked, tone: "bad" };
  return { label: zh.ready, tone: "ok" };
});
const commitBlockReason = computed(() => {
  if (!view.config?.repoPath) return "缺少仓库路径";
  if (!selectedAi.value) return "未选择可用 AI";
  if (!summary.value) return "先检查仓库";
  if (blockers.value.length) return "存在阻断项";
  if (!selectedPaths.value.length) return "先选择文件";
  if (!commitMessage.value.trim()) return "先填写提交说明";
  return "";
});
const pushBlockReason = computed(() => {
  if (!view.config?.repoPath) return "缺少仓库路径";
  if (!selectedAi.value) return "未选择可用 AI";
  if (!summary.value) return "先检查仓库";
  if (blockers.value.length) return "存在阻断项";
  if (form.requireConfirmBeforePush && !pushConfirmed.value) return "需要推送确认";
  return "";
});
const nextStep = computed(() => {
  if (!view.config?.repoPath) return "先在设置里填写仓库路径。";
  if (!selectedAi.value) return "先在设置里选择一个本机可用的 AI。";
  if (!summary.value) return "先检查仓库，确认分支、上游、工作区、冲突和 diff 检查结果。";
  if (blockers.value.length) return "先处理阻断项；冲突、diff 检查失败或缺少上游时不会提交或推送。";
  if (selectedPaths.value.length && !commitMessage.value.trim()) return "已选中文件，补一条提交说明后就能提交。";
  if (selectedPaths.value.length) return "可以提交选中文件。工具只会 stage 这些路径，不会扫入其他改动。";
  if (summary.value.behind && !recovery.value) return "分支落后时先创建恢复点，再同步远端。";
  if (summary.value.behind) return "可以同步远端。同步使用 fetch + rebase，不执行 git pull。";
  if (summary.value.ahead) return "可以推送。若启用了推送确认，需要先勾选确认框。";
  return "选择要提交的文件，或在需要时同步/推送。";
});

watch(selectableFiles, (nextFiles) => {
  const allowed = new Set(nextFiles.map((file) => file.path));
  selectedPaths.value = selectedPaths.value.filter((path) => allowed.has(path));
}, { immediate: true });

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
    api("/api/config"),
    api("/api/state"),
    api("/api/ai/installations")
  ]);
  view.config = config.config;
  view.state = state.state;
  view.logs = state.logs || [];
  view.aiInstallations = aiInstallations.installations || [];
  fillForm(view.config);
}

async function loadGraph() {
  try {
    const result = await api("/api/git/graph");
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
    const result = await api(`/api/action/${action}`, { method: "POST", body: JSON.stringify(payload) });
    if (result.status || result.summary) view.result = { status: result.status, summary: result.summary };
    view.details = JSON.stringify(result, null, 2);
    log("操作完成", { action: labelAction(action) });
    if (action === "inspect" || action === "create-recovery" || action.startsWith("ai-")) {
      await Promise.all([loadConfigAndState(), loadGraph()]);
      if (action === "ai-commit") {
        commitMessage.value = "";
        selectedPaths.value = [];
      }
    }
  } catch (error) {
    view.details = `错误\n${error.message}`;
    log("操作失败", { action: labelAction(action), message: error.message });
  } finally {
    view.busy = "";
  }
}

function runCommit() {
  if (commitBlockReason.value) {
    view.details = commitBlockReason.value;
    return;
  }
  runAction("ai-commit", { paths: selectedPaths.value, message: commitMessage.value.trim() });
}

function runPush() {
  if (pushBlockReason.value) {
    view.details = pushBlockReason.value;
    return;
  }
  runAction("ai-push", { confirmed: pushConfirmed.value });
}

function togglePath(path) {
  selectedPaths.value = selectedPaths.value.includes(path)
    ? selectedPaths.value.filter((item) => item !== path)
    : [...selectedPaths.value, path];
}

function selectAll() {
  selectedPaths.value = selectableFiles.value.map((file) => file.path);
}

function selectSection(sectionId) {
  const picked = files.value.filter((file) => file.selectable && file.sectionId === sectionId).map((file) => file.path);
  selectedPaths.value = [...new Set([...selectedPaths.value, ...picked])];
}

function clearSelection() {
  selectedPaths.value = [];
}

function toggleTheme() {
  themeMode.value = themeMode.value === "dark" ? "light" : "dark";
}

function toggleRail() {
  railCollapsed.value = !railCollapsed.value;
}

async function saveSettings() {
  view.configState = "正在保存";
  try {
    const result = await api("/api/config", { method: "POST", body: JSON.stringify({ config: settingsPayload() }) });
    view.config = result.config;
    view.state = result.state || view.state;
    fillForm(view.config);
    view.configState = "已保存";
    await loadGraph();
  } catch (error) {
    view.configState = error.message;
  }
}

function settingsPayload() {
  return buildSettingsPayload(form);
}

function fillForm(config) {
  fillSettingsFormFromConfig(form, config);
  view.configState = selectedAi.value ? "已选择" : "未选择";
}

function openEvents() {
  const events = new EventSource("/api/events");
  events.onopen = () => connect(true);
  events.onerror = () => connect(false, "事件流断开，浏览器会自动重连");
  events.addEventListener("state", (event) => {
    const data = JSON.parse(event.data);
    view.state = data.state || view.state;
    if (Array.isArray(data.logs)) view.logs = data.logs;
  });
  for (const name of ["phase", "ai-action", "ai-result"]) {
    events.addEventListener(name, (event) => {
      const data = JSON.parse(event.data);
      if (name === "phase") view.state = { ...(view.state || {}), phase: data.phase, note: data.note };
      log(name, data);
    });
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
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
    <aside class="rail">
      <div class="brand-block">
        <div class="brand">G</div>
        <div>
          <h1>{{ zh.title }}</h1>
          <p class="muted">{{ zh.desc }}</p>
        </div>
      </div>

      <div class="connection-card">
        <span class="pill"><span class="dot" :class="{ ok: view.connected }"></span>{{ view.connection }}</span>
        <strong>{{ repoName }}</strong>
        <code>{{ view.config?.repoPath || zh.noRepoPath }}</code>
      </div>

      <div class="setup-card">
        <h2>启动检查</h2>
        <div v-for="item in setupItems" :key="item.label" class="setup-row" :class="{ ok: item.ok }">
          <span class="setup-dot"></span>
          <strong>{{ item.label }}</strong>
          <small>{{ item.detail }}</small>
        </div>
      </div>

      <div class="rail-tools">
        <button class="rail-tool" type="button" @click="toggleTheme">
          <span class="rail-tool-icon">{{ themeMode === 'dark' ? 'S' : 'D' }}</span>
          <strong>{{ themeMode === 'dark' ? '浅色模式' : '暗色模式' }}</strong>
        </button>
        <button class="rail-tool" type="button" @click="toggleRail">
          <span class="rail-tool-icon">{{ railCollapsed ? '>>' : '<<' }}</span>
          <strong>{{ railCollapsed ? '展开' : '收起' }}</strong>
        </button>
      </div>

      <nav class="main-nav" aria-label="primary">
        <button type="button" :class="{ active: activeView === 'workflow' }" @click="activeView = 'workflow'">
          <span>1</span><strong>提交工作流</strong>
        </button>
        <button type="button" :class="{ active: activeView === 'graph' }" @click="activeView = 'graph'">
          <span>2</span><strong>git 树</strong>
        </button>
        <button type="button" :class="{ active: activeView === 'settings' }" @click="activeView = 'settings'">
          <span>3</span><strong>设置</strong>
        </button>
      </nav>
    </aside>

    <main class="workspace" :class="{ 'settings-workspace': activeView === 'settings' || activeView === 'graph' }">
      <header class="topbar" :class="{ 'settings-topbar': activeView === 'settings' || activeView === 'graph' }">
        <div>
          <p class="eyebrow">{{ activeView === 'workflow' ? zh.workflow : activeView === 'graph' ? 'git 树' : '系统设置' }}</p>
          <h2>{{ activeView === 'workflow' ? '检查、选择、提交、推送' : activeView === 'graph' ? '查看提交历史与分支位置' : '管理仓库、AI 与提交策略' }}</h2>
        </div>
        <div v-if="activeView === 'workflow'" class="command-bar">
          <button class="mini-command" type="button" :disabled="Boolean(view.busy)" @click="runAction('inspect')">{{ zh.inspectRepo }}</button>
          <button class="mini-command" type="button" :disabled="!canCommit" @click="runCommit">{{ zh.aiCommit }}</button>
          <button class="mini-command danger" type="button" :disabled="!canPush" @click="runPush">{{ zh.aiPush }}</button>
        </div>
      </header>

      <section v-if="activeView === 'workflow'" class="status-metrics">
        <div class="metric" :class="readiness.tone"><span>{{ zh.safety }}</span><strong>{{ readiness.label }}</strong></div>
        <div class="metric"><span>{{ zh.branch }}</span><strong>{{ summary?.branch || "-" }}</strong></div>
        <div class="metric"><span>{{ zh.ahead }} / {{ zh.behind }}</span><strong>{{ summary ? `${summary.ahead} / ${summary.behind}` : "-" }}</strong></div>
        <div class="metric"><span>{{ zh.worktree }}</span><strong>{{ summary ? (summary.cleanWorktree ? zh.clean : zh.dirty) : zh.unchecked }}</strong></div>
      </section>

      <section v-if="activeView === 'workflow'" class="primary-grid">
        <article class="commit-card">
          <div class="panel-head">
            <div>
              <h3>{{ zh.commitQueue }}</h3>
              <p class="muted">只提交勾选的路径；未勾选的本地改动会保留在工作区。</p>
            </div>
            <span class="counter">{{ selectedFilesLabel }}</span>
          </div>

          <div class="commit-message">
            <label>
              <span>{{ zh.commitMessage }}</span>
              <textarea v-model="commitMessage" :placeholder="zh.commitMessagePlaceholder" rows="3"></textarea>
            </label>
          </div>

          <div class="file-actions">
            <button class="text-button" type="button" @click="selectAll">全选可提交</button>
            <button class="text-button" type="button" @click="selectSection('staged')">只选已暂存</button>
            <button class="text-button" type="button" @click="selectSection('unstaged')">只选未暂存</button>
            <button class="text-button" type="button" @click="clearSelection">清空选择</button>
            <button class="text-button" type="button" @click="runAction('inspect')">{{ zh.refresh }}</button>
          </div>

          <div class="queue-list">
            <button
              v-for="file in selectableFiles"
              :key="`${file.group}:${file.path}`"
              class="queue-row"
              :class="{ selected: selectedPaths.includes(file.path) }"
              type="button"
              @click="togglePath(file.path)"
            >
              <span class="checkmark" aria-hidden="true"></span>
              <span class="file-meta"><strong>{{ file.path }}</strong><small>{{ file.group }} · {{ file.status }}</small></span>
            </button>
            <div v-if="!selectableFiles.length" class="empty-state">{{ zh.fileHint }}</div>
          </div>

          <div v-if="conflictFiles.length" class="conflict-box">
            <strong>{{ zh.conflictFiles }}</strong>
            <code v-for="file in conflictFiles" :key="file.path">{{ file.path }}</code>
          </div>

          <div class="commit-actions">
            <button class="btn" type="button" :disabled="!canCommit" @click="runCommit">{{ zh.aiCommit }}</button>
            <span class="disabled-reason">{{ commitBlockReason || "将按选中路径提交" }}</span>
          </div>
        </article>

        <aside class="action-card">
          <h3>{{ zh.next }}</h3>
          <p class="next-copy">{{ nextStep }}</p>
          <div class="action-stack">
            <button class="btn secondary" type="button" :disabled="Boolean(view.busy)" @click="runAction('create-recovery')">{{ zh.createRecovery }}</button>
            <button class="btn secondary" type="button" :disabled="Boolean(view.busy)" @click="runAction('ai-sync')">{{ zh.aiSync }}</button>
            <label class="push-confirm"><input v-model="pushConfirmed" type="checkbox">{{ zh.pushConfirm }}</label>
            <button class="btn danger" type="button" :disabled="!canPush" @click="runPush">{{ zh.aiPush }}</button>
            <span class="disabled-reason">{{ pushBlockReason || "推送门禁已满足" }}</span>
          </div>
          <div class="safety-box" :class="{ bad: blockers.length }">
            <strong>{{ zh.blockers }}</strong>
            <pre>{{ blockers.length ? blockers.join("\n") : zh.noBlockers }}</pre>
          </div>
          <div class="safety-box warn">
            <strong>{{ zh.recoveryPoint }}</strong>
            <pre>{{ recovery ? JSON.stringify(recovery, null, 2) : zh.noRecovery }}</pre>
          </div>
        </aside>
      </section>

      <section v-if="activeView === 'workflow'" class="panel">
        <div class="panel-head compact-head"><h3>{{ zh.status }}</h3><span class="muted">{{ changedCount }} 个改动项</span></div>
        <div class="status-strip">
          <div v-for="section in sections" :key="section.name" class="status-card"><span>{{ section.name }}</span><strong>{{ section.files.length }}</strong></div>
        </div>
        <div class="file-table">
          <div class="table-head"><span>{{ zh.group }}</span><span>{{ zh.status }}</span><span>{{ zh.path }}</span></div>
          <div v-if="files.length">
            <div v-for="file in files" :key="`${file.group}:${file.status}:${file.path}`" class="file-row">
              <span>{{ file.group }}</span><span>{{ file.status }}</span><code>{{ file.path }}</code>
            </div>
          </div>
          <div v-else class="empty-state">{{ zh.fileHint }}</div>
        </div>
      </section>

      <section v-if="activeView === 'graph'" class="graph-page">
        <div class="graph-toolbar">
          <div>
            <h3>{{ zh.graph }}</h3>
            <p>按当前仓库提交历史查看分支、HEAD 和最近提交位置。</p>
          </div>
          <button class="btn secondary" type="button" @click="loadGraph">{{ zh.refresh }}</button>
        </div>

        <div class="git-graph-list">
          <div class="graph-titlebar">
            <span></span>
            <strong>{{ repoName }}</strong>
            <button class="graph-refresh" type="button" @click="loadGraph">{{ zh.refresh }}</button>
          </div>
          <div class="graph-branchbar">
            <span class="graph-menu">=</span>
            <span class="branch-name">{{ summary?.branch || "main" }}</span>
          </div>
          <div class="graph-body">
            <div class="graph-sidebar"><span>*</span></div>
            <div v-if="view.commits.length" class="commit-list">
              <div v-for="commit in view.commits" :key="commit.hash" class="commit-row" :class="{ head: commit.isHead }">
                <div class="commit-lanes">
                  <span class="mainline"></span>
                  <span class="node"></span>
                </div>
                <div class="commit-main">
                  <div class="commit-title">
                    <span v-for="ref in commit.refs" :key="ref" class="branch" :class="{ current: commit.isHead && ref === commit.refs[0] }">{{ ref }}</span>
                    <span class="subject">{{ commit.subject }}</span>
                  </div>
                </div>
                <div class="commit-author"><span class="avatar">GT</span>{{ commit.author }}</div>
                <code class="commit-hash">{{ commit.shortHash }}</code>
                <div class="commit-date">{{ commit.date }}</div>
              </div>
            </div>
            <div v-else class="empty-state">{{ view.graphError || zh.noGraph }}</div>
          </div>
        </div>
      </section>

      <section v-if="activeView === 'workflow'" class="panel">
        <h3>{{ zh.eventLog }}</h3>
        <ol class="logs">
          <li v-for="entry in view.logs" :key="entry.time + entry.event">
            <time>{{ new Date(entry.time).toLocaleTimeString() }}</time>
            <code>{{ entry.event }}: {{ JSON.stringify(entry.data) }}</code>
          </li>
        </ol>
      </section>

      <section v-if="activeView === 'settings'" class="settings-page">
        <nav class="settings-tabs" aria-label="settings sections">
          <button
            v-for="tab in settingsTabs"
            :key="tab.id"
            type="button"
            :class="{ active: activeSettingsTab === tab.id }"
            @click="activeSettingsTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </nav>

        <form class="settings-card" @submit.prevent="saveSettings">
          <div class="settings-card-head">
            <div>
              <h3>{{ settingsTabs.find((tab) => tab.id === activeSettingsTab)?.label || "通用设置" }}</h3>
              <p>管理本地提交工具的仓库、AI 与提交工作流。</p>
            </div>
            <span class="status-label">{{ view.configState }}</span>
          </div>

          <div class="settings-card-body">
            <label v-if="activeSettingsTab === 'general' || activeSettingsTab === 'safety'" class="setting-alert wide">
              <span>
                <strong>推送确认门禁</strong>
                <small>开启后，推送到远端前必须在浏览器内确认。</small>
              </span>
              <input v-model="form.requireConfirmBeforePush" type="checkbox">
            </label>

            <label v-if="activeSettingsTab === 'general' || activeSettingsTab === 'repo'" class="wide"><span>{{ zh.repoPath }}</span><input v-model="form.repoPath" autocomplete="off"></label>

            <div v-if="activeSettingsTab === 'general' || activeSettingsTab === 'ai'" class="settings-section wide">
              <strong>AI 服务设置</strong>
              <small>从本机已安装的 AI 中选择提交工作流使用的工具，不需要填写地址、模型或 Key。</small>
            </div>
            <div v-if="activeSettingsTab === 'general' || activeSettingsTab === 'ai'" class="ai-picker wide">
              <button
                v-for="ai in installedAi"
                :key="ai.id"
                type="button"
                class="ai-option"
                :class="{ selected: form.selectedAi === ai.id }"
                @click="form.selectedAi = ai.id"
              >
                <span class="ai-mark">{{ ai.label.slice(0, 1) }}</span>
                <span class="ai-copy">
                  <strong>{{ ai.label }}</strong>
                  <small>{{ ai.source }}</small>
                </span>
                <span class="ai-state">{{ form.selectedAi === ai.id ? '使用中' : '可用' }}</span>
              </button>
              <div v-if="!installedAi.length" class="empty-state wide">没有检测到可用 AI。请先安装 Codex、Claude 或 Gemini CLI。</div>
            </div>

            <div v-if="activeSettingsTab === 'general' || activeSettingsTab === 'local'" class="settings-section wide">
              <strong>本地配置文件</strong>
              <small>{{ zh.saveLocal }}</small>
            </div>
          </div>

          <div class="settings-actions">
            <button class="btn secondary" type="button" @click="loadConfigAndState">{{ zh.reload }}</button>
            <button class="btn" type="submit">{{ zh.saveSettings }}</button>
          </div>
        </form>
      </section>

      <section v-if="activeView === 'workflow'" class="panel output-panel">
        <h3>{{ zh.output }}</h3>
        <pre class="output">{{ view.details }}</pre>
      </section>
    </main>
  </div>
</template>
