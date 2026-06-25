<script setup>
import { computed, ref, watch } from "vue";
import { buildCommitGraphRows } from "../graph-layout.js";
import { loadCommitDetail } from "../client/api.js";

const props = defineProps({
  commits: { type: Array, default: () => [] },
  repoName: { type: String, required: true },
  branch: { type: String, default: "main" },
  graphError: { type: String, default: "" },
  labels: { type: Object, required: true }
});

const emit = defineEmits(["refresh"]);
const graphRows = computed(() => buildCommitGraphRows(props.commits));

const selectedHash = ref("");
const commitDetail = ref(null);
const loadingDetail = ref(false);
let detailRequestId = 0;

const laneStep = 22;
const laneOrigin = 33;
const graphRowHeight = 24;
const graphMinWidth = 142;

function laneX(lane) {
  return lane * laneStep + laneOrigin;
}

function graphLaneWidth(commit) {
  const lanes = [0, commit.nodeLane, ...commit.branchLines, ...commit.mergeJoinLanes, ...commit.branchSplitLanes];
  const maxLane = Math.max(...lanes.filter((lane) => Number.isFinite(lane)));
  return Math.max(graphMinWidth, laneX(maxLane) + 18);
}

function graphVerticalLanes(commit) {
  const endingLanes = Array.isArray(commit.branchSplitLanes) ? commit.branchSplitLanes : [];
  const joiningLanes = Array.isArray(commit.mergeJoinLanes) ? commit.mergeJoinLanes : [];
  return uniqueGraphLanes([0, commit.nodeLane, ...commit.branchLines])
    .filter((lane) => lane === commit.nodeLane || (!endingLanes.includes(lane) && !joiningLanes.includes(lane)));
}

function verticalPath(commit, lane) {
  const x = laneX(lane);
  const startY = commit.startsLane && lane === commit.nodeLane ? 16 : 0;
  return `M ${x} ${startY} L ${x} ${graphRowHeight}`;
}

function mergeCurvePath(commit, lane) {
  const fromX = laneX(commit.nodeLane);
  const toX = laneX(lane);
  return `M ${fromX} 12 C ${fromX} 17 ${toX} 17 ${toX} ${graphRowHeight}`;
}

function splitCurvePath(commit, lane) {
  const fromX = laneX(lane);
  const toX = laneX(commit.nodeLane);
  return `M ${fromX} 0 C ${fromX} 7 ${toX} 7 ${toX} 12`;
}

function graphLaneClass(lane) {
  return `lane-${Math.abs(lane) % 6}`;
}

function uniqueGraphLanes(lanes) {
  return [...new Set(lanes.filter((lane) => Number.isFinite(lane)))].sort((left, right) => left - right);
}

function statusIcon(status) {
  if (status.startsWith("A")) return "+";
  if (status.startsWith("D")) return "-";
  if (status.startsWith("R")) return "~";
  return "~";
}

function statusLabel(status) {
  if (status.startsWith("A")) return "新增";
  if (status.startsWith("D")) return "删除";
  if (status.startsWith("R")) return "重命名";
  if (status.startsWith("M")) return "修改";
  return status;
}

function authorInitial(author) {
  const value = String(author || "").trim();
  return value ? value.slice(0, 1).toUpperCase() : "?";
}

async function selectCommit(hash, options = {}) {
  if (!options.force && selectedHash.value === hash) {
    selectedHash.value = "";
    commitDetail.value = null;
    return;
  }
  selectedHash.value = hash;
  loadingDetail.value = true;
  const requestId = ++detailRequestId;
  try {
    const result = await loadCommitDetail(hash);
    if (requestId === detailRequestId) {
      commitDetail.value = result.commit;
    }
  } catch (error) {
    if (requestId === detailRequestId) {
      commitDetail.value = null;
    }
  } finally {
    if (requestId === detailRequestId) {
      loadingDetail.value = false;
    }
  }
}

watch(
  graphRows,
  (rows) => {
    if (!rows.length) {
      selectedHash.value = "";
      commitDetail.value = null;
      return;
    }
    if (!selectedHash.value || !rows.some((row) => row.hash === selectedHash.value)) {
      void selectCommit(rows[0].hash, { force: true });
    }
  },
  { immediate: true }
);
</script>

<template>
  <section class="graph-page">
    <div class="graph-toolbar">
      <div>
        <h3>{{ labels.graph }}</h3>
        <p>按当前仓库提交历史查看分支、HEAD 和最近提交位置。点击提交查看详情。</p>
      </div>
      <button class="btn secondary" type="button" @click="emit('refresh')">{{ labels.refresh }}</button>
    </div>

    <div class="git-graph-layout">
      <div class="git-graph-list">
        <div class="graph-titlebar">
          <span></span>
          <strong>{{ repoName }}</strong>
          <button class="graph-refresh" type="button" @click="emit('refresh')">{{ labels.refresh }}</button>
        </div>
        <div class="graph-branchbar">
          <span class="graph-menu">=</span>
          <span class="branch-name">{{ branch || "main" }}</span>
          <span class="graph-column-title">提交信息</span>
        </div>
        <div class="graph-body">
          <div class="graph-sidebar"><span>*</span></div>
          <div v-if="graphRows.length" class="commit-list">
            <div
              v-for="commit in graphRows"
              :key="commit.hash"
              class="commit-row"
              :class="{ head: commit.isHead, merge: commit.isMerge, 'branch-end': commit.endsBranch, selected: selectedHash === commit.hash }"
              @click="selectCommit(commit.hash)"
            >
              <div class="commit-lanes">
                <svg
                  class="graph-svg"
                  :viewBox="`0 0 ${graphLaneWidth(commit)} ${graphRowHeight}`"
                  :width="graphLaneWidth(commit)"
                  :height="graphRowHeight"
                  aria-hidden="true"
                >
                  <path
                    v-for="lane in graphVerticalLanes(commit)"
                    :key="`line-${lane}`"
                    class="graph-path graph-vertical"
                    :class="graphLaneClass(lane)"
                    :d="verticalPath(commit, lane)"
                  />
                  <path
                    v-for="lane in commit.mergeJoinLanes"
                    :key="`join-${lane}`"
                    class="graph-path graph-curve graph-merge"
                    :class="graphLaneClass(lane)"
                    :d="mergeCurvePath(commit, lane)"
                  />
                  <path
                    v-for="lane in commit.branchSplitLanes"
                    :key="`split-${lane}`"
                    class="graph-path graph-curve graph-split"
                    :class="graphLaneClass(lane)"
                    :d="splitCurvePath(commit, lane)"
                  />
                  <circle
                    class="graph-node"
                    :class="graphLaneClass(commit.nodeLane)"
                    :cx="laneX(commit.nodeLane)"
                    cy="12"
                    r="4"
                  />
                </svg>
              </div>
              <div class="commit-main">
                <div class="commit-title">
                  <span
                    v-for="ref in commit.refs"
                    :key="ref"
                    class="branch"
                    :class="{ current: commit.isHead && ref === commit.refs[0], stash: ref.includes('stash'), remote: ref.startsWith('origin/') || ref.startsWith('refs/remotes/') }"
                  >{{ ref }}</span>
                  <span class="subject">{{ commit.subject }}</span>
                </div>
              </div>
              <div class="commit-author"><span class="avatar">{{ authorInitial(commit.author) }}</span>{{ commit.author }}</div>
              <code class="commit-hash">{{ commit.shortHash }}</code>
              <div class="commit-date">{{ commit.date }}</div>
            </div>
          </div>
          <div v-else class="empty-state">{{ graphError || labels.noGraph }}</div>
        </div>
      </div>

      <div class="commit-detail-panel">
        <template v-if="loadingDetail">
          <div class="empty-state">加载中...</div>
        </template>
        <template v-else-if="commitDetail">
          <div class="detail-section">
            <h4>提交信息</h4>
            <div class="detail-row"><span class="detail-label">作者</span><span>{{ commitDetail.author }} &lt;{{ commitDetail.authorEmail }}&gt;</span></div>
            <div class="detail-row"><span class="detail-label">日期</span><span>{{ commitDetail.date }}</span></div>
            <div v-if="commitDetail.refs.length" class="detail-row"><span class="detail-label">引用</span>
              <span><code v-for="ref in commitDetail.refs" :key="ref" class="detail-ref">{{ ref }}</code></span>
            </div>
            <div class="detail-row"><span class="detail-label">SHA</span><code class="detail-sha">{{ commitDetail.hash }}</code></div>
            <div v-if="commitDetail.parents.length" class="detail-row"><span class="detail-label">父提交</span>
              <span><code v-for="p in commitDetail.parents" :key="p" class="detail-parent">{{ p.slice(0, 8) }}</code></span>
            </div>
          </div>

          <div class="detail-section">
            <h4>提交说明</h4>
            <p class="detail-subject">{{ commitDetail.subject }}</p>
            <pre v-if="commitDetail.body" class="detail-body">{{ commitDetail.body }}</pre>
          </div>

          <div v-if="commitDetail.files.length" class="detail-section">
            <h4>变更文件 ({{ commitDetail.files.length }})</h4>
            <div class="detail-files">
              <div v-for="file in commitDetail.files" :key="file.path" class="detail-file">
                <span class="file-status" :class="{ add: file.status.startsWith('A'), del: file.status.startsWith('D'), mod: file.status.startsWith('M') || file.status.startsWith('R') }">{{ statusIcon(file.status) }}</span>
                <code class="file-path">{{ file.path }}</code>
                <span class="file-status-label">{{ statusLabel(file.status) }}</span>
              </div>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="empty-state detail-empty">
            <p>点击左侧提交查看详情</p>
            <p class="muted">包括作者、SHA、变更文件等信息</p>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>
