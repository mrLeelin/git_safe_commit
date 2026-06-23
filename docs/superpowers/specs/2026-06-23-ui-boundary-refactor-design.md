# UI Boundary Refactor Design

Date: 2026-06-23

## Goal

Reduce complexity in the git-safe-commit browser tool without changing framework
or behavior. The current Vue app works, but `App.vue` and `styles.css` have become
too broad. The refactor should split display, client data access, and server data
logic into clear boundaries so the system remains maintainable as workflow,
settings, and Git graph behavior grow.

## Chosen Approach

Use a component/view split with local responsibilities, no router, no Pinia, and
no new UI framework.

`App.vue` remains the application shell and global coordinator. It owns:

- initial loading
- SSE lifecycle
- current view
- topbar labels
- theme and rail collapsed state
- calls into the client API layer

Feature views own their local UI and emit commands upward. They do not call
`fetch()` directly.

## Client Boundaries

### Client Data Layer

Add `src/client/api.js`.

It owns browser-to-server calls:

- `loadConfig()`
- `loadState()`
- `loadAiInstallations()`
- `loadGraph()`
- `runAction(action, payload)`
- `saveSettings(config)`
- `suggestMessage(payload)`
- `openEvents(handlers)`

Vue files should not hardcode `/api/...` paths after this refactor.

### Display Layer

Add these display components:

- `src/components/Rail.vue`
- `src/views/WorkflowView.vue`
- `src/views/GitGraphView.vue`
- `src/views/SettingsView.vue`

Display components receive props and emit events. They do not own server data
access.

`GitGraphView.vue` keeps rendering the Git history UI and uses
`buildCommitGraphRows()` from `src/graph-layout.js`. It must preserve:

- linear history as a single main line
- merge commits with temporary branch lines, split lines, and join lines
- no `graph-card` nested shell

`SettingsView.vue` uses `settings-model.js` for form mapping and payload
construction.

## Server Boundaries

Add `lib/git-graph.mjs`.

It owns:

- graph Git command arguments
- `getGitGraph(repoPath)`
- `parseCommitGraph(stdout)`
- `parseRefs(refs)`

`server.mjs` should become thinner: HTTP route wiring, config updates, SSE, and
error handling. It should not directly build Git graph commands or parse commit
graph lines.

Keep existing server modules otherwise:

- `lib/config.mjs`
- `lib/git-state.mjs`
- `lib/workflow-runner.mjs`
- `lib/git-executor.mjs`

Do not rewrite workflow behavior in this pass.

## Styling Boundaries

Split Git graph styles into `src/styles/graph.css`.

This pass may keep the rest of `src/styles.css` intact. The immediate win is
moving the most specialized visual subsystem out of the global stylesheet while
preserving current appearance.

Future follow-up can split:

- `rail.css`
- `workflow.css`
- `settings.css`
- `base.css`

## Event Contracts

Views emit events upward instead of mutating global state:

- `inspect`
- `create-recovery`
- `ai-sync`
- `ai-commit`
- `ai-push`
- `suggest-message`
- `load-graph`
- `save-settings`
- `select-view`
- `toggle-theme`
- `toggle-rail`

`App.vue` maps these events to client API calls and state updates.

## Testing Plan

Preserve behavior with tests before and during the split.

Add/update tests:

- `test/git-graph.test.mjs`: graph command construction and parsing.
- `test/graph-layout.test.mjs`: keep merge/rebase visual layout coverage.
- `test/ui-structure.test.mjs`: verify boundaries:
  - `App.vue` does not contain `git-graph-list`.
  - `GitGraphView.vue` contains Git graph structure.
  - `App.vue` does not hardcode `/api/git/graph`.
  - `src/client/api.js` owns API paths.
  - old `graph-card` structure remains absent.

Run:

- `npm test -- test/git-graph.test.mjs test/graph-layout.test.mjs test/ui-structure.test.mjs`
- `npm test`
- `npm run build`

Use browser smoke verification on `http://127.0.0.1:19347` after implementation.

## Constraints

- Do not change framework.
- Do not introduce a router or shared store.
- Do not change workflow behavior.
- Do not sweep unrelated dirty files.
- Keep each move behavior-preserving and test-backed.

## Success Criteria

- `App.vue` is materially smaller and acts as the shell/coordinator.
- Server Git graph logic lives in `lib/git-graph.mjs`.
- Client API paths live in `src/client/api.js`.
- Git graph rendering lives in `GitGraphView.vue`.
- Tests and build pass.
- Browser smoke confirms workflow, settings, and Git graph still switch and render.
