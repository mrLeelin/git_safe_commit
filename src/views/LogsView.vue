<script setup>
import { ref } from "vue";

defineProps({
  labels: { type: Object, required: true },
  logs: { type: Array, default: () => [] },
  details: { type: String, default: "" }
});

const activeLogTab = ref("output");
const logTabs = [
  { id: "output", label: "最近输出" },
  { id: "events", label: "事件日志" }
];
</script>

<template>
  <header class="topbar settings-topbar">
    <div>
      <p class="eyebrow">日志</p>
      <h2>查看最近输出与事件日志</h2>
    </div>
  </header>

  <section class="settings-page">
    <nav class="settings-tabs" aria-label="log sections">
      <button
        v-for="tab in logTabs"
        :key="tab.id"
        type="button"
        :class="{ active: activeLogTab === tab.id }"
        @click="activeLogTab = tab.id"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div class="settings-card">
      <div class="settings-card-head">
        <div>
          <h3>{{ logTabs.find((t) => t.id === activeLogTab)?.label || "最近输出" }}</h3>
          <p v-if="activeLogTab === 'output'">AI 工具调用的最新返回结果。</p>
          <p v-else>所有操作与系统事件的时间线记录。</p>
        </div>
      </div>

      <div v-if="activeLogTab === 'output'" class="settings-card-body" style="grid-template-columns: 1fr;">
        <pre class="output" style="margin: 0; border-radius: 8px;">{{ details }}</pre>
      </div>

      <div v-else class="settings-card-body" style="grid-template-columns: 1fr;">
        <ol class="logs" style="max-height: 520px;">
          <li v-for="entry in logs" :key="entry.time + entry.event">
            <time>{{ new Date(entry.time).toLocaleTimeString() }}</time>
            <code>{{ entry.event }}: {{ JSON.stringify(entry.data) }}</code>
          </li>
        </ol>
        <div v-if="!logs.length" class="empty-state">暂无日志记录。</div>
      </div>
    </div>
  </section>
</template>
