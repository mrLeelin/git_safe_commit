<script setup>
defineProps({
  labels: { type: Object, required: true },
  activeView: { type: String, required: true },
  connected: { type: Boolean, default: false },
  connection: { type: String, default: "" },
  repoName: { type: String, required: true },
  repoPath: { type: String, default: "" },
  setupItems: { type: Array, default: () => [] },
  themeMode: { type: String, default: "dark" },
  railCollapsed: { type: Boolean, default: false },
  toolVersion: { type: String, default: "" }
});

const emit = defineEmits(["select-view", "toggle-theme", "toggle-rail"]);
</script>

<template>
  <aside class="rail">
    <div class="brand-block">
      <div class="brand">G</div>
      <div>
        <h1>{{ labels.title }}</h1>
        <span v-if="toolVersion" class="version-pill">v{{ toolVersion }}</span>
        <p class="muted">{{ labels.desc }}</p>
      </div>
    </div>

    <div class="connection-card">
      <span class="pill"><span class="dot" :class="{ ok: connected }"></span>{{ connection }}</span>
      <strong>{{ repoName }}</strong>
      <code>{{ repoPath || labels.noRepoPath }}</code>
    </div>

    <div class="setup-card">
      <h2>启动检查</h2>
      <div v-for="item in setupItems" :key="item.label" class="setup-row" :class="{ ok: item.ok }">
        <span class="setup-dot"></span>
        <strong>{{ item.label }}</strong>
        <small>{{ item.detail }}</small>
      </div>
    </div>

    <nav class="main-nav" aria-label="primary">
      <button type="button" :class="{ active: activeView === 'workflow' }" @click="emit('select-view', 'workflow')">
        <span>1</span><strong>提交工作流</strong>
      </button>
      <button type="button" :class="{ active: activeView === 'graph' }" @click="emit('select-view', 'graph')">
        <span>2</span><strong>git 树</strong>
      </button>
      <button type="button" :class="{ active: activeView === 'settings' }" @click="emit('select-view', 'settings')">
        <span>3</span><strong>设置</strong>
      </button>
      <button type="button" :class="{ active: activeView === 'logs' }" @click="emit('select-view', 'logs')">
        <span>4</span><strong>日志</strong>
      </button>
    </nav>

    <div class="rail-spacer"></div>
    <div class="rail-tools">
      <button class="rail-tool" type="button" @click="emit('toggle-theme')">
        <span class="rail-tool-icon">{{ themeMode === 'dark' ? 'S' : 'D' }}</span>
        <strong>{{ themeMode === 'dark' ? '浅色模式' : '暗色模式' }}</strong>
      </button>
      <button class="rail-tool" type="button" @click="emit('toggle-rail')">
        <span class="rail-tool-icon">{{ railCollapsed ? '>>' : '<<' }}</span>
        <strong>{{ railCollapsed ? '展开' : '收起' }}</strong>
      </button>
    </div>
  </aside>
</template>
