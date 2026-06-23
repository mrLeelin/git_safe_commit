<script setup>
import { computed, ref, watch } from "vue";
import {
  buildLineMergeRows,
  composeLineDraft,
  isMergeChoice,
  lineChoiceSummary
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
  readiness: { type: Object, required: true },
  nextStep: { type: String, default: "" }
});

const emit = defineEmits(["action", "commit", "push", "load-text-conflict", "write-text-candidate", "export-binary-conflict", "suggest-message", "blocked"]);

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
const workbenchMessage = ref("");
const workbenchActive = computed(() => Boolean(activeConflictPath.value));

const selectedFileCount = computed(() => selectedPaths.value.length);
const selectedFilesLabel = computed(() => `${selectedFileCount.value} / ${props.selectableFiles.length}`);
const changedCount = computed(() => props.files.length);
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
  confirmAction.value = "push";
}

function runSync() {
  confirmAction.value = "sync";
}

function confirmExecute() {
  const action = confirmAction.value;
  confirmAction.value = null;
  if (action === "push") {
    emit("push", { confirmed: true });
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
  workbenchMessage.value = "";
}

function isTextConflict(file) {
  return /\.(cs|asmdef|asmref|js|ts|tsx|mjs|cjs|py|ps1|sh|bat|cmd|java|kt|cpp|h|hpp|c|go|rs|md|txt|json|jsonc|xml|ya?ml|toml|ini|editorconfig|gitignore|gitattributes|shader|hlsl|cginc|compute|uss|uxml)$/i.test(file.path);
}

async function openTextWorkbench(path) {
  activeConflictPath.value = path;
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
  workbenchMessage.value = "文本冲突已加载。上方编辑候选内容，或在按行对比中选择 OURS / THEIRS / BOTH / NONE；只会生成候选文件。";
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
  workbenchMessage.value = result.ok
    ? `候选文件已生成：${result.textCandidate.candidate}`
    : (result.error || "生成候选失败");
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

async function exportBinary(path) {
  activeConflictPath.value = path;
  textConflict.value = null;
  textCandidate.value = "";
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
        <button class="btn danger" type="button" :disabled="!canPush" @click="runPush">{{ labels.aiPush }}</button>
        <span class="disabled-reason">{{ pushBlockReason || "推送门禁已满足" }}</span>
      </div>

      <div v-if="conflictFiles.length" class="conflict-box">
        <strong>{{ labels.conflictWorkbench }}</strong>
        <div v-for="file in conflictFiles" :key="file.path" class="conflict-row">
          <code>{{ file.path }}</code>
          <div class="conflict-actions">
            <button v-if="isTextConflict(file)" class="text-button" type="button" :disabled="Boolean(busy)" @click="openTextWorkbench(file.path)">{{ labels.openTextWorkbench }}</button>
            <button v-else class="text-button" type="button" :disabled="Boolean(busy)" @click="exportBinary(file.path)">{{ labels.exportBinaryConflict }}</button>
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
          <textarea v-model="textCandidate" spellcheck="false" rows="18" @input="textDraftSource = 'edited'"></textarea>
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
                <tr v-for="row in textLineRows" :key="row.id" :class="row.kind === 'changed' ? 'line-changed' : 'line-same'">
                  <td class="line-number">{{ row.oursLineNumber }}</td>
                  <td :class="{ 'line-ours-cell': row.kind === 'changed' }"><pre class="line-cell">{{ row.ours }}</pre></td>
                  <td class="line-number">{{ row.theirsLineNumber }}</td>
                  <td :class="{ 'line-theirs-cell': row.kind === 'changed' }"><pre class="line-cell">{{ row.theirs }}</pre></td>
                  <td class="line-choice">
                    <template v-if="row.kind === 'changed'">
                      <span class="text-conflict-label">冲突</span>
                      <button class="mini-btn text-choice-btn ours" :class="{ active: row.choice === 'ours' }" type="button" @click="setLineChoice(row.id, 'ours')">OURS</button>
                      <button class="mini-btn text-choice-btn theirs" :class="{ active: row.choice === 'theirs' }" type="button" @click="setLineChoice(row.id, 'theirs')">THEIRS</button>
                      <button class="mini-btn" :class="{ active: row.choice === 'both' }" type="button" @click="setLineChoice(row.id, 'both')">BOTH</button>
                      <button class="mini-btn" :class="{ active: row.choice === 'none' }" type="button" @click="setLineChoice(row.id, 'none')">NONE</button>
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
            <pre class="text-source">{{ sourceContent(source) }}</pre>
          </div>
        </div>

        <div class="workbench-actions">
          <button class="btn" type="button" @click="saveTextCandidate">{{ labels.writeConflictCandidate }}</button>
          <pre v-if="workbenchMessage" class="workbench-message">{{ workbenchMessage }}</pre>
        </div>
      </div>
    </div>
  </section>
  </template>

  <Teleport to="body">
    <div v-if="confirmAction" class="confirm-overlay" @click.self="cancelConfirm">
      <div class="confirm-dialog">
        <h3>{{ confirmAction === 'push' ? '确认推送' : '确认同步' }}</h3>
        <p v-if="confirmAction === 'push'">即将推送到远端，请确认当前分支的提交已经完成。</p>
        <p v-else>即将获取远端最新状态并执行 rebase，本地提交会被变基。</p>
        <div class="confirm-actions">
          <button class="btn secondary" type="button" @click="cancelConfirm">取消</button>
          <button class="btn" :class="{ danger: confirmAction === 'push' }" type="button" @click="confirmExecute">确认执行</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
