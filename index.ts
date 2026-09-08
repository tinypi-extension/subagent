/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Two activation branches (herdr-native migration, Phase 5):
 *
 *   - Inside herdr (HERDR_ENV=1 + HERDR_PANE_ID + HERDR_SOCKET_PATH) AND the
 *     explicit opt-in ("subagent": { "herdr": true } in global settings.json):
 *     the `subagent` tool is fire-and-forget — it launches the subagent as a
 *     herdr plugin pane (~1s ack) and the result is delivered later as a
 *     `subagent_result` / `subagent_ping` steer message. Also registers
 *     `subagent_resume`, `subagent_interrupt`, and `subagents_list`.
 *   - Otherwise (outside herdr, or `subagent.herdr` not true): the original
 *     blocking tool, byte-identical in behavior to the pre-migration extension
 *     (single + parallel, one tool result).
 *
 * Steer-message renderers are registered in BOTH branches so past-session
 * entries replay correctly wherever the session is opened.
 *
 * This entry point is intentionally thin: it wires load-time state and picks
 * a branch. Implementation lives in modules to keep this file small:
 *   - src/dispatch.ts       - execute orchestration (single/parallel) — fallback
 *   - src/run.ts            - spawning and parsing individual subagent processes
 *   - src/render.ts         - TUI rendering for calls and results
 *   - src/format.ts         - formatting / output helpers
 *   - src/types.ts          - shared types and constants
 *   - src/agents.ts         - agent discovery and configuration
 *   - src/profiles.ts       - profile loading and resolution
 *   - src/launch.ts         - herdr launch planning (artifacts + wrapper script)
 *   - src/watcher.ts        - per-subagent lifecycle classification
 *   - src/messages.ts       - outcome → steer message builders + renderers
 *   - src/advert.ts         - load-time profiles/agents advertising context
 *   - src/tool-schemas.ts   - shared TypeBox parameter schemas
 *   - src/blocking.ts       - the legacy blocking `subagent` tool
 *   - src/herdr-tools/*.ts  - the herdr branch (spawn/resume/interrupt/list,
 *                             shared runtime state, registration)
 *
 * The herdr branch ports pi-herdr-subagents/index.ts (orchestrator part):
 * /reload safety, runtime-deps test seam, capability check, event-stream
 * singleton, watcher arming, and the three auxiliary tools.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildAdvertContext } from "./src/advert.ts";
import { registerBlockingTool } from "./src/blocking.ts";
import { isHerdrEnabled, isInsideHerdr } from "./src/herdr-tools/guard.ts";
import { registerHerdrBranch } from "./src/herdr-tools/registration.ts";
import { resolveInterruptTarget } from "./src/herdr-tools/interrupt.ts";
import { resolveResumeOutcome } from "./src/herdr-tools/resume.ts";
import * as runtime from "./src/herdr-tools/runtime.ts";

/** Absolute path of this module — used to detect losing the tool-registry race. */
const MODULE_PATH = fileURLToPath(import.meta.url);

// /reload re-imports this entry, but src/herdr-tools/runtime.ts is module-cached
// and survives with its watchers, event stream, and abort controller still live.
// Re-arm on every import so the previous module's watchers are aborted and its
// event stream is closed before anything new is armed.
runtime.rearm();
runtime.setModulePath(MODULE_PATH);

// Baked once at load time: profile + agent names advertised in tool
// descriptions and parameter hints (see src/advert.ts).
const advert = buildAdvertContext();

export default function (pi: ExtensionAPI) {
	// Herdr branch requires BOTH the herdr environment (panes to launch into)
	// AND the explicit opt-in (`"subagent": { "herdr": true }` in settings.json).
	// Anything else falls back to the blocking tool.
	if (isInsideHerdr() && isHerdrEnabled()) {
		registerHerdrBranch(pi, advert);
		return;
	}

	// Outside herdr: the original blocking tool, registered exactly as before
	// the herdr migration (single + parallel, one blocking result).
	registerBlockingTool(pi, advert);
}

// Public surface kept on the entry point (importers and tests rely on it).
export { isInsideHerdr, isHerdrEnabled } from "./src/herdr-tools/guard.ts";
export { resolveInterruptTarget } from "./src/herdr-tools/interrupt.ts";

// ── test seam ───────────────────────────────────────────────────────────────

export const __test__ = {
	isInsideHerdr,
	runningSubagents: runtime.runningSubagents,
	resolveInterruptTarget,
	resolveResumeOutcome,
	versionAtLeast: runtime.versionAtLeast,
	modulePath: MODULE_PATH,
	setDeps(overrides: Partial<runtime.RuntimeDeps>): void {
		runtime.setDeps(overrides);
	},
	reset(): void {
		runtime.resetForTests();
	},
};
