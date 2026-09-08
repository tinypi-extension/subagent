// Shared mutable runtime state + lifecycle for the herdr branch.
//
// Phase A2: extracted from index.ts. The state lives at MODULE scope (not
// globalThis): pi re-imports index.ts on /reload while this module stays
// cached, so index.ts calls rearm() at load time to abort the previous
// module's watchers and close its event stream.

import * as path from "node:path";
import {
	consumeContextUsageSidecar,
} from "../context-usage.ts";
import {
	createHerdrClient,
	HERDR_PLUGIN_ID,
	MIN_HERDR_VERSION,
	type HerdrClient,
} from "../herdr/client.ts";
import { createHerdrEventStream } from "../herdr/events.ts";
import { markSubagentActive, markSubagentInactive } from "../runtime-state.ts";
import { buildOutcomeMessage } from "../messages.ts";
import {
	watchSubagent,
	type RunningSubagent,
	type SubagentOutcome,
	type WatcherDeps,
} from "../watcher.ts";
import type { SteerSender } from "./common.ts";

export type WatcherStream = WatcherDeps["stream"] & { close(): void };

export interface RuntimeDeps {
	client: HerdrClient;
	watch: typeof watchSubagent;
	createStream: (socketPath: string, signal: AbortSignal) => WatcherStream;
}

export function defaultDeps(): RuntimeDeps {
	return {
		client: createHerdrClient(),
		watch: watchSubagent,
		createStream: (socketPath, signal) => createHerdrEventStream({ socketPath, signal }),
	};
}

let deps: RuntimeDeps = defaultDeps();
let capabilityCheck: Promise<string | null> | null = null;
let currentAbort: AbortController = new AbortController();
let eventStream: WatcherStream | null = null;
let modulePath: string | null = null;

/** All currently running herdr subagents, keyed by launch id. */
export const runningSubagents = new Map<string, RunningSubagent>();

// ── /reload safety ──────────────────────────────────────────────────────────

/**
 * Close the shared event stream and abort the module AbortController (used by
 * /reload re-arming and session_shutdown).
 */
export function closeStreamAndAbort(): void {
	if (eventStream) eventStream.close();
	eventStream = null;
	currentAbort.abort();
}

/**
 * Called by index.ts on every (re-)import: /reload re-imports the entry, giving
 * fresh entry-level state, but closures from the old module keep running. Abort
 * the previous module's controllers and close its event stream on re-import
 * (ported from pi-herdr-subagents).
 */
export function rearm(): void {
	for (const running of runningSubagents.values()) {
		running.abortController?.abort();
		markSubagentInactive(running.id);
	}
	runningSubagents.clear();
	closeStreamAndAbort();
	currentAbort = new AbortController();
}

// ── module path (needed for the registry-race check + plugin dir hint) ───────

export function setModulePath(p: string): void {
	modulePath = p;
}

export function getModulePath(): string | null {
	return modulePath;
}

export function getModuleAbortSignal(): AbortSignal {
	return currentAbort.signal;
}

/**
 * One shared HerdrEventStream per pi process, created lazily on first spawn —
 * no persistent socket while zero subagents have ever run. Closed via the
 * module AbortController on /reload + session_shutdown.
 */
export function getEventStream(): WatcherStream {
	if (!eventStream) {
		eventStream = deps.createStream(process.env.HERDR_SOCKET_PATH ?? "", getModuleAbortSignal());
	}
	return eventStream;
}

// ── capability check ────────────────────────────────────────────────────────

export function versionAtLeast(actual: string, minimum: string): boolean {
	const parse = (value: string): number[] | null => {
		const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
		return match ? match.slice(1).map(Number) : null;
	};
	const actualParts = parse(actual);
	const minimumParts = parse(minimum);
	if (!actualParts || !minimumParts) return false;
	for (let i = 0; i < 3; i += 1) {
		if (actualParts[i] !== minimumParts[i]) return actualParts[i] > minimumParts[i];
	}
	return true;
}

/**
 * The orchestrator cannot launch subagents without the herdr server, a new
 * enough version for plugin split panes, and the linked+enabled plugin.
 * Returns null when capable, otherwise a human-readable setup problem.
 */
async function checkHerdrCapability(): Promise<string | null> {
	const status = await deps.client.ping();
	if (!status.ok) {
		return (
			"the herdr server is not reachable from this pane. " +
			"Is the herdr session still running?"
		);
	}
	if (!status.version || !versionAtLeast(status.version, MIN_HERDR_VERSION)) {
		return (
			`herdr >= ${MIN_HERDR_VERSION} is required for plugin split panes ` +
			`(found ${status.version ?? "unknown"}). Update herdr, then restart its session.`
		);
	}

	const plugin = await deps.client.pluginGet(HERDR_PLUGIN_ID);
	if (!plugin) {
		const pluginDir = path.join(path.dirname(modulePath ?? ""), "herdr-plugin");
		return (
			`the Herdr plugin is not linked. Run: herdr plugin link "${pluginDir}" --enabled`
		);
	}
	if (!plugin.enabled) {
		return `the Herdr plugin is disabled. Run: herdr plugin enable ${HERDR_PLUGIN_ID}`;
	}
	return null;
}

export async function ensureHerdrCapability(): Promise<string | null> {
	const check = (capabilityCheck ??= checkHerdrCapability());
	try {
		const message = await check;
		// Allow an in-place setup fix (link/enable/update) to be detected by the
		// next attempt without requiring a pi reload. Successful checks stay cached.
		if (message && capabilityCheck === check) capabilityCheck = null;
		return message;
	} catch (error) {
		if (capabilityCheck === check) capabilityCheck = null;
		throw error;
	}
}

/** Drop any cached capability result (session_start re-checks readiness). */
export function invalidateCapability(): void {
	capabilityCheck = null;
}

// ── watcher arming + outcome→steer wiring ───────────────────────────────────

export function armWatcher(
	pi: SteerSender,
	running: RunningSubagent,
	opts?: {
		mapOutcome?: (outcome: SubagentOutcome) => SubagentOutcome;
		/** Orchestrator session id, correlated into every outcome message's details. */
		sessionId?: string | null;
	},
): void {
	const watcherAbort = new AbortController();
	running.abortController = watcherAbort;

	const moduleSignal = getModuleAbortSignal();
	const onModuleAbort = () => watcherAbort.abort();
	moduleSignal.addEventListener("abort", onModuleAbort, { once: true });

	runningSubagents.set(running.id, running);
	markSubagentActive(running.id);

	void deps
		.watch(running, {
			client: deps.client,
			stream: getEventStream(),
			signal: watcherAbort.signal,
		})
		.then((outcome) => {
			runningSubagents.delete(running.id);
			markSubagentInactive(running.id);
			const contextUsage =
				outcome.kind === "cancelled"
					? null
					: consumeContextUsageSidecar(running.sessionFile, running.id);
			const message = buildOutcomeMessage(
				running,
				opts?.mapOutcome ? opts.mapOutcome(outcome) : outcome,
				{ contextUsage, sessionId: opts?.sessionId ?? null },
			);
			if (message) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
		})
		.catch((err: any) => {
			runningSubagents.delete(running.id);
			markSubagentInactive(running.id);
			pi.sendMessage(
				{
					customType: "subagent_result",
					content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
					display: true,
					details: { name: running.name, task: running.task, error: err?.message ?? String(err) },
				},
				{ triggerTurn: true, deliverAs: "steer" },
			);
		})
		.finally(() => {
			moduleSignal.removeEventListener("abort", onModuleAbort);
		});
}

// ── injectable runtime deps (unit-test seam) ────────────────────────────────

export function getDeps(): RuntimeDeps {
	return deps;
}

export function setDeps(overrides: Partial<RuntimeDeps>): void {
	deps = { ...deps, ...overrides };
}

export function resetDeps(): void {
	deps = defaultDeps();
}

/** Test seam: return the runtime to a pristine state between cases. */
export function resetForTests(): void {
	resetDeps();
	capabilityCheck = null;
	for (const running of runningSubagents.values()) {
		running.abortController?.abort();
		markSubagentInactive(running.id);
	}
	runningSubagents.clear();
	closeStreamAndAbort();
	currentAbort = new AbortController();
}
