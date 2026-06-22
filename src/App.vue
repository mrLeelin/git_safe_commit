<script setup>
import { computed, onMounted, reactive, ref } from "vue";

const activePanel = ref("overview");
const view = reactive({
  config: null,
  state: null,
  logs: [],
  result: null,
  details: "等待检查仓库状态。",
  busy: "",
  connection: "正在连接",
  connected: false,
  configState: "未保存",
  commits: [],
  graphError: ""
});
const form = reactive({
  repoPath: "",
  baseUrl: "",
  model: "",
  apiKey: "",
  temperature: 0.1,
  requireConfirmBeforePush: true
});

const summary = computed(() => view.result?.summary || null);
const status = computed(() => view.result?.status || null);
const blockers = computed(() => view.state?.blockers || summary.value?.blockers || []);
const recovery = computed(() => view.state?.activeRecovery || null);
const repoName = computed(() => (view.config?.repoPath || "").split(/[\\/]/).filter(Boolean).at(-1) || "未配置仓库");
const changedCount = computed(() => {
  const s = summary.value;
  return s ? (s.stagedCount || 0) + (s.unstagedCount || 0) + (s.untrackedCount || 0) + (s.unmergedCount || 0) : 0;
});
const syncText = computed(() => {
  const s = summary.value;
  if (!s) return "未知";
  if (s.ahead && s.behind) return `领先 ${s.ahead} / 落后 ${s.behind}`;
  if (s.ahead) return `领先 ${s.ahead}`;
  if (s.behind) return `落后 ${s.behind}`;
  return "已同步";
});
const nextStep = computed(() => {
  if (!view.config?.repoPath) return "先在设置中填写仓库路径。";
  if (!summary.value) return "点击“检查仓库”，读取分支、上游、工作区、冲突和 diff 检查结果。";
  if (blockers.value.length) return "先处理阻断项，再执行 AI 同步或 AI 推送。";
  if (!recovery.value) return "创建恢复点，再执行可能包含 rebase 的同步动作。";
  if (summary.value.behind) return "可以执行 AI 同步。工具会使用白名单 Git 命令，不会执行 git pull。";
  if (summary.value.ahead) return "可以执行 AI 推送。推送前仍会经过安全检查和浏览器确认。";
  return "仓库当前可用。每次远端操作前建议重新检查。";
});
const sections = computed(() => [
  { name: "已暂存", files: status.value?.staged || [] },
  { name: "未暂存", files: status.value?.unstaged || [] },
  { name: "未跟踪", files: (status.value?.untracked || []).map((path) => ({ status: "??", path })) },
  { name: "冲突", files: (status.value?.unmerged || []).map((path) => ({ status: "UU", path })) }
]);
const files = computed(() => sections.value.flatMap((section) => section.files.map((file) => ({ ...file, group: section.name }))));
const panels = [
  ["overview", "总览"],
  ["status", "Git 状态"],
  ["recovery", "恢复点"],
  ["blockers", "阻断项"],
  ["logs", "日志"],
  ["settings", "设置"]
];

onMounted(async () => {
  await init();
});

async function init() {
  try {
    await loadConfigAndState();
    connect(true);
    openEvents();
    await loadGraph();
  } catch (error) {
    connect(false, error.message);
  }
}

async function loadConfigAndState() {
  const [config, state] = await Promise.all([api("/api/config"), api("/api/state")]);
  view.config = config.config;
  view.state = state.state;
  view.logs = state.logs || [];
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

async function runAction(action) {
  view.busy = action;
  log("界面操作", { action: labelAction(action) });
  try {
    const result = await api(`/api/action/${action}`, { method: "POST", body: "{}" });
    if (result.status || result.summary) view.result = { status: result.status, summary: result.summary };
    view.details = JSON.stringify(result, null, 2);
    log("操作完成", { action: labelAction(action) });
    if (action === "inspect" || action === "create-recovery") await loadGraph();
  } catch (error) {
    view.details = `错误\n${error.message}`;
    log("操作失败", { action: labelAction(action), message: error.message });
  } finally {
    view.busy = "";
  }
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
  const payload = {
    repoPath: form.repoPath.trim(),
    ai: { baseUrl: form.baseUrl.trim(), model: form.model.trim(), temperature: Number(form.temperature || 0.1) },
    workflow: { requireConfirmBeforePush: form.requireConfirmBeforePush }
  };
  if (form.apiKey.trim()) payload.ai.apiKey = form.apiKey.trim();
  return payload;
}

function fillForm(config) {
  form.repoPath = config.repoPath || "";
  form.baseUrl = config.ai?.baseUrl || "";
  form.model = config.ai?.model || "";
  form.apiKey = "";
  form.temperature = config.ai?.temperature ?? 0.1;
  form.requireConfirmBeforePush = Boolean(config.workflow?.requireConfirmBeforePush);
  view.configState = config.ai?.apiKey ? "Key 已保存" : "缺少 Key";
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
  view.connection = ok ? "本地服务已连接" : `连接断开${note ? `：${note}` : ""}`;
}
function log(event, data) {
  view.logs.push({ time: new Date().toISOString(), event, data });
}
function labelAction(action) {
  return ({ inspect: "检查仓库", "create-recovery": "创建恢复点", "ai-sync": "AI 同步", "ai-push": "AI 推送" })[action] || action;
}
</script>

<template>
  <div class="layout">
    <aside class="side">
      <div class="brand">G</div>
      <h1>Git 安全提交</h1>
      <p class="muted">本地 Git 安全工作台。AI 负责判断和操作建议，Node 安全层只执行白名单 Git 命令。</p>
      <div class="side-card">
        <span class="pill"><span class="dot" :class="{ ok: view.connected }"></span>{{ view.connection }}</span>
        <span class="repo-path">{{ view.config?.repoPath || "尚未配置仓库路径" }}</span>
      </div>
      <div class="side-section">
        <h3>快捷操作</h3>
        <button class="side-action primary" type="button" :disabled="Boolean(view.busy)" @click="runAction('inspect')">检查仓库</button>
        <button class="side-action" type="button" :disabled="Boolean(view.busy)" @click="runAction('create-recovery')">创建恢复点</button>
        <button class="side-action" type="button" :disabled="Boolean(view.busy)" @click="runAction('ai-sync')">AI 同步</button>
        <button class="side-action" type="button" :disabled="Boolean(view.busy)" @click="runAction('ai-push')">AI 推送</button>
      </div>
      <div class="side-section">
        <h3>面板</h3>
        <button v-for="[id, label] in panels" :key="id" class="side-action" :class="{ active: activePanel === id }" type="button" @click="activePanel = id">{{ label }}</button>
      </div>
      <div class="rules">
        <span>禁止 git pull</span><span>禁止 reset --hard</span><span>禁止 git clean</span><span>禁止 stash pop</span><span>禁止 force push</span>
      </div>
    </aside>
    <main class="main">
      <section class="hero">
        <div class="toolbar">
          <span class="pill"><span class="dot ok"></span>阶段：{{ view.state?.phase || "Idle" }}</span>
          <span class="pill">仓库：{{ repoName }}</span>
          <span class="pill">同步：{{ syncText }}</span>
        </div>
        <h2>让 AI 按安全规则执行 Git 同步和推送</h2>
        <p class="muted">先检查状态，再创建恢复点。冲突、脏工作区和危险命令会被阻断。</p>
        <div class="toolbar">
          <button class="btn" type="button" :disabled="Boolean(view.busy)" @click="runAction('inspect')">检查</button>
          <button class="btn secondary" type="button" :disabled="Boolean(view.busy)" @click="runAction('create-recovery')">恢复点</button>
          <button class="btn secondary" type="button" :disabled="Boolean(view.busy)" @click="runAction('ai-sync')">AI 同步</button>
          <button class="btn secondary" type="button" :disabled="Boolean(view.busy)" @click="runAction('ai-push')">AI 推送</button>
        </div>
      </section>
      <section class="grid three">
        <div class="metric"><span>领先提交</span><strong>{{ summary?.ahead ?? "-" }}</strong></div>
        <div class="metric"><span>落后提交</span><strong>{{ summary?.behind ?? "-" }}</strong></div>
        <div class="metric"><span>工作区</span><strong>{{ summary ? (summary.cleanWorktree ? "干净" : "有改动") : "未检查" }}</strong></div>
      </section>
      <section class="grid" v-show="activePanel === 'overview'">
        <article class="panel"><h3>风险摘要</h3><pre class="box" :class="{ bad: blockers.length }">{{ summary ? (blockers.length ? blockers.join("\n") : "没有发现阻断项。") : "还没有检查仓库状态。" }}</pre></article>
        <article class="panel"><h3>下一步建议</h3><pre class="box warn">{{ nextStep }}</pre></article>
        <article class="panel"><h3>恢复点</h3><pre class="box warn">{{ recovery ? JSON.stringify(recovery, null, 2) : "本轮还没有恢复点。" }}</pre></article>
        <article class="panel"><h3>阻断项</h3><pre class="box" :class="{ bad: blockers.length }">{{ blockers.length ? blockers.join("\n") : "当前没有阻断项。" }}</pre></article>
      </section>
      <section class="panel" v-show="activePanel === 'status' || activePanel === 'overview'">
        <div class="panel-head"><h3>Git 状态</h3><span class="muted">{{ changedCount }} 个改动项</span></div>
        <div class="status-grid"><div v-for="section in sections" :key="section.name" class="status-card"><span>{{ section.name }}</span><strong>{{ section.files.length }}</strong></div></div>
        <div class="git-graph-list">
          <div class="graph-head"><h3>Git 提交树</h3><button class="btn secondary compact" type="button" @click="loadGraph">刷新</button></div>
          <div v-if="view.commits.length" class="commit-list">
            <div v-for="commit in view.commits" :key="commit.hash" class="commit-row" :class="{ head: commit.isHead }">
              <div class="commit-lanes">
                <span v-for="lane in 4" :key="lane" class="lane" :class="{ active: lane - 1 === commit.lane }"></span>
                <span class="node" :style="{ left: `${commit.lane * 14 + 8}px` }"></span>
              </div>
              <div class="commit-main">
                <div class="commit-title">
                  <span v-if="commit.isHead" class="branch current">HEAD</span>
                  <span v-for="ref in commit.refs" :key="ref" class="branch">{{ ref }}</span>
                  <span>{{ commit.subject }}</span>
                </div>
                <div class="commit-meta-small">{{ commit.date }}</div>
              </div>
              <div class="commit-author"><span class="avatar">{{ commit.author?.slice(0, 1) || "?" }}</span>{{ commit.author }}</div>
              <code class="commit-hash">{{ commit.shortHash }}</code>
            </div>
          </div>
          <div v-else class="empty-state">{{ view.graphError || "暂无提交图。" }}</div>
        </div>
        <div class="file-table">
          <div class="table-head"><span>分组</span><span>状态</span><span>路径</span></div>
          <div v-if="files.length"><div v-for="file in files" :key="`${file.group}:${file.status}:${file.path}`" class="file-row"><span>{{ file.group }}</span><span>{{ file.status }}</span><code>{{ file.path }}</code></div></div>
          <div v-else class="empty-state">点击“检查仓库”后显示文件列表。</div>
        </div>
      </section>
      <section class="panel" v-show="activePanel === 'recovery'"><h3>恢复证据</h3><pre class="output">{{ recovery ? JSON.stringify(recovery, null, 2) : "还没有恢复点。" }}</pre></section>
      <section class="panel" v-show="activePanel === 'blockers'"><h3>当前阻断项</h3><pre class="output">{{ blockers.length ? blockers.join("\n") : "当前没有阻断项。" }}</pre></section>
      <section class="panel" v-show="activePanel === 'logs'"><h3>事件日志</h3><ol class="logs"><li v-for="entry in logs" :key="entry.time + entry.event"><time>{{ new Date(entry.time).toLocaleTimeString() }}</time><code>{{ entry.event }}：{{ JSON.stringify(entry.data) }}</code></li></ol></section>
      <section class="panel" v-show="activePanel === 'settings'">
        <div class="panel-head"><div><h3>设置</h3><p class="muted">保存到本地 config.json。读取配置时 API Key 会被脱敏。</p></div><span class="status-label">{{ view.configState }}</span></div>
        <form class="settings-form" @submit.prevent="saveSettings">
          <label class="wide"><span>仓库路径</span><input v-model="form.repoPath"></label>
          <label><span>AI 地址</span><input v-model="form.baseUrl" placeholder="https://api.openai.com/v1"></label>
          <label><span>模型</span><input v-model="form.model" placeholder="gpt-5.5"></label>
          <label><span>API Key</span><input v-model="form.apiKey" type="password" placeholder="留空表示保留已保存 Key"></label>
          <label><span>温度</span><input v-model="form.temperature" type="number" min="0" max="2" step="0.1"></label>
          <label class="toggle-row"><input v-model="form.requireConfirmBeforePush" type="checkbox"><span>推送前要求浏览器确认</span></label>
          <div class="form-actions wide"><button class="btn" type="submit">保存设置</button><button class="btn secondary" type="button" @click="loadConfigAndState">重新读取</button></div>
        </form>
      </section>
      <section class="panel"><h3>最近一次操作输出</h3><pre class="output">{{ view.details }}</pre></section>
    </main>
  </div>
</template>
