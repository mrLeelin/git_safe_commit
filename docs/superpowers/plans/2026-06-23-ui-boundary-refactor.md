# UI Boundary Refactor Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the current browser tool into maintainable client/server/data/display boundaries without changing behavior or framework.

**Architecture:** `App.vue` becomes the shell/coordinator. Client API calls move to `src/client/api.js`; Git graph server logic moves to `lib/git-graph.mjs`; display moves into `Rail.vue`, `WorkflowView.vue`, `GitGraphView.vue`, and `SettingsView.vue`.

**Tech Stack:** Vue 3 SFC, Vite, Node ESM, Express, Node test runner.

---

## File Structure

- Create `src/client/api.js`: browser API wrapper for `/api/...` calls and SSE setup.
- Create `src/components/Rail.vue`: left rail display and navigation controls.
- Create `src/views/WorkflowView.vue`: workflow, file selection, blockers, recovery, logs, and output UI.
- Create `src/views/GitGraphView.vue`: Git graph view rendering, using `src/graph-layout.js`.
- Create `src/views/SettingsView.vue`: settings tabs and form UI, using `src/settings-model.js`.
- Create `src/styles/graph.css`: Git graph styles moved from `src/styles.css`.
- Create `lib/git-graph.mjs`: server-side Git graph command construction and parsing.
- Modify `src/App.vue`: shell only, imports views/components and client API.
- Modify `src/main.js`: import split CSS files as needed.
- Modify `server.mjs`: delegate graph route to `lib/git-graph.mjs`.
- Modify tests:
  - `test/git-graph.test.mjs`
  - `test/ui-structure.test.mjs`
  - existing smoke tests as needed.

---

## Chunk 1: Server Git Graph Boundary

### Task 1: Add Server Git Graph Tests

**Files:**
- Create: `test/git-graph.test.mjs`
- Modify: none

- [ ] **Step 1: Write failing tests for graph command and parsing**

```js
import assert from "node:assert/strict";
import test from "node:test";

import { buildGraphLogArgs, buildCommitLogArgs, parseCommitGraph } from "../lib/git-graph.mjs";

test("git graph commands use topo order", () => {
  assert.deepEqual(buildGraphLogArgs().slice(0, 3), ["log", "--graph", "--topo-order"]);
  assert.ok(buildCommitLogArgs().includes("--topo-order"));
});

test("parseCommitGraph preserves parents and refs", () => {
  const stdout = [
    "hash1\u001fabc1234\u001fparent1 parent2\u001fHEAD -> main, origin/main\u001fTester\u001fmerge feature\u001f2026-06-23"
  ].join("\n");

  const commits = parseCommitGraph(stdout);

  assert.equal(commits[0].hash, "hash1");
  assert.deepEqual(commits[0].parents, ["parent1", "parent2"]);
  assert.deepEqual(commits[0].refs, ["main", "origin/main"]);
  assert.equal(commits[0].isHead, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/git-graph.test.mjs`

Expected: FAIL because `lib/git-graph.mjs` does not exist.

- [ ] **Step 3: Create `lib/git-graph.mjs`**

Move graph command arrays and parsing from `server.mjs` into exports:

```js
import { runGit } from "./git-executor.mjs";

export function buildGraphLogArgs() {
  return ["log", "--graph", "--topo-order", "--decorate", "--oneline", "--all", "-n", "60"];
}

export function buildCommitLogArgs() {
  return [
    "log",
    "--all",
    "--topo-order",
    "--decorate=short",
    "--date=short",
    "--pretty=format:%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%s%x1f%ad",
    "-n",
    "80"
  ];
}

export async function getGitGraph(repoPath) {
  const graphResult = await runGit(repoPath, buildGraphLogArgs());
  const commitResult = await runGit(repoPath, buildCommitLogArgs());
  return {
    ok: true,
    graph: graphResult.stdout.split(/\r?\n/).filter(Boolean),
    commits: parseCommitGraph(commitResult.stdout),
    command: graphResult.command,
    stderr: graphResult.stderr || commitResult.stderr
  };
}

export function parseCommitGraph(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [hash, shortHash, parents, refs, author, subject, date] = line.split("\x1f");
    const parsedRefs = parseRefs(refs || "");
    return {
      hash,
      shortHash,
      parents: parents ? parents.split(/\s+/).filter(Boolean) : [],
      refs: parsedRefs.refs,
      author,
      subject,
      date,
      isHead: Boolean(parsedRefs.current)
    };
  });
}

export function parseRefs(refs) {
  let current = "";
  const parsed = refs
    .split(",")
    .map((ref) => ref.trim())
    .filter(Boolean)
    .map((ref) => {
      const match = /^HEAD -> (.+)$/.exec(ref);
      if (match) {
        current = match[1];
        return current;
      }
      return ref.replace(/^origin\//, "origin/");
    });
  return { current, refs: [...new Set(parsed)] };
}
```

- [ ] **Step 4: Update `server.mjs` graph route**

Import `getGitGraph` and replace route body with:

```js
const graph = await getGitGraph(config.repoPath);
res.json(graph);
```

Remove local `parseCommitGraph()` and `parseRefs()`.

- [ ] **Step 5: Run tests**

Run:

```powershell
npm test -- test/git-graph.test.mjs test/server-smoke.test.mjs
```

Expected: PASS.

---

## Chunk 2: Client API Boundary

### Task 2: Add Client API Wrapper

**Files:**
- Create: `src/client/api.js`
- Modify: `src/App.vue`
- Test: `test/ui-structure.test.mjs`

- [ ] **Step 1: Add failing structure assertions**

Update `test/ui-structure.test.mjs`:

```js
const clientApi = await readFile(path.join(root, "src", "client", "api.js"), "utf8");
assert.match(clientApi, /export async function loadGraph/);
assert.match(clientApi, /"\/api\/git\/graph"/);
assert.doesNotMatch(app, /fetch\(/);
assert.doesNotMatch(app, /api\("\/api\/git\/graph"\)/);
```

- [ ] **Step 2: Run structure test to verify failure**

Run: `npm test -- test/ui-structure.test.mjs`

Expected: FAIL because `src/client/api.js` does not exist or `App.vue` still owns API details.

- [ ] **Step 3: Implement `src/client/api.js`**

```js
export async function loadConfig() {
  const result = await request("/api/config");
  return result.config;
}

export async function loadState() {
  const result = await request("/api/state");
  return result;
}

export async function loadAiInstallations() {
  const result = await request("/api/ai/installations");
  return result.installations || [];
}

export async function loadGraph() {
  const result = await request("/api/git/graph");
  return result;
}

export async function runAction(action, payload = {}) {
  return request(`/api/action/${action}`, { method: "POST", body: JSON.stringify(payload) });
}

export async function saveSettings(config) {
  return request("/api/config", { method: "POST", body: JSON.stringify({ config }) });
}

export async function suggestMessage(payload = {}) {
  return request("/api/ai/suggest-message", { method: "POST", body: JSON.stringify(payload) });
}

export function openEvents({ onOpen, onError, onState, onLog, onPhase } = {}) {
  const events = new EventSource("/api/events");
  events.onopen = () => onOpen?.();
  events.onerror = () => onError?.("事件流断开，浏览器会自动重连");
  events.addEventListener("state", (event) => onState?.(JSON.parse(event.data)));
  events.addEventListener("log", (event) => onLog?.(JSON.parse(event.data)));
  events.addEventListener("phase", (event) => onPhase?.(JSON.parse(event.data)));
  return events;
}

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || response.statusText);
  return data;
}
```

- [ ] **Step 4: Update `App.vue` to use client API functions**

Import API functions and replace the local `api()` helper. Keep state behavior identical.

- [ ] **Step 5: Run tests**

Run:

```powershell
npm test -- test/ui-structure.test.mjs
npm test
```

Expected: PASS.

---

## Chunk 3: Git Graph View Split

### Task 3: Move Git Graph View

**Files:**
- Create: `src/views/GitGraphView.vue`
- Modify: `src/App.vue`
- Modify: `test/ui-structure.test.mjs`

- [ ] **Step 1: Add failing structure assertions**

Update `test/ui-structure.test.mjs`:

```js
const gitGraphView = await readFile(path.join(root, "src", "views", "GitGraphView.vue"), "utf8");
assert.doesNotMatch(app, /git-graph-list/);
assert.match(gitGraphView, /class="git-graph-list"/);
assert.match(gitGraphView, /buildCommitGraphRows/);
```

- [ ] **Step 2: Run structure test to verify failure**

Run: `npm test -- test/ui-structure.test.mjs`

Expected: FAIL because Git graph markup is still in `App.vue`.

- [ ] **Step 3: Create `GitGraphView.vue`**

Move the graph page template and `graphRows` computed into the new component.

Props:

```js
defineProps({
  commits: { type: Array, default: () => [] },
  repoName: { type: String, required: true },
  branch: { type: String, default: "main" },
  graphError: { type: String, default: "" },
  labels: { type: Object, required: true }
});
```

Emits:

```js
const emit = defineEmits(["refresh"]);
```

- [ ] **Step 4: Replace graph section in `App.vue`**

Render:

```vue
<GitGraphView
  v-if="activeView === 'graph'"
  :commits="view.commits"
  :repo-name="repoName"
  :branch="summary?.branch || 'main'"
  :graph-error="view.graphError"
  :labels="zh"
  @refresh="loadGraph"
/>
```

- [ ] **Step 5: Run tests**

Run:

```powershell
npm test -- test/graph-layout.test.mjs test/ui-structure.test.mjs
```

Expected: PASS.

---

## Chunk 4: Rail and View Splits

### Task 4: Split Rail, Workflow, and Settings Views

**Files:**
- Create: `src/components/Rail.vue`
- Create: `src/views/WorkflowView.vue`
- Create: `src/views/SettingsView.vue`
- Modify: `src/App.vue`
- Modify: `test/ui-structure.test.mjs`

- [ ] **Step 1: Add failing boundary assertions**

Update `test/ui-structure.test.mjs`:

```js
const rail = await readFile(path.join(root, "src", "components", "Rail.vue"), "utf8");
const workflowView = await readFile(path.join(root, "src", "views", "WorkflowView.vue"), "utf8");
const settingsView = await readFile(path.join(root, "src", "views", "SettingsView.vue"), "utf8");

assert.match(rail, /class="rail"/);
assert.match(workflowView, /class="commit-card"/);
assert.match(settingsView, /class="settings-page"/);
assert.doesNotMatch(app, /class="commit-card"/);
assert.doesNotMatch(app, /class="settings-page"/);
```

- [ ] **Step 2: Run structure test to verify failure**

Run: `npm test -- test/ui-structure.test.mjs`

Expected: FAIL because markup still lives in `App.vue`.

- [ ] **Step 3: Create `Rail.vue`**

Move rail template. Props include connection/config/setup/theme/current view/collapsed state. Emits:

- `select-view`
- `toggle-theme`
- `toggle-rail`

- [ ] **Step 4: Create `WorkflowView.vue`**

Move workflow/status/log/output sections. Props include summary/status/files/sections/blockers/recovery/details/logs/busy/canCommit/canPush/block reasons. Emits:

- `inspect`
- `create-recovery`
- `ai-sync`
- `ai-commit`
- `ai-push`
- `suggest-message`

Keep file selection and commit message local to this view when practical. Emit commit payload upward.

- [ ] **Step 5: Create `SettingsView.vue`**

Move settings tabs and form. Keep settings tab state local. Use `settings-model.js` for form setup/payload. Emit `save-settings` with payload.

- [ ] **Step 6: Simplify `App.vue`**

`App.vue` should retain global state and handlers only. It should import and render `Rail`, `WorkflowView`, `GitGraphView`, and `SettingsView`.

- [ ] **Step 7: Run tests**

Run:

```powershell
npm test -- test/ui-structure.test.mjs
npm test
```

Expected: PASS.

---

## Chunk 5: CSS Boundary

### Task 5: Move Git Graph CSS

**Files:**
- Create: `src/styles/graph.css`
- Modify: `src/styles.css`
- Modify: `src/main.js`
- Modify: `test/ui-structure.test.mjs`

- [ ] **Step 1: Add failing CSS boundary assertions**

Update `test/ui-structure.test.mjs`:

```js
const graphCss = await readFile(path.join(root, "src", "styles", "graph.css"), "utf8");
assert.match(graphCss, /\.git-graph-list/);
assert.doesNotMatch(css, /\.git-graph-list/);
```

- [ ] **Step 2: Run structure test to verify failure**

Run: `npm test -- test/ui-structure.test.mjs`

Expected: FAIL because graph styles are still in `styles.css`.

- [ ] **Step 3: Move graph CSS**

Move these selectors to `src/styles/graph.css`:

- `.graph-page`
- `.graph-toolbar`
- `.git-graph-list`
- `.graph-titlebar`
- `.graph-refresh`
- `.graph-branchbar`
- `.graph-body`
- `.graph-sidebar`
- `.commit-list`
- `.commit-row`
- `.commit-lanes`
- `.mainline`
- `.branchline`
- `.merge-join`
- `.branch-split`
- `.node`
- `.commit-main`
- `.commit-title`
- `.subject`
- `.branch`
- `.commit-author`
- `.avatar`
- `.commit-hash`
- `.commit-date`
- theme-light graph toolbar overrides

- [ ] **Step 4: Import graph CSS**

Update `src/main.js`:

```js
import "./styles.css";
import "./styles/graph.css";
```

- [ ] **Step 5: Run tests and build**

Run:

```powershell
npm test -- test/ui-structure.test.mjs
npm test
npm run build
```

Expected: PASS.

---

## Chunk 6: Browser Verification

### Task 6: Smoke Test the Refactor

**Files:**
- No source changes expected.
- Artifacts: `output/playwright/*.png`

- [ ] **Step 1: Confirm server identity**

Run:

```powershell
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:19347/api/health).Content
```

Expected repoPath: `E:\Project\SelfHtml\git_safe_commit_tool`.

- [ ] **Step 2: Browser smoke**

Use Playwright to verify:

- workflow page renders
- Git tree page renders
- settings page renders
- light/dark toggle works
- rail collapse works
- Git graph still has no `graph-card`
- merge graph support remains covered by unit tests

- [ ] **Step 3: Final quality gates**

Run:

```powershell
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 4: Report**

Final report should include:

- files changed
- behavior preserved
- tests/build/browser evidence
- any remaining risk
