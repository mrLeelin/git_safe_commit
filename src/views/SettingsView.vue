<script setup>
import { reactive, ref, watch } from "vue";
import {
  buildSettingsPayload,
  createDefaultSettingsForm,
  fillSettingsFormFromConfig
} from "../settings-model.js";

const props = defineProps({
  labels: { type: Object, required: true },
  config: { type: Object, default: null },
  configState: { type: String, default: "" },
  installedAi: { type: Array, default: () => [] }
});

const emit = defineEmits(["reload", "save", "choose-repo-folder", "switch-repo"]);

const activeSettingsTab = ref("general");
const form = reactive(createDefaultSettingsForm());
const settingsTabs = [
  { id: "general", label: "通用设置" },
  { id: "repo", label: "仓库路径" },
  { id: "ai", label: "AI 服务" },
  { id: "safety", label: "安全确认" },
  { id: "local", label: "本地配置" }
];

watch(() => props.config, (config) => {
  fillSettingsFormFromConfig(form, config || {});
}, { immediate: true });

function saveSettings() {
  emit("save", buildSettingsPayload(form));
}

function chooseRepoFolder() {
  emit("choose-repo-folder", (path) => {
    if (path) {
      form.repoPath = path;
      emit("save", buildSettingsPayload(form));
    }
  });
}

function switchRepo(repo) {
  form.repoPath = repo;
  emit("switch-repo", buildSettingsPayload(form));
}
</script>

<template>
  <header class="topbar settings-topbar">
    <div>
      <p class="eyebrow">系统设置</p>
      <h2>管理仓库、AI 与提交策略</h2>
    </div>
  </header>

  <section class="settings-page">
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
        <span class="status-label">{{ configState }}</span>
      </div>

      <div class="settings-card-body">
        <label v-if="activeSettingsTab === 'general' || activeSettingsTab === 'safety'" class="setting-alert wide">
          <span>
            <strong>推送确认门禁</strong>
            <small>开启后，推送到远端前必须在浏览器内确认。</small>
          </span>
          <input v-model="form.requireConfirmBeforePush" type="checkbox">
        </label>

        <label v-if="activeSettingsTab === 'general' || activeSettingsTab === 'repo'" class="repo-path-picker wide">
          <span>{{ labels.repoPath }}</span>
          <span class="repo-path-control">
            <input v-model="form.repoPath" autocomplete="off">
            <button class="btn secondary" type="button" @click="chooseRepoFolder">{{ labels.chooseFolder }}</button>
          </span>
        </label>

        <div v-if="(activeSettingsTab === 'general' || activeSettingsTab === 'repo') && form.repositories.length" class="repo-history wide">
          <strong>{{ labels.savedRepositories }}</strong>
          <div class="repo-history-list">
            <button
              v-for="repo in form.repositories"
              :key="repo"
              type="button"
              class="repo-history-item"
              :class="{ active: repo === form.repoPath }"
              @click="switchRepo(repo)"
            >
              <span>{{ repo.split(/[\\/]/).filter(Boolean).at(-1) || repo }}</span>
              <small>{{ repo }}</small>
            </button>
          </div>
        </div>

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
          <small>{{ labels.saveLocal }}</small>
        </div>
      </div>

      <div class="settings-actions">
        <button class="btn secondary" type="button" @click="emit('reload')">{{ labels.reload }}</button>
        <button class="btn" type="submit">{{ labels.saveSettings }}</button>
      </div>
    </form>
  </section>
</template>
