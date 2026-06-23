<script setup>
import { computed, ref, watch } from "vue";

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
  readiness: { type: Object, required: true },
  nextStep: { type: String, default: "" },
  requireConfirmBeforePush: { type: Boolean, default: true }
});

const emit = defineEmits(["action", "commit", "push", "suggest-message", "blocked"]);

const selectedPaths = ref([]);
const commitMessage = ref("");
const pushConfirmed = ref(false);
const suggestingMessage = ref(false);

const selectedFileCount = computed(() => selectedPaths.value.length);
const selectedFilesLabel = computed(() => `${selectedFileCount.value} / ${props.selectableFiles.length}`);
const changedCount = computed(() => props.files.length);
const canCommit = computed(() => !commitBlockReason.value && !props.busy);
const canPush = computed(() => !pushBlockReason.value && !props.busy);

const commitBlockReason = computed(() => {
  if (!props.config?.repoPath) return "缺少仓库路径";
  if (!props.summary) return "先检查仓库";
  if (props.blockers.length) return "存在阻断项";
  if (!selectedPaths.value.length) return "先选择文件";
  return "";
});

const pushBlockReason = computed(() => {
  if (!props.config?.repoPath) return "缺少仓库路径";
  if (!props.summary) return "先检查仓库";
  if (props.blockers.length) return "存在阻断项";
  if (props.requireConfirmBeforePush && !pushConfirmed.value) return "需要推送确认";
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

function togglePath(path) {
  selectedPaths.value = selectedPaths.value.includes(path)
    ? selectedPaths.value.filter((item) => item !== path)
    : [...selectedPaths.value, path];
}

function selectAll() {
  selectedPaths.value = props.selectableFiles.map((file) => file.path);
}

function selectSection(sectionId) {
  const picked = props.files.filter((file) => file.selectable && file.sectionId === sectionId).map((file) => file.path);
  selectedPaths.value = [...new Set([...selectedPaths.value, ...picked])];
}

function clearSelection() {
  selectedPaths.value = [];
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
  emit("push", { confirmed: pushConfirmed.value });
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
        <button class="text-button" type="button" @click="selectAll">全选可提交</button>
        <button class="text-button" type="button" @click="selectSection('staged')">只选已暂存</button>
        <button class="text-button" type="button" @click="selectSection('unstaged')">只选未暂存</button>
        <button class="text-button" type="button" @click="clearSelection">清空选择</button>
        <button class="text-button" type="button" @click="emit('action', 'inspect')">{{ labels.refresh }}</button>
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
        <div v-if="!selectableFiles.length" class="empty-state">{{ labels.fileHint }}</div>
      </div>

      <div v-if="conflictFiles.length" class="conflict-box">
        <strong>{{ labels.conflictFiles }}</strong>
        <code v-for="file in conflictFiles" :key="file.path">{{ file.path }}</code>
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
      <div class="action-stack">
        <button class="btn secondary" type="button" :disabled="Boolean(busy)" @click="emit('action', 'create-recovery')">{{ labels.createRecovery }}</button>
        <button class="btn secondary" type="button" :disabled="Boolean(busy)" @click="emit('action', 'ai-sync')">{{ labels.aiSync }}</button>
        <label class="push-confirm"><input v-model="pushConfirmed" type="checkbox">{{ labels.pushConfirm }}</label>
        <button class="btn danger" type="button" :disabled="!canPush" @click="runPush">{{ labels.aiPush }}</button>
        <span class="disabled-reason">{{ pushBlockReason || "推送门禁已满足" }}</span>
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
