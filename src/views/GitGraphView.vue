<script setup>
import { computed } from "vue";
import { buildCommitGraphRows } from "../graph-layout.js";

const props = defineProps({
  commits: { type: Array, default: () => [] },
  repoName: { type: String, required: true },
  branch: { type: String, default: "main" },
  graphError: { type: String, default: "" },
  labels: { type: Object, required: true }
});

const emit = defineEmits(["refresh"]);
const graphRows = computed(() => buildCommitGraphRows(props.commits));
</script>

<template>
  <section class="graph-page">
    <div class="graph-toolbar">
      <div>
        <h3>{{ labels.graph }}</h3>
        <p>按当前仓库提交历史查看分支、HEAD 和最近提交位置。</p>
      </div>
      <button class="btn secondary" type="button" @click="emit('refresh')">{{ labels.refresh }}</button>
    </div>

    <div class="git-graph-list">
      <div class="graph-titlebar">
        <span></span>
        <strong>{{ repoName }}</strong>
        <button class="graph-refresh" type="button" @click="emit('refresh')">{{ labels.refresh }}</button>
      </div>
      <div class="graph-branchbar">
        <span class="graph-menu">=</span>
        <span class="branch-name">{{ branch || "main" }}</span>
      </div>
      <div class="graph-body">
        <div class="graph-sidebar"><span>*</span></div>
        <div v-if="graphRows.length" class="commit-list">
          <div
            v-for="commit in graphRows"
            :key="commit.hash"
            class="commit-row"
            :class="{ head: commit.isHead, merge: commit.isMerge, 'branch-end': commit.endsBranch }"
          >
            <div class="commit-lanes">
              <span class="mainline"></span>
              <span
                v-for="lane in commit.branchLines"
                :key="lane"
                class="branchline"
                :style="{ left: `${lane * 22 + 32}px` }"
              ></span>
              <span
                v-for="lane in commit.mergeJoinLanes"
                :key="`join-${lane}`"
                class="merge-join"
                :style="{ width: `${lane * 22}px` }"
              ></span>
              <span
                v-for="lane in commit.branchSplitLanes"
                :key="`split-${lane}`"
                class="branch-split"
                :style="{ width: `${lane * 22}px` }"
              ></span>
              <span class="node" :style="{ left: `${commit.nodeLane * 22 + 29}px` }"></span>
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
        <div v-else class="empty-state">{{ graphError || labels.noGraph }}</div>
      </div>
    </div>
  </section>
</template>
