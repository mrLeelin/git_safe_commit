const ThemeStorageKey = "git-safe-commit-tool-theme";

const view = {
  config: null,
  state: null,
  logs: [],
  lastStatus: null,
  detailsText: ""
};

const $ = (selector) => document.querySelector(selector);

bindThemeToggle();
bindActions();
await initialize();

async function initialize() {
  try {
    await loadConfigAndState();
    setConnection(true);
    render();
    openEvents();
  } catch (error) {
    setConnection(false, error.message);
    appendLog("error", { message: error.message });
  }
}

async function loadConfigAndState() {
  const [config, state] = await Promise.all([
    request("/api/config"),
    request("/api/state")
  ]);
  view.config = config.config;
  view.state = state.state;
  view.logs = state.logs || [];
  fillSettingsForm(view.config);
}

function bindActions() {
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      await runAction(button.dataset.action, button);
    });
  });
  document.querySelectorAll("[data-click-target]").forEach((button) => {
    button.addEventListener("click", () => document.getElementById(button.dataset.clickTarget)?.click());
  });
  $("#clearLog").addEventListener("click", () => {
    view.logs = [];
    renderLogs();
  });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#reloadConfigBtn").addEventListener("click", async () => {
    await loadConfigAndState();
    setConfigState("已重新读取", "ok");
    render();
  });
  $("#copyDetailsBtn").addEventListener("click", async () => {
    await navigator.clipboard.writeText(view.detailsText || $("#details").textContent || "");
    temporaryText($("#copyDetailsBtn"), "已复制");
  });
}

function bindThemeToggle() {
  applyTheme(preferredTheme());
  $("#themeToggleBtn")?.addEventListener("click", () => {
    const nextTheme = document.body.classList.contains("theme-dark") ? "light" : "dark";
    localStorage.setItem(ThemeStorageKey, nextTheme);
    applyTheme(nextTheme);
  });
}

function preferredTheme() {
  const saved = localStorage.getItem(ThemeStorageKey);
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("theme-dark", isDark);
  $("#themeToggleBtn")?.setAttribute("aria-pressed", String(isDark));
  const label = $("#themeToggleText");
  if (label) label.textContent = isDark ? "夜晚模式" : "白天模式";
}

async function runAction(action, button) {
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "执行中...";
  appendLog("ui-action", { action });
  try {
    const result = await request(`/api/action/${action}`, {
      method: "POST",
      body: JSON.stringify({})
    });
    if (result.status) view.lastStatus = result.status;
    if (result.summary) renderSummary(result.summary);
    setDetails(result);
    appendLog("action-complete", { action });
  } catch (error) {
    appendLog("action-error", { action, message: error.message });
    setDetails(`ERROR\n${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const button = $("#saveConfigBtn");
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = "保存中...";
  setConfigState("保存中", "");
  try {
    const payload = settingsPayload();
    const result = await request("/api/config", {
      method: "POST",
      body: JSON.stringify({ config: payload })
    });
    view.config = result.config;
    view.state = result.state || view.state;
    fillSettingsForm(view.config);
    renderState();
    setConfigState("已保存", "ok");
    appendLog("config-saved", { repoPath: view.config.repoPath, aiBaseUrl: view.config.ai.baseUrl, model: view.config.ai.model });
  } catch (error) {
    setConfigState(error.message, "bad");
    appendLog("config-error", { message: error.message });
  } finally {
    button.disabled = false;
    button.textContent = previous;
  }
}

function settingsPayload() {
  const apiKey = $("#aiApiKeyInput").value.trim();
  const payload = {
    repoPath: $("#repoPathInput").value.trim(),
    ai: {
      baseUrl: $("#aiBaseUrlInput").value.trim(),
      model: $("#aiModelInput").value.trim(),
      temperature: Number($("#aiTemperatureInput").value || 0.1)
    },
    workflow: {
      requireConfirmBeforePush: $("#requireConfirmInput").checked
    }
  };
  if (apiKey) payload.ai.apiKey = apiKey;
  return payload;
}

function fillSettingsForm(config) {
  $("#repoPath").textContent = config.repoPath;
  $("#repoPathInput").value = config.repoPath || "";
  $("#aiBaseUrlInput").value = config.ai?.baseUrl || "";
  $("#aiModelInput").value = config.ai?.model || "";
  $("#aiApiKeyInput").value = "";
  $("#aiApiKeyInput").placeholder = config.ai?.apiKey ? `已保存：${config.ai.apiKey}` : "留空则保留已保存 Key";
  $("#aiTemperatureInput").value = String(config.ai?.temperature ?? 0.1);
  $("#requireConfirmInput").checked = Boolean(config.workflow?.requireConfirmBeforePush);
  setConfigState(config.ai?.apiKey ? "Key 已保存" : "缺少 Key", config.ai?.apiKey ? "ok" : "warn");
}

function openEvents() {
  const events = new EventSource("/api/events");
  events.onopen = () => setConnection(true);
  events.onerror = () => setConnection(false, "SSE 断开，浏览器会自动重连");
  events.addEventListener("state", (event) => {
    const data = JSON.parse(event.data);
    view.state = data.state || view.state;
    if (Array.isArray(data.logs)) view.logs = data.logs;
    render();
  });
  for (const name of ["phase", "ai-action", "ai-result"]) {
    events.addEventListener(name, (event) => {
      const data = JSON.parse(event.data);
      appendLog(name, data);
      if (name === "phase") {
        view.state = { ...(view.state || {}), phase: data.phase, note: data.note };
        renderState();
      }
    });
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function setConnection(connected, note = "") {
  $("#connectionDot").className = `dot ${connected ? "ok" : "bad"}`;
  $("#connectionText").textContent = connected ? "本地服务已连接" : `未连接${note ? `: ${note}` : ""}`;
}

function setConfigState(text, kind) {
  const label = $("#configState");
  label.textContent = text;
  label.className = `status-label ${kind || ""}`;
}

function appendLog(event, data) {
  view.logs.push({ time: new Date().toISOString(), event, data });
  renderLogs();
}

function render() {
  renderState();
  renderLogs();
}

function renderState() {
  const state = view.state || {};
  const blockers = state.blockers || [];
  const phase = state.phase || "Idle";
  $("#phase").textContent = `阶段：${phase}`;
  $("#phaseDot").className = `dot ${blockers.length ? "bad" : phase === "Complete" ? "ok" : ""}`;
  $("#blockers").textContent = String(blockers.length);
  $("#headline").textContent = blockers.length ? "存在阻断项" : phase === "Complete" ? "已完成" : "观察中";
  $("#phaseNote").textContent = state.note || "先检查状态；需要 AI 操作前，在设置里填写 URL、Key 和模型。";
  $("#decisionArea").className = blockers.length ? "box bad" : "box";
  $("#decisionArea").textContent = blockers.length ? blockers.join("\n") : "当前没有需要人工处理的事项。";
}

function renderSummary(summary = {}) {
  $("#branchPill").textContent = `分支：${summary.branch || "-"} -> ${summary.upstream || "-"}`;
  $("#syncPill").textContent = `同步：ahead ${summary.ahead ?? 0} / behind ${summary.behind ?? 0}`;
  $("#aheadValue").textContent = String(summary.ahead ?? 0);
  $("#behindValue").textContent = String(summary.behind ?? 0);
  $("#worktreeValue").textContent = summary.cleanWorktree
    ? "干净"
    : `暂存 ${summary.stagedCount || 0} / 未暂存 ${summary.unstagedCount || 0} / 未跟踪 ${summary.untrackedCount || 0}`;
  $("#blockers").textContent = String((summary.blockers || []).length);
  $("#decisionArea").className = summary.blockers?.length ? "box bad" : "box";
  $("#decisionArea").textContent = summary.blockers?.length
    ? summary.blockers.join("\n")
    : "当前没有需要人工处理的事项。";
}

function renderLogs() {
  const logs = $("#logs");
  logs.innerHTML = "";
  for (const entry of view.logs.slice(-120).toReversed()) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = new Date(entry.time).toLocaleTimeString();
    const body = document.createElement("code");
    body.textContent = `${entry.event}: ${JSON.stringify(entry.data)}`;
    item.append(time, body);
    logs.appendChild(item);
  }
}

function setDetails(value) {
  view.detailsText = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  $("#details").textContent = view.detailsText;
}

function temporaryText(button, text) {
  const previous = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = previous; }, 900);
}
