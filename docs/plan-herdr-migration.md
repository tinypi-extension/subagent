# Plan: herdr-native migration of the subagent extension

**Goal.** Make `~/.pi/agent/extensions/subagent` herdr-native: inside herdr (`HERDR_ENV` + `HERDR_PANE_ID` + `HERDR_SOCKET_PATH`), subagents launch as herdr plugin panes, spawn returns a ~1s ack, and completion arrives as `subagent_result` / `subagent_ping` steer messages with truthful lifecycle classification. Outside herdr, the current blocking single/parallel subprocess behavior is kept unchanged. Chain mode, fork/lineage session modes, `/iterate`, `/subagents-init`, the orchestrator status widget, and stall detection are removed/not ported. Per `docs/intent/herdr-migration.md`, implementing exactly the `CORE_PRINCIPLE.md` contracts (`.exit`/`.exitcode` sidecar shapes, steer `customType`s, `PI_SUBAGENT_*` env names — port verbatim, do not rename).

## Module-by-module port map

| Target file (`pi-herdr-subagents-main`) | Destination (this repo) | Adaptations |
|---|---|---|
| `src/herdr/client.ts` | `src/herdr/client.ts` | Verbatim; pure `node:child_process`. No imports to rename. Keep `HERDR_PLUGIN_ID = "pi-herdr-subagents"` (load-bearing — must match `herdr-plugin.toml`). |
| `src/herdr/events.ts` | `src/herdr/events.ts` | Verbatim; pure `node:net`. Re-verify `events.subscribe` protocol on herdr 0.8.2 (target verified 0.7.1). |
| `src/context-usage.ts` | `src/context-usage.ts` | Verbatim; pure fs. Sidecar shape is a contract. |
| `src/runtime-state.ts` | `src/runtime-state.ts` | Verbatim; Symbol-keyed globalThis Set. |
| `herdr-plugin/herdr-plugin.toml` + `dispatch.sh` | `herdr-plugin/` (repo root of the extension) | Copy **verbatim** including plugin id `pi-herdr-subagents`, `min_herdr_version = "0.8.2"`, `$HERDR_PLUGIN_ROOT/dispatch.sh` command, exit 64/66 dispatcher. No code changes. |
| `src/agents.ts` | `src/agent-defs.ts` (new) | Port the **frontmatter parser** (`parseAgentDefinition`) and launch-behavior resolvers, but: (a) use `parseFrontmatter` from `@earendil-works/pi-coding-agent` instead of regex (matches current repo's agents.ts behavior, more robust); (b) accept an injectable directory list so the herdr path reuses the **kept** discovery (`agents.ts`: `getAgentDir()`/`CONFIG_DIR_NAME` dirs, `AgentScope`); (c) make `resolveLaunchBehavior` standalone-only (see below); (d) keep `resolveDenyTools`, `resolveEffectiveInteractive`, `resolveSubagentPaths`, `getDefaultSessionDirFor`, `loadAgentDefaults`, `getAgentConfigDir`. |
| `src/launch.ts` | `src/launch.ts` (new) | Port `shellEscape`, `buildSubagentToolAllowlist`, `buildPiPromptArgs`, `getArtifactDir`, `buildWrapperScript`, `buildLaunchPlan`, `buildResumeLaunchPlan`, `resolveResumeLaunchBehavior` with these changes: (1) **thinking**: target emits `--model model:thinking`; this runtime's CLI uses a separate `--thinking` flag (see run.ts) → emit `--model X --thinking Y` as two argv entries; add `thinking?: string` to `SubagentLaunchParams` so **profiles** can inject it. (2) **No fork/lineage**: remove `seedSession` from `LaunchPlan`, always `taskDelivery: "artifact"`, remove `inheritsConversationContext`; a `session-mode: lineage/fork` frontmatter value is ignored (treated as standalone). (3) Import agent helpers from `./agent-defs.ts`. (4) Everything else (curated env exports, direnv wrap, `PI_HERDR_LAUNCH_PREFIX`, hold-open, run-id-stamped exitcode sidecar) verbatim. |
| `src/session.ts` | `src/session.ts` (new, trimmed) | Port **only** `getNewEntries`, `findLastAssistantMessage`, `getSessionId` (needed by watcher/messages). Drop `seedSubagentSessionFile`/`getForkContentLines`/`getLeafId` (fork/lineage removed). ⚠ Verify the entry shape (`{type:"message", message:{role,content}}`) against this runtime's session-manager output; adapt parsing if it differs. |
| `src/watcher.ts` | `src/watcher.ts` (new) | Verbatim port (pure node + injected deps). The classification matrix, stale-sidecar guard, run-id ownership, 5s poll, 15s startup window, `fs.watch`, reconcile hook are all load-bearing. |
| `src/messages.ts` | `src/messages.ts` (new) | Port `buildOutcomeMessage`, `formatElapsed`, `resolveResultPresentation`, `paneOutputSection`, `renderSubagentResult`, `renderSubagentPing`, `SubagentSteerMessage`. Import renames: `Box`/`Text` from `@earendil-works/pi-tui`, `keyHint` from `@earendil-works/pi-coding-agent` (verified exported). Steer `customType`s verbatim. |
| `subagent-done.ts` | `subagent-done.ts` (rewrite in place) | Port with renames (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`). `ctx.getContextUsage()` returns `ContextUsage \| undefined` (target code already tolerates; `ContextUsage{tokens,contextWindow,percent}` shape matches exactly). Keep `subagent_done`/`caller_ping` tools, auto-exit-on-agent-end logic, nested-subagent hold (`getActiveSubagentCount`), `.exit` byte-shape, and the child identity widget (Ctrl+J) — the widget being dropped is the **orchestrator** status widget, not this child identity widget. `registerShortcut`, `ctx.shutdown()` verified present. |
| `index.ts` (target) | `index.ts` (restructured, in place) | Port into the herdr branch: `isInsideHerdr`, /reload safety (Symbol.for abort/stream keys), runtime-deps seam, `checkHerdrCapability`/`ensureHerdrCapability`, `armWatcher` → `pi.sendMessage(msg, {triggerTurn: true, deliverAs: "steer"})`, `subagent_resume`, `subagent_interrupt`, `subagents_list`, self-spawn block, registry-race warning. **Not ported:** widget (`renderSubagentWidgetLines`, refresh interval, `refreshWidgetStatuses`), `/iterate`, `/subagents-init`, `/subagent` command (not in the intent's port surface), setup-hint stubs (this extension always provides the fallback tool outside herdr, so "no other provider" stubs are moot). |
| Target tests | `test/herdr-client.test.ts`, `test/herdr-events.test.ts`, `test/context-usage.test.ts` (new), `test/runtime-state.test.ts` (new), `test/launch.test.ts`, `test/session.test.ts`, `test/watcher.test.ts`, `test/messages.test.ts`, `test/subagent-done.test.ts`, `test/herdr-tools.test.ts` | Adapted to `node --test --import tsx` convention; imports rewritten to `@earendil-works/*` / `typebox`; launch/session tests updated for no-seed, two-flag thinking. |
| Kept unchanged | `agents.ts`, `profiles.ts`, `format.ts`, `render.ts` (minus chain bits), `run.ts`, `types.ts` (minus chain), `dispatch.ts` (minus chain) | Fallback path stays as-is through Phases 1–5. |

## Phased task list

> Every phase ends with: `npm run typecheck` + `node --test --import tsx test/*.test.ts` green, and the fallback (outside-herdr) spawn of one agent still returns a single blocking tool result.

### Phase 0 — Pre-flight contract verification (no code changes)
1. Run `pi --help` and confirm child-CLI flags used by the launch script exist in **this** runtime: `--session <file>`, `-e <file>`, `--tools a,b`, `--system-prompt <file>`, `--append-system-prompt <file>`, `--thinking <level>`, and that a positional task / `@<file>` message arg works. Record findings in a comment at the top of `src/launch.ts` when it lands.
2. Confirm `herdr status server --json` reports `running:true, version >= 0.8.2` with the default socket `~/.config/herdr/herdr.sock`.
3. Write one throwaway node script (or REPL check) printing a session `.jsonl` produced by this pi runtime to confirm entry shape for `getNewEntries`/`findLastAssistantMessage`.
- **Files touched:** none (findings go into Phase 2 code comments).
- **Tests:** run existing suite; all 4 test files green.
- **Fallback green:** unchanged code; suite passes.

### Phase 1 — Herdr leaf modules (zero coupling, fallback untouched)
1. Create `src/herdr/client.ts`, `src/herdr/events.ts` — verbatim ports.
2. Create `src/context-usage.ts`, `src/runtime-state.ts` — verbatim ports.
3. Copy `herdr-plugin/` (toml + dispatch.sh) verbatim into the extension root.
4. Add tests: port `test/herdr-client.test.ts`, `test/herdr-events.test.ts` (inject fake `exec`/socket), write small `context-usage`/`runtime-state` tests; port `plugin.test.ts` as a manifest test (id, entrypoints, min version, dispatch.sh error codes).
- **Files touched:** `src/herdr/client.ts`, `src/herdr/events.ts`, `src/context-usage.ts`, `src/runtime-state.ts`, `herdr-plugin/*`, new tests.
- **Tests added/run:** herdr-client, herdr-events, context-usage, runtime-state, plugin. Full suite run.
- **Fallback green:** nothing imports these from the fallback path; existing tests untouched and passing.

### Phase 2 — Launch planning (pure module + agent-defs)
1. Create `src/agent-defs.ts`: port `parseAgentDefinition` (via `parseFrontmatter`), `AgentDefaults`, `resolveDenyTools`, `resolveEffectiveInteractive`, `resolveSubagentPaths`, `getDefaultSessionDirFor`, `loadAgentDefaults`, `getAgentConfigDir` (respect `PI_CODING_AGENT_DIR`; cross-check with the runtime's `getAgentDir()` and use the runtime's if they can diverge). Add `resolveLaunchBehaviorStandalone(params, agentDefs) → { taskDelivery: "artifact" }` — no fork/lineage; keep parsing `session-mode` but ignore non-standalone values.
2. Create `src/launch.ts` with the adaptations from the port map (two-flag thinking; add `thinking?: string` to `SubagentLaunchParams`; no `seedSession` in `LaunchPlan`; artifact delivery only; comment recording Phase 0 CLI findings).
3. Port `test/launch.test.ts` adapted: artifact task file + `@`-arg for every launch, `--model X --thinking Y` argv, curated exports (`PI_SUBAGENT_NAME/AGENT/AUTO_EXIT/SESSION/ID/PANE`, `PI_DENY_TOOLS`, `PI_CODING_AGENT_DIR`), direnv wrap + `PI_HERDR_LAUNCH_PREFIX`/`PI_HERDR_DIRENV=0`/`PI_HERDR_PI_BIN`, hold-open block, exitcode sidecar line with run id, deterministic session path, resume plan + `resolveResumeLaunchBehavior`.
- **Files touched:** `src/agent-defs.ts`, `src/launch.ts`, `test/agent-defs.test.ts`, `test/launch.test.ts`.
- **Tests added/run:** agent-defs (frontmatter fields incl. `deny-tools`, `spawning`, `cli: claude` rejection), launch. Full suite run.
- **Fallback green:** no existing module imports the new files; suite passes.

### Phase 3 — Session summaries + watcher
1. Create `src/session.ts` (trimmed: `getNewEntries`, `findLastAssistantMessage`, `getSessionId`; shape from Phase 0).
2. Create `src/watcher.ts` — verbatim port (`RunningSubagent`, `SubagentOutcome`, `WatcherDeps`, `watchSubagent`, classification matrix, stale-sidecar guard, run-id ownership, poll/reconcile, abort).
3. Port `test/watcher.test.ts` (fake client + stream; assert each lifecycle row: done, ping, user-exit, launch-failed incl. heldOpen, crashed, pane-killed, gap-exit, cancelled; stale-sidecar and foreign-run-id guards; sidecar consumption).
4. Port `test/session.test.ts` for the three kept helpers.
- **Files touched:** `src/session.ts`, `src/watcher.ts`, `test/session.test.ts`, `test/watcher.test.ts`.
- **Tests added/run:** session, watcher. Full suite run.
- **Fallback green:** herdr-only modules, not imported by fallback; suite passes.

### Phase 4 — Steer messages + child extension
1. Create `src/messages.ts` per port map (contracts verbatim: `customType` `"subagent_result"`/`"subagent_ping"`, `details` shape incl. `disposition`, `deliverAs: "steer"` at the call site).
2. Rewrite `subagent-done.ts` in place with renames; keep `writeExitSidecar` byte-shapes, auto-exit logic, `caller_ping`/`subagent_done`, child widget, `snapshotContextUsage`.
3. Port `test/messages.test.ts` (each outcome → expected content/details/null-for-cancelled) and `test/subagent-done.test.ts` (sidecar shapes, auto-exit decision table incl. last-message-user retry guard and `activeSubagentCount > 0` hold, denied-tools parse).
- **Files touched:** `src/messages.ts`, `subagent-done.ts`, `test/messages.test.ts`, `test/subagent-done.test.ts`.
- **Tests added/run:** messages, subagent-done. Full suite run.
- **Fallback green:** `subagent-done.ts` only loads into children (`-e`), never in the orchestrator's fallback flow; suite passes.

### Phase 5 — Orchestrator herdr branch in `index.ts`
1. Restructure `index.ts`: keep all module-load-time profile/agent advertisement for the fallback tool; add `isInsideHerdr()`; `export default` branches: inside herdr → register herdr tools; outside → register the current blocking tool exactly as today.
2. Add shared herdr infra to `index.ts` (ported): /reload Symbol-keyed abort/stream cleanup, `RuntimeDeps` seam + `__test__.setDeps/reset`, capability check (`ping` + version ≥ 0.8.2 + `pluginGet`), `getEventStream` singleton, `armWatcher` wiring to `pi.sendMessage(..., {triggerTurn: true, deliverAs: "steer"})`.
3. Port `executeSubagentSpawn` **merged with kept behavior**: per-call `discoverAgents(ctx.cwd, agentScope)` + `loadProfilesIfEnabled` + `resolveProfile` (profile > agent def > parent defaults); resolved model/thinking flow into `buildLaunchPlan` (`model`, `thinking` params). Param schema: current schema (`agent`, `task`, `tasks[]` with per-task `profile`, `agentScope`, `confirmProjectAgents`, `cwd`) extended with `name?` (default = agent name or "Subagent"), plus target's optional `model/tools/systemPrompt/interactive`. Parallel fan-out = N async spawns, each returning its own ack; results arrive as separate steers. Self-spawn block via `PI_SUBAGENT_AGENT`. Fire-and-forget description (no polling, no fabrication).
4. Port `subagent_resume` (sidecar rm before launch, re-scoped summary via `resolveResumeOutcome`), `subagent_interrupt` (`resolveInterruptTarget` + `paneSendKeys(["esc"])`), `subagents_list` (backed by the **kept** discovery, honoring `agentScope`).
5. `session_start`: registry-race warning inside herdr (`getAllTools()` → `sourceInfo.path` vs `MODULE_PATH`); `session_shutdown`: abort watchers, close stream. Register `subagent_result`/`subagent_ping` renderers via `pi.registerMessageRenderer` in both branches (past-session rendering).
6. Add `test/herdr-tools.test.ts`: fake deps → spawn ack details, plan files written, watcher armed; self-spawn block; capability failure → error result; interrupt resolution (id/unique name/ambiguous); resume clears sidecars; `isInsideHerdr` env matrix; renderer registration.
- **Files touched:** `index.ts`, `test/herdr-tools.test.ts` (new), minor `types.ts` additions if needed (e.g. herdr details types).
- **Tests added/run:** herdr-tools. Full suite run — **all existing tests (agents, dispatch, profiles, run) must still pass unchanged**, proving the fallback branch is untouched.
- **Fallback green:** outside herdr, the registered tool is byte-identical in behavior to today (single + parallel, blocking, chain still present until Phase 6).

### Phase 6 — Remove chain mode (both paths)
1. `dispatch.ts`: delete the chain branch and `{previous}` plumbing; `modeCount` logic → single/parallel only.
2. `index.ts`: remove `chain` from `SubagentParams`, `ChainItem`, and the tool description; `types.ts`: remove `"chain"` from `SubagentDetails.mode`; `render.ts`: delete chain rendering.
3. Update `test/dispatch.test.ts`: **delete chain cases deliberately** (the only intentional change to existing tests — record in commit message); keep/adjust mode-validation tests ("exactly one mode" now single/parallel).
4. Update `README.md` (remove chain mentions) and note the removal in `docs/intent/` addendum if desired.
- **Files touched:** `dispatch.ts`, `index.ts`, `types.ts`, `render.ts`, `test/dispatch.test.ts`, `README.md`.
- **Tests:** full suite green with updated dispatch tests.
- **Fallback green:** single + parallel blocking behavior verified by the remaining dispatch/run tests.

### Phase 7 — Plugin install + end-to-end verification
1. Link the plugin (user-visible step; put it in README): `herdr plugin link "/Users/tinyphat/.pi/agent/extensions/subagent/herdr-plugin" --enabled`, then `herdr plugin enable pi-herdr-subagents`. Verify: `herdr plugin list --plugin pi-herdr-subagents --json` shows the plugin enabled; `herdr status server --json` shows ≥ 0.8.2. (herdr writes its plugin registry under its config root; the default socket `~/.config/herdr/herdr.sock` is used automatically — no `HERDR_SOCKET_PATH` override needed.)
2. Manual E2E inside a herdr pane (orchestrator pi in herdr): spawn → ack ~1s, pane splits right, child runs `subagent-done.ts`; `subagent_done` → `completed` steer with summary; `caller_ping` → `subagent_ping` steer; bad `--model` → `launch-failed` with launch-script path (+ held-open pane); `kill` the pane → `pane-killed`; quit child pi → `completed-user-exit`; `subagent_resume` → new pane, new-entries-only summary; `subagent_interrupt` → local ack, child keeps running; `subagents_list` honors scopes. Run one launch script by hand: `bash <artifacts>/subagent-scripts/<name>-<id>.sh`.
3. Manual E2E outside herdr: single + parallel blocking results, one tool result, profiles still applied.
4. Final: `npm run typecheck` && `node --test --import tsx test/*.test.ts`.
- **Files touched:** `README.md` (install section). No code.
- **Fallback green:** step 3.

## Risks / API-mismatch register

- **Import renames (mechanical, all ports):** `@mariozechner/pi-coding-agent` → `@earendil-works/pi-coding-agent`; `@mariozechner/pi-tui` → `@earendil-works/pi-tui`; `@sinclair/typebox` → `typebox`.
- **Verified present in this runtime** (checked `dist/*.d.ts`): `sendMessage` with `triggerTurn` + `deliverAs:"steer"`, `registerMessageRenderer`, `promptSnippet`, `promptGuidelines`, `registerCommand`, `registerShortcut`, `getAllTools()` → `ToolInfo.sourceInfo`, `ctx.ui.notify` / `ui.setWidget(key, content, {placement})`, `ctx.sessionManager.getSessionFile()/getSessionId()/getSessionDir()`, `ctx.shutdown()`, `ctx.getContextUsage()`, `keyHint`, `Box`/`Text`/`Markdown` in pi-tui, `parseFrontmatter`, `getAgentDir`, `CONFIG_DIR_NAME`.
- **`getSessionFile()` returns `string | undefined` here** (target assumed `string | null`) — adjust null checks in spawn/resume.
- **`--model model:thinking` colon syntax not assumed** — emit separate `--model`/`--thinking`; confirmed this repo's run.ts already uses `--thinking`. Phase 0 verifies.
- **Child CLI flags unverified** (`--session`, `-e <ts file>`, `--system-prompt` file auto-detect, `@file` positional) — Phase 0 gate; all of Phase 2's argv depends on it. Also confirm children can load `.ts` extensions (this runtime already loads this `.ts` extension, so expected yes).
- **Session `.jsonl` entry shape** consumed by `getNewEntries`/`findLastAssistantMessage` — verify against this runtime's session manager (Phase 0/3); parsers are small and adaptable, but the summary extraction must match.
- **Chain-mode test deletions** are the only intentional edits to existing tests; everything else in `test/*.test.ts` must pass unmodified.
- **Registry race:** target resolves collisions "first loaded wins". Outside herdr we always own the fallback tool (stub logic dropped). Inside herdr, keep the visible warning via `sourceInfo.path !== MODULE_PATH`; if `sourceInfo.path` is unavailable for some tool types, degrade to name-based detection without failing.
- **Nested orchestration is by design:** children run inside herdr panes, so the child's own copy of this extension activates its herdr branch; `runtime-state.ts` keeps a child pi alive while its own children run, and `PI_SUBAGENT_AGENT` blocks self-spawn. Do not "fix" this by hiding tools in children.
- **Load-bearing contracts — never rename:** steer `customType`s; `.exit` JSON byte-shapes (`{"type":"done"}`, `{"type":"ping","name","message"}`); `.exitcode` = `"<code> <run-id>"`; `PI_SUBAGENT_*` / `PI_HERDR_*` env names; `PI_HERDR_LAUNCH_SCRIPT`; plugin id `pi-herdr-subagents` + entrypoints `subagent`/`argv`.
- **events.subscribe has no replay** — the watcher's reconcile hook + 5 s poll are the safety net; do not simplify them away.
- **herdr 0.8.2 specifics:** plugin split panes require ≥ 0.8.2 (enforced at capability check); `pane.exited` carries no exit code — the `.exitcode` sidecar is the only exit-code source; re-verify the ndJSON event shapes on 0.8.2 during Phase 7 E2E.
- **Do not add:** widget, `/subagent` command, `/iterate`, `/subagents-init`, stall detection, tmux/zellij, `docs/full-socket-client.md` all-socket client.

## Final verification checklist

- [ ] `npm run typecheck` clean.
- [ ] `node --test --import tsx test/*.test.ts` — all green (existing agents/dispatch/profiles/run tests intact except deliberate chain-case deletions).
- [ ] Outside herdr: single spawn and parallel fan-out each return one blocking tool result; profiles + agentScope + confirmProjectAgents behave as before; no herdr tools registered.
- [ ] No `chain` anywhere in params/dispatch/render/tests/docs.
- [ ] Inside herdr: spawn ack ≈ 1 s; `subagent_result` steer per child (completed / completed-user-exit / launch-failed / crashed / pane-killed / gap-exit); `subagent_ping` steer; `cancelled` emits no steer.
- [ ] `.exit` sidecar byte-shapes match the contract exactly; `.exitcode` stamped with run id; watcher consumes sidecars on resolution.
- [ ] `subagent_resume` (sidecars cleared, new-entries-only summary), `subagent_interrupt` (esc, no steer), `subagents_list` all work.
- [ ] Profiles flow into herdr children as `--model`/`--thinking` in the generated launch script.
- [ ] Plugin linked+enabled (`herdr plugin list --plugin pi-herdr-subagents --json`), capability warning appears if unlinked; setup errors stop before artifacts/panes are created.
- [ ] Curated env only (no full env dump); direnv wrap honors `PI_HERDR_LAUNCH_PREFIX`/`PI_HERDR_DIRENV=0`/`PI_HERDR_PI_BIN`; `trap '' TSTP` present; hold-open only on startup crash.
- [ ] No fork/lineage seeding, no `/iterate`, `/subagents-init`, orchestrator widget, stall detection, or tmux/zellij code remains.
