export async function loadConfig() {
  const result = await request("/api/config");
  return result.config;
}

export async function loadState() {
  return request("/api/state");
}

export async function loadAiInstallations() {
  const result = await request("/api/ai/installations");
  return result.installations || [];
}

export async function loadGraph() {
  return request("/api/git/graph");
}

export async function loadCommitDetail(hash) {
  return request(`/api/git/commit/${encodeURIComponent(hash)}`);
}

export async function runAction(action, payload = {}) {
  return request(`/api/action/${action}`, { method: "POST", body: JSON.stringify(payload) });
}

export async function saveSettings(config) {
  return request("/api/config", { method: "POST", body: JSON.stringify({ config }) });
}

export async function chooseRepoFolder() {
  return request("/api/system/pick-folder", { method: "POST" });
}

export async function openRepoFile(payload = {}) {
  return request("/api/system/open-file", { method: "POST", body: JSON.stringify(payload) });
}

export async function suggestMessage(payload = {}) {
  return request("/api/ai/suggest-message", { method: "POST", body: JSON.stringify(payload) });
}

export async function loadTextConflict(payload = {}) {
  return request("/api/conflict/text/load", { method: "POST", body: JSON.stringify(payload) });
}

export async function writeTextCandidate(payload = {}) {
  return request("/api/conflict/text/candidate", { method: "POST", body: JSON.stringify(payload) });
}

export async function loadTableConflict(payload = {}) {
  return request("/api/conflict/table/load", { method: "POST", body: JSON.stringify(payload) });
}

export async function writeTableCandidate(payload = {}) {
  return request("/api/conflict/table/candidate", { method: "POST", body: JSON.stringify(payload) });
}

export async function loadBinaryConflict(payload = {}) {
  return request("/api/conflict/binary/load", { method: "POST", body: JSON.stringify(payload) });
}

export async function writeBinaryCandidate(payload = {}) {
  return request("/api/conflict/binary/candidate", { method: "POST", body: JSON.stringify(payload) });
}

export async function exportBinaryConflict(payload = {}) {
  return request("/api/conflict/binary/export", { method: "POST", body: JSON.stringify(payload) });
}

export function openEvents({ onOpen, onError, onState, onLog, onPhase } = {}) {
  const events = new EventSource("/api/events");
  events.onopen = () => onOpen?.();
  events.onerror = () => onError?.("事件流断开，浏览器会自动重连");
  events.addEventListener("state", (event) => onState?.(JSON.parse(event.data)));
  events.addEventListener("log", (event) => onLog?.(JSON.parse(event.data)));
  events.addEventListener("phase", (event) => onPhase?.(JSON.parse(event.data)));
  events.addEventListener("ai-action", (event) => onLog?.(JSON.parse(event.data), "ai-action"));
  events.addEventListener("ai-result", (event) => onLog?.(JSON.parse(event.data), "ai-result"));
  return events;
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text || `服务器返回了非 JSON 响应 (HTTP ${response.status})`);
  }
  if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
