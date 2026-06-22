<script setup>
import { computed, onMounted, reactive, ref } from "vue";

const zh = {
  title: "\u0047\u0069\u0074 \u5b89\u5168\u63d0\u4ea4",
  desc: "\u672c\u5730 \u0047\u0069\u0074 \u5b89\u5168\u5de5\u4f5c\u53f0\u3002\u0041\u0049 \u8d1f\u8d23\u5224\u65ad\u548c\u64cd\u4f5c\u5efa\u8bae\uff0c\u004e\u006f\u0064\u0065 \u5b89\u5168\u5c42\u53ea\u6267\u884c\u767d\u540d\u5355 \u0047\u0069\u0074 \u547d\u4ee4\u3002",
  connected: "\u672c\u5730\u670d\u52a1\u5df2\u8fde\u63a5",
  connecting: "\u6b63\u5728\u8fde\u63a5",
  noRepoPath: "\u5c1a\u672a\u914d\u7f6e\u4ed3\u5e93\u8def\u5f84",
  quick: "\u5feb\u6377\u64cd\u4f5c",
  inspectRepo: "\u68c0\u67e5\u4ed3\u5e93",
  createRecovery: "\u521b\u5efa\u6062\u590d\u70b9",
  aiSync: "\u0041\u0049 \u540c\u6b65",
  aiPush: "\u0041\u0049 \u63a8\u9001",
  panels: "\u9762\u677f",
  overview: "\u603b\u89c8",
  gitStatus: "\u0047\u0069\u0074 \u72b6\u6001",
  recovery: "\u6062\u590d\u70b9",
  blockers: "\u963b\u65ad\u9879",
  logs: "\u65e5\u5fd7",
  settings: "\u8bbe\u7f6e",
  hero: "\u8ba9 \u0041\u0049 \u6309\u5b89\u5168\u89c4\u5219\u6267\u884c \u0047\u0069\u0074 \u540c\u6b65\u548c\u63a8\u9001",
  heroDesc: "\u5148\u68c0\u67e5\u72b6\u6001\uff0c\u518d\u521b\u5efa\u6062\u590d\u70b9\u3002\u51b2\u7a81\u3001\u810f\u5de5\u4f5c\u533a\u548c\u5371\u9669\u547d\u4ee4\u4f1a\u88ab\u963b\u65ad\u3002",
  phase: "\u9636\u6bb5",
  repo: "\u4ed3\u5e93",
  sync: "\u540c\u6b65",
  ahead: "\u9886\u5148\u63d0\u4ea4",
  behind: "\u843d\u540e\u63d0\u4ea4",
  worktree: "\u5de5\u4f5c\u533a",
  clean: "\u5e72\u51c0",
  dirty: "\u6709\u6539\u52a8",
  unchecked: "\u672a\u68c0\u67e5",
  risk: "\u98ce\u9669\u6458\u8981",
  next: "\u4e0b\u4e00\u6b65\u5efa\u8bae",
  recoveryPoint: "\u6062\u590d\u70b9",
  noRecovery: "\u672c\u8f6e\u8fd8\u6ca1\u6709\u6062\u590d\u70b9\u3002",
  noBlockers: "\u5f53\u524d\u6ca1\u6709\u963b\u65ad\u9879\u3002",
  noRisk: "\u6ca1\u6709\u53d1\u73b0\u963b\u65ad\u9879\u3002",
  notInspected: "\u8fd8\u6ca1\u6709\u68c0\u67e5\u4ed3\u5e93\u72b6\u6001\u3002",
  changedItems: "\u4e2a\u6539\u52a8\u9879",
  staged: "\u5df2\u6682\u5b58",
  unstaged: "\u672a\u6682\u5b58",
  untracked: "\u672a\u8ddf\u8e2a",
  conflicts: "\u51b2\u7a81",
  graph: "\u0047\u0069\u0074 \u63d0\u4ea4\u6811",
  refresh: "\u5237\u65b0",
  noGraph: "\u6682\u65e0\u63d0\u4ea4\u56fe\u3002",
  group: "\u5206\u7ec4",
  status: "\u72b6\u6001",
  path: "\u8def\u5f84",
  fileHint: "\u70b9\u51fb\u201c\u68c0\u67e5\u4ed3\u5e93\u201d\u540e\u663e\u793a\u6587\u4ef6\u5217\u8868\u3002",
  recoveryEvidence: "\u6062\u590d\u8bc1\u636e",
  eventLog: "\u4e8b\u4ef6\u65e5\u5fd7",
  saveLocal: "\u4fdd\u5b58\u5230\u672c\u5730 config.json\u3002\u8bfb\u53d6\u914d\u7f6e\u65f6 API Key \u4f1a\u88ab\u8131\u654f\u3002",
  repoPath: "\u4ed3\u5e93\u8def\u5f84",
  aiBase: "\u0041\u0049 \u5730\u5740",
  model: "\u6a21\u578b",
  temp: "\u6e29\u5ea6",
  confirmPush: "\u63a8\u9001\u524d\u8981\u6c42\u6d4f\u89c8\u5668\u786e\u8ba4",
  saveSettings: "\u4fdd\u5b58\u8bbe\u7f6e",
  reload: "\u91cd\u65b0\u8bfb\u53d6",
  lastOutput: "\u6700\u8fd1\u4e00\u6b21\u64cd\u4f5c\u8f93\u51fa",
  waiting: "\u7b49\u5f85\u68c0\u67e5\u4ed3\u5e93\u72b6\u6001\u3002",
  forbidPull: "\u7981\u6b62 git pull",
  forbidReset: "\u7981\u6b62 reset --hard",
  forbidClean: "\u7981\u6b62 git clean",
  forbidStashPop: "\u7981\u6b62 stash pop",
  forbidForcePush: "\u7981\u6b62 force push"
};

const activePanel = ref("overview");
const view = reactive({
  config: null,
  state: null,
  logs: [],
  result: null,
  details: zh.waiting,
  busy: "",
  connection: zh.connecting,
  connected: false,
  configState: "\u672a\u4fdd\u5b58",
  commits: [],
  graphError: ""
});
const form = reactive({ repoPath: "", baseUrl: "", model: "", apiKey: "", temperature: 0.1, requireConfirmBeforePush: true });
const summary = computed(() => view.result?.summary || null);
const status = computed(() => view.result?.status || null);
const blockers = computed(() => view.state?.blockers || summary.value?.blockers || []);
const recovery = computed(() => view.state?.activeRecovery || null);
const repoName = computed(() => (view.config?.repoPath || "").split(/[\\/]/).filter(Boolean).at(-1) || "\u672a\u914d\u7f6e\u4ed3\u5e93");
const changedCount = computed(() => {
  const s = summary.value;
  return s ? (s.stagedCount || 0) + (s.unstagedCount || 0) + (s.untrackedCount || 0) + (s.unmergedCount || 0) : 0;
});
const syncText = computed(() => {
  const s = summary.value;
  if (!s) return "\u672a\u77e5";
  if (s.ahead && s.behind) return `\u9886\u5148 ${s.ahead} / \u843d\u540e ${s.behind}`;
  if (s.ahead) return `\u9886\u5148 ${s.ahead}`;
  if (s.behind) return `\u843d\u540e ${s.behind}`;
  return "\u5df2\u540c\u6b65";
});
const nextStep = computed(() => {
  if (!view.config?.repoPath) return "\u5148\u5728\u8bbe\u7f6e\u4e2d\u586b\u5199\u4ed3\u5e93\u8def\u5f84\u3002";
  if (!summary.value) return "\u70b9\u51fb\u201c\u68c0\u67e5\u4ed3\u5e93\u201d\uff0c\u8bfb\u53d6\u5206\u652f\u3001\u4e0a\u6e38\u3001\u5de5\u4f5c\u533a\u3001\u51b2\u7a81\u548c diff \u68c0\u67e5\u7ed3\u679c\u3002";
  if (blockers.value.length) return "\u5148\u5904\u7406\u963b\u65ad\u9879\uff0c\u518d\u6267\u884c AI \u540c\u6b65\u6216 AI \u63a8\u9001\u3002";
  if (!recovery.value) return "\u521b\u5efa\u6062\u590d\u70b9\uff0c\u518d\u6267\u884c\u53ef\u80fd\u5305\u542b rebase \u7684\u540c\u6b65\u52a8\u4f5c\u3002";
  if (summary.value.behind) return "\u53ef\u4ee5\u6267\u884c AI \u540c\u6b65\u3002\u5de5\u5177\u4f1a\u4f7f\u7528\u767d\u540d\u5355 Git \u547d\u4ee4\uff0c\u4e0d\u4f1a\u6267\u884c git pull\u3002";
  if (summary.value.ahead) return "\u53ef\u4ee5\u6267\u884c AI \u63a8\u9001\u3002\u63a8\u9001\u524d\u4ecd\u4f1a\u7ecf\u8fc7\u5b89\u5168\u68c0\u67e5\u548c\u6d4f\u89c8\u5668\u786e\u8ba4\u3002";
  return "\u4ed3\u5e93\u5f53\u524d\u53ef\u7528\u3002\u6bcf\u6b21\u8fdc\u7aef\u64cd\u4f5c\u524d\u5efa\u8bae\u91cd\u65b0\u68c0\u67e5\u3002";
});
const sections = computed(() => [
  { name: zh.staged, files: status.value?.staged || [] },
  { name: zh.unstaged, files: status.value?.unstaged || [] },
  { name: zh.untracked, files: (status.value?.untracked || []).map((path) => ({ status: "??", path })) },
  { name: zh.conflicts, files: (status.value?.unmerged || []).map((path) => ({ status: "UU", path })) }
]);
const files = computed(() => sections.value.flatMap((section) => section.files.map((file) => ({ ...file, group: section.name }))));
const panels = [["overview", zh.overview], ["status", zh.gitStatus], ["recovery", zh.recovery], ["blockers", zh.blockers], ["logs", zh.logs], ["settings", zh.settings]];

onMounted(init);
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
  log("\u754c\u9762\u64cd\u4f5c", { action: labelAction(action) });
  try {
    const result = await api(`/api/action/${action}`, { method: "POST", body: "{}" });
    if (result.status || result.summary) view.result = { status: result.status, summary: result.summary };
    view.details = JSON.stringify(result, null, 2);
    log("\u64cd\u4f5c\u5b8c\u6210", { action: labelAction(action) });
    if (action === "inspect" || action === "create-recovery") await loadGraph();
  } catch (error) {
    view.details = `\u9519\u8bef\n${error.message}`;
    log("\u64cd\u4f5c\u5931\u8d25", { action: labelAction(action), message: error.message });
  } finally {
    view.busy = "";
  }
}
async function saveSettings() {
  view.configState = "\u6b63\u5728\u4fdd\u5b58";
  try {
    const result = await api("/api/config", { method: "POST", body: JSON.stringify({ config: settingsPayload() }) });
    view.config = result.config;
    view.state = result.state || view.state;
    fillForm(view.config);
    view.configState = "\u5df2\u4fdd\u5b58";
    await loadGraph();
  } catch (error) {
    view.configState = error.message;
  }
}
function settingsPayload() {
  const payload = { repoPath: form.repoPath.trim(), ai: { baseUrl: form.baseUrl.trim(), model: form.model.trim(), temperature: Number(form.temperature || 0.1) }, workflow: { requireConfirmBeforePush: form.requireConfirmBeforePush } };
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
  view.configState = config.ai?.apiKey ? "Key \u5df2\u4fdd\u5b58" : "\u7f3a\u5c11 Key";
}
function openEvents() {
  const events = new EventSource("/api/events");
  events.onopen = () => connect(true);
  events.onerror = () => connect(false, "\u4e8b\u4ef6\u6d41\u65ad\u5f00\uff0c\u6d4f\u89c8\u5668\u4f1a\u81ea\u52a8\u91cd\u8fde");
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
function connect(ok, note = "") { view.connected = ok; view.connection = ok ? zh.connected : `\u8fde\u63a5\u65ad\u5f00${note ? `\uff1a${note}` : ""}`; }
function log(event, data) { view.logs.push({ time: new Date().toISOString(), event, data }); }
function labelAction(action) { return ({ inspect: zh.inspectRepo, "create-recovery": zh.createRecovery, "ai-sync": zh.aiSync, "ai-push": zh.aiPush })[action] || action; }
</script>

<template>
  <div class="layout">
    <aside class="side">
      <div class="brand">G</div>
      <h1>{{ zh.title }}</h1>
      <p class="muted">{{ zh.desc }}</p>
      <div class="side-card">
        <span class="pill"><span class="dot" :class="{ ok: view.connected }"></span>{{ view.connection }}</span>
        <span class="repo-path">{{ view.config?.repoPath || zh.noRepoPath }}</span>
      </div>
      <div class="side-section">
        <h3>{{ zh.quick }}</h3>
        <button class="side-action primary" type="button" :disabled="Boolean(view.busy)" @click="runAction('inspect')">{{ zh.inspectRepo }}</button>
        <button class="side-action" type="button" :disabled="Boolean(view.busy)" @click="runAction('create-recovery')">{{ zh.createRecovery }}</button>
        <button class="side-action" type="button" :disabled="Boolean(view.busy)" @click="runAction('ai-sync')">{{ zh.aiSync }}</button>
        <button class="side-action" type="button" :disabled="Boolean(view.busy)" @click="runAction('ai-push')">{{ zh.aiPush }}</button>
      </div>
      <div class="side-section">
        <h3>{{ zh.panels }}</h3>
        <button v-for="[id, label] in panels" :key="id" class="side-action" :class="{ active: activePanel === id }" type="button" @click="activePanel = id">{{ label }}</button>
      </div>
      <div class="rules">
        <span>{{ zh.forbidPull }}</span><span>{{ zh.forbidReset }}</span><span>{{ zh.forbidClean }}</span><span>{{ zh.forbidStashPop }}</span><span>{{ zh.forbidForcePush }}</span>
      </div>
    </aside>
    <main class="main">
      <section class="hero">
        <div class="toolbar">
          <span class="pill"><span class="dot ok"></span>{{ zh.phase }}: {{ view.state?.phase || "Idle" }}</span>
          <span class="pill">{{ zh.repo }}: {{ repoName }}</span>
          <span class="pill">{{ zh.sync }}: {{ syncText }}</span>
        </div>
        <h2>{{ zh.hero }}</h2>
        <p class="muted">{{ zh.heroDesc }}</p>
        <div class="toolbar">
          <button class="btn" type="button" :disabled="Boolean(view.busy)" @click="runAction('inspect')">{{ zh.inspectRepo }}</button>
          <button class="btn secondary" type="button" :disabled="Boolean(view.busy)" @click="runAction('create-recovery')">{{ zh.recovery }}</button>
          <button class="btn secondary" type="button" :disabled="Boolean(view.busy)" @click="runAction('ai-sync')">{{ zh.aiSync }}</button>
          <button class="btn secondary" type="button" :disabled="Boolean(view.busy)" @click="runAction('ai-push')">{{ zh.aiPush }}</button>
        </div>
      </section>
      <section class="grid three">
        <div class="metric"><span>{{ zh.ahead }}</span><strong>{{ summary?.ahead ?? "-" }}</strong></div>
        <div class="metric"><span>{{ zh.behind }}</span><strong>{{ summary?.behind ?? "-" }}</strong></div>
        <div class="metric"><span>{{ zh.worktree }}</span><strong>{{ summary ? (summary.cleanWorktree ? zh.clean : zh.dirty) : zh.unchecked }}</strong></div>
      </section>
      <section class="grid" v-show="activePanel === 'overview'">
        <article class="panel"><h3>{{ zh.risk }}</h3><pre class="box" :class="{ bad: blockers.length }">{{ summary ? (blockers.length ? blockers.join("\n") : zh.noRisk) : zh.notInspected }}</pre></article>
        <article class="panel"><h3>{{ zh.next }}</h3><pre class="box warn">{{ nextStep }}</pre></article>
        <article class="panel"><h3>{{ zh.recoveryPoint }}</h3><pre class="box warn">{{ recovery ? JSON.stringify(recovery, null, 2) : zh.noRecovery }}</pre></article>
        <article class="panel"><h3>{{ zh.blockers }}</h3><pre class="box" :class="{ bad: blockers.length }">{{ blockers.length ? blockers.join("\n") : zh.noBlockers }}</pre></article>
      </section>
      <section class="panel" v-show="activePanel === 'status' || activePanel === 'overview'">
        <div class="panel-head compact-head"><h3>{{ zh.gitStatus }}</h3><span class="muted">{{ changedCount }} {{ zh.changedItems }}</span></div>
        <div class="git-graph-list">
          <div class="graph-titlebar">
            <span></span>
            <strong>{{ repoName }}</strong>
            <button class="graph-refresh" type="button" @click="loadGraph">{{ zh.refresh }}</button>
          </div>
          <div class="graph-branchbar">
            <span class="graph-menu">=</span>
            <span class="branch-name">main</span>
          </div>
          <div class="graph-body">
            <div class="graph-sidebar"><span>*</span></div>
            <div v-if="view.commits.length" class="commit-list">
              <div v-for="commit in view.commits" :key="commit.hash" class="commit-row" :class="{ head: commit.isHead }">
                <div class="commit-lanes">
                  <span v-for="lane in 4" :key="lane" class="lane" :class="{ active: lane - 1 === commit.lane }"></span>
                  <span class="node" :style="{ left: `${commit.lane * 14 + 8}px` }"></span>
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
        <div class="status-strip"><div v-for="section in sections" :key="section.name" class="status-card"><span>{{ section.name }}</span><strong>{{ section.files.length }}</strong></div></div>
        <div class="file-table">
          <div class="table-head"><span>{{ zh.group }}</span><span>{{ zh.status }}</span><span>{{ zh.path }}</span></div>
          <div v-if="files.length"><div v-for="file in files" :key="`${file.group}:${file.status}:${file.path}`" class="file-row"><span>{{ file.group }}</span><span>{{ file.status }}</span><code>{{ file.path }}</code></div></div>
          <div v-else class="empty-state">{{ zh.fileHint }}</div>
        </div>
      </section>
      <section class="panel" v-show="activePanel === 'recovery'"><h3>{{ zh.recoveryEvidence }}</h3><pre class="output">{{ recovery ? JSON.stringify(recovery, null, 2) : zh.noRecovery }}</pre></section>
      <section class="panel" v-show="activePanel === 'blockers'"><h3>{{ zh.blockers }}</h3><pre class="output">{{ blockers.length ? blockers.join("\n") : zh.noBlockers }}</pre></section>
      <section class="panel" v-show="activePanel === 'logs'"><h3>{{ zh.eventLog }}</h3><ol class="logs"><li v-for="entry in logs" :key="entry.time + entry.event"><time>{{ new Date(entry.time).toLocaleTimeString() }}</time><code>{{ entry.event }}: {{ JSON.stringify(entry.data) }}</code></li></ol></section>
      <section class="panel" v-show="activePanel === 'settings'">
        <div class="panel-head"><div><h3>{{ zh.settings }}</h3><p class="muted">{{ zh.saveLocal }}</p></div><span class="status-label">{{ view.configState }}</span></div>
        <form class="settings-form" @submit.prevent="saveSettings">
          <label class="wide"><span>{{ zh.repoPath }}</span><input v-model="form.repoPath"></label>
          <label><span>{{ zh.aiBase }}</span><input v-model="form.baseUrl" placeholder="https://api.openai.com/v1"></label>
          <label><span>{{ zh.model }}</span><input v-model="form.model" placeholder="gpt-5.5"></label>
          <label><span>API Key</span><input v-model="form.apiKey" type="password" placeholder="????????? Key"></label>
          <label><span>{{ zh.temp }}</span><input v-model="form.temperature" type="number" min="0" max="2" step="0.1"></label>
          <label class="toggle-row"><input v-model="form.requireConfirmBeforePush" type="checkbox"><span>{{ zh.confirmPush }}</span></label>
          <div class="form-actions wide"><button class="btn" type="submit">{{ zh.saveSettings }}</button><button class="btn secondary" type="button" @click="loadConfigAndState">{{ zh.reload }}</button></div>
        </form>
      </section>
      <section class="panel"><h3>{{ zh.lastOutput }}</h3><pre class="output">{{ view.details }}</pre></section>
    </main>
  </div>
</template>
