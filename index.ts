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
 * Implementation is split across modules to keep this entry point small:
 *   - dispatch.ts   - execute orchestration (single/parallel) — fallback
 *   - run.ts        - spawning and parsing individual subagent processes
 *   - render.ts     - TUI rendering for calls and results
 *   - format.ts     - formatting / output helpers
 *   - types.ts      - shared types and constants
 *   - agents.ts     - agent discovery and configuration
 *   - profiles.ts   - profile loading and resolution
 *   - src/launch.ts - herdr launch planning (artifacts + wrapper script)
 *   - src/watcher.ts - per-subagent lifecycle classification
 *   - src/messages.ts - outcome → steer message builders + renderers
 *
 * The herdr branch ports pi-herdr-subagents/index.ts (orchestrator part):
 * /reload safety, runtime-deps test seam, capability check, event-stream
 * singleton, watcher arming, and the three auxiliary tools.
 */

import * as path from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents, formatAgentNames } from "./agents.ts";
import { executeDispatch, type DispatchParams } from "./dispatch.ts";
import { formatProfileSummary, isProfilesEnabled, loadProfilesFrom, loadProfilesIfEnabled, resolveProfile, validateProfiles } from "./profiles.ts";
import { renderCall, renderResult, type Theme } from "./render.ts";
import { MAX_LISTED_AGENTS, MAX_PARALLEL_TASKS } from "./types.ts";
import {
	consumeContextUsageSidecar,
	contextUsagePath,
} from "./src/context-usage.ts";
import {
	parseAgentDefinition,
	loadAgentDefaults,
	type AgentDefaults,
} from "./src/agent-defs.ts";
import {
	buildLaunchPlan,
	buildResumeLaunchPlan,
	type SubagentLaunchParams,
} from "./src/launch.ts";
import {
	buildOutcomeMessage,
	renderSubagentPing,
	renderSubagentResult,
} from "./src/messages.ts";
import { markSubagentActive, markSubagentInactive } from "./src/runtime-state.ts";
import {
	findLastAssistantMessage,
	getNewEntries,
} from "./src/session.ts";
import {
	createHerdrClient,
	HERDR_PLUGIN_ID,
	MIN_HERDR_VERSION,
	type HerdrClient,
} from "./src/herdr/client.ts";
import { createHerdrEventStream } from "./src/herdr/events.ts";
import {
	watchSubagent,
	type RunningSubagent,
	type SubagentOutcome,
	type WatcherDeps,
} from "./src/watcher.ts";

// Bake the actually-defined subagent profiles into the tool's description and
// parameter hints at load time, so the model knows what profiles exist without
// having to read settings.json. Global config is stable here; project-level
// profiles (loaded per-session in dispatch.ts) may add or override these, which
// the description notes so the model doesn't assume this list is exhaustive.
const globalSettingsPath = path.join(getAgentDir(), "settings.json");
const profilesEnabled = isProfilesEnabled(globalSettingsPath);
const registeredGlobalProfiles = profilesEnabled ? loadProfilesFrom(globalSettingsPath) : {};
const registeredProfileNames = Object.keys(registeredGlobalProfiles);
const registeredProfileSummary = formatProfileSummary(registeredGlobalProfiles);
const profileHint =
	registeredProfileNames.length === 0
		? "No subagent profiles are defined, so omit the profile parameter and let the agent use its own model/settings."
		: `Currently available profile(s): ${registeredProfileSummary}. Pick one by name; also check project-level .pi/settings.json for any additional/overriding profiles.`;

// Bake the agent names that exist at load time into the tool description and the
// top-level `agent` hint, so the model has legal names to copy instead of inventing
// them. Scope "both" and the launch directory: extensions load once per process, so
// this is the best available guess at the project set.
//
// Three ways this load-time list can be wrong, all self-healing in one round-trip: a
// name is missing (agents created after startup), a name is stale (a removed agent is
// still advertised), or the list is empty (launching from a parent directory finds no
// project agents at all). The authoritative set is always the per-call
// discoverAgents(ctx.cwd, agentScope) in execute() below, and run.ts answers an unknown
// name with the full current list.
const agentAdvert = formatAgentNames(discoverAgents(process.cwd(), "both").agents, MAX_LISTED_AGENTS);
// The one name list interpolated into both prompt surfaces below: the tool description
// and the `agent` param hint are separate sentences, but they can never advertise
// different sets of names.
const agentNamesText =
	agentAdvert.remaining > 0 ? `${agentAdvert.text} +${agentAdvert.remaining} more` : agentAdvert.text;
const hasAgentNames = agentAdvert.text.length > 0;
const availableAgentsSentence = hasAgentNames
	? `Available agents: ${agentNamesText}. Captured at startup from the launch directory, so project-local agents added since then are missing. Passing an unknown name returns the full current list.`
	: `Available agents: none found at startup; project-local agents in ${CONFIG_DIR_NAME}/agents may still exist. Passing an unknown name returns the full current list.`;
const agentParamHint = hasAgentNames
	? `Name of the agent to invoke (for single mode; the same names apply to items in tasks). Valid: ${agentNamesText}. Passing an unknown name returns the current list.`
	: `Name of the agent to invoke (for single mode; the same names apply to items in tasks). No agents were found at startup; passing any name returns the current list.`;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	profile: Type.Optional(Type.String({ description: `Execution profile (model+thinking). ${profileHint}` })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both" (user agents plus project agents; project agents win name conflicts). Use "user" or "project" to restrict discovery.',
	default: "both",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: agentParamHint })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	profile: Type.Optional(Type.String({ description: `Execution profile for this single task. ${profileHint}` })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

// ── herdr activation guard ──────────────────────────────────────────────────

/** Absolute path of this module — used to detect losing the tool-registry race. */
const MODULE_PATH = fileURLToPath(import.meta.url);

/** herdr injects all three; all three must be present to use the herdr branch. */
export function isInsideHerdr(env: Record<string, string | undefined> = process.env): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
}

/**
 * Whether the herdr-native branch is opted in via settings (`subagent.herdr === true`).
 * Reads the global settings.json (same source as profiles). Project-level settings
 * intentionally do not participate: an untrusted project must not be able to switch
 * the orchestrator into herdr mode. Malformed or missing settings ⇒ disabled.
 */
export function isHerdrEnabled(file: string = path.join(getAgentDir(), "settings.json")): boolean {
	if (!existsSync(file)) return false;
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8")) as { subagent?: { herdr?: unknown } };
		return raw?.subagent?.herdr === true;
	} catch {
		return false;
	}
}

// ── /reload safety (herdr branch) ───────────────────────────────────────────
// /reload re-imports this file, giving fresh module-level state, but closures
// from the old module keep running. Abort the previous module's controllers and
// close its event stream on re-import (ported from pi-herdr-subagents).

const ABORT_KEY = Symbol.for("pi-herdr-subagents/abort-controller");
const STREAM_KEY = Symbol.for("pi-herdr-subagents/event-stream");

{
	const prevAbort = (globalThis as any)[ABORT_KEY] as AbortController | undefined;
	if (prevAbort) prevAbort.abort();
	(globalThis as any)[ABORT_KEY] = new AbortController();

	const prevStream = (globalThis as any)[STREAM_KEY] as { close(): void } | undefined;
	if (prevStream) prevStream.close();
	(globalThis as any)[STREAM_KEY] = null;
}

function getModuleAbortSignal(): AbortSignal {
	return ((globalThis as any)[ABORT_KEY] as AbortController).signal;
}

// ── injectable runtime deps (unit-test seam, herdr branch) ──────────────────

type WatcherStream = WatcherDeps["stream"] & { close(): void };

interface RuntimeDeps {
	client: HerdrClient;
	watch: typeof watchSubagent;
	createStream: (socketPath: string, signal: AbortSignal) => WatcherStream;
}

function defaultDeps(): RuntimeDeps {
	return {
		client: createHerdrClient(),
		watch: watchSubagent,
		createStream: (socketPath, signal) => createHerdrEventStream({ socketPath, signal }),
	};
}

let deps: RuntimeDeps = defaultDeps();
let capabilityCheck: Promise<string | null> | null = null;

function versionAtLeast(actual: string, minimum: string): boolean {
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
		const pluginDir = path.join(path.dirname(MODULE_PATH), "herdr-plugin");
		return (
			`the Herdr plugin is not linked. Run: herdr plugin link "${pluginDir}" --enabled`
		);
	}
	if (!plugin.enabled) {
		return `the Herdr plugin is disabled. Run: herdr plugin enable ${HERDR_PLUGIN_ID}`;
	}
	return null;
}

async function ensureHerdrCapability(): Promise<string | null> {
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

/**
 * One shared HerdrEventStream per pi process, created lazily on first spawn —
 * no persistent socket while zero subagents have ever run. Closed via the
 * module AbortController on /reload + session_shutdown.
 */
function getEventStream(): WatcherStream {
	let stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
	if (!stream) {
		stream = deps.createStream(process.env.HERDR_SOCKET_PATH ?? "", getModuleAbortSignal());
		(globalThis as any)[STREAM_KEY] = stream;
	}
	return stream;
}

/** All currently running herdr subagents, keyed by launch id. */
const runningSubagents = new Map<string, RunningSubagent>();

// ── watcher arming + outcome→steer wiring (herdr branch) ────────────────────

interface SteerSender {
	sendMessage(
		message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): unknown;
}

function armWatcher(
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

// ── herdr tool execution helpers ────────────────────────────────────────────

function errorResult(text: string, error: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { error },
		isError: true,
	};
}

function writePlanFiles(files: Array<{ path: string; content: string }>): void {
	for (const file of files) {
		mkdirSync(path.dirname(file.path), { recursive: true });
		writeFileSync(file.path, file.content, "utf8");
	}
}

/** Minimal ExtensionContext surface the herdr tools consume. */
interface HerdrToolContext {
	cwd: string;
	hasUI: boolean;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	isProjectTrusted(): boolean;
	sessionManager: {
		getSessionFile(): string | undefined;
		getSessionId(): string;
		getSessionDir(): string;
	};
}

/** Agent-def defaults for a discovered agent: parse the discovered file itself. */
function loadAgentDefFor(agentConfig: AgentConfig): AgentDefaults | null {
	try {
		const parsed = parseAgentDefinition(readFileSync(agentConfig.filePath, "utf8"), agentConfig.name);
		if (parsed) return parsed;
	} catch {
		// fall through to directory lookup below
	}
	return loadAgentDefaults(agentConfig.name, [path.dirname(agentConfig.filePath)]);
}

interface HerdrSpawnRequest {
	agent: string;
	task: string;
	cwd?: string;
	profile?: string;
	/** Resolved by the caller (single-mode param > agent name > "Subagent"); may be unset during collection. */
	name?: string;
	/** Explicit tool-parameter overrides (target's optional params). */
	model?: string;
	tools?: string;
	systemPrompt?: string;
	interactive?: boolean;
}

interface HerdrSpawnParams {
	agent?: string;
	task?: string;
	tasks?: { agent: string; task: string; cwd?: string; profile?: string }[];
	profile?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
	name?: string;
	model?: string;
	tools?: string;
	systemPrompt?: string;
	interactive?: boolean;
}

interface SpawnedAck {
	id: string;
	name: string;
	agent?: string;
	paneId: string;
	/** Profile name requested for this spawn (model+thinking override); absent when none. */
	profile?: string;
	sessionFile: string;
	launchScriptFile: string;
}

const FIRE_AND_FORGET_NOTE =
	"The sub-agent is running in the background. " +
	"Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. " +
	"The results will be delivered to you automatically as a steer message when the sub-agent finishes. " +
	"Until then, move on to other work or tell the user you're waiting.";

/**
 * Launch one subagent as a herdr pane (fire-and-forget). Returns its ack, or
 * an error string. Every failure path here happens BEFORE artifacts or panes
 * are created — a failed request must leave no debris.
 */
async function spawnOneSubagent(
	pi: SteerSender,
	request: HerdrSpawnRequest,
	resolved: { model?: string; thinkingLevel?: ThinkingLevel },
	agentDefs: AgentDefaults | null,
	ctx: HerdrToolContext,
): Promise<{ ack: SpawnedAck } | { error: string }> {
	let plan;
	try {
		// Model resolution order (same as profiles.ts semantics): explicit model
		// param > profile.model > agent-def model > parent's current model.
		const launchParams: SubagentLaunchParams = {
			name: request.name ?? "Subagent",
			task: request.task,
			agent: request.agent,
			cwd: request.cwd,
			model: request.model ?? resolved.model,
			thinking: resolved.thinkingLevel,
			tools: request.tools,
			systemPrompt: request.systemPrompt,
			interactive: request.interactive,
		};
		plan = buildLaunchPlan(launchParams, agentDefs, {
			sessionDir: ctx.sessionManager.getSessionDir(),
			sessionId: ctx.sessionManager.getSessionId(),
			parentCwd: ctx.cwd,
			env: process.env,
		});
	} catch (error: any) {
		return { error: `Failed to plan subagent launch: ${error?.message ?? String(error)}` };
	}

	writePlanFiles(plan.files);

	let started;
	try {
		started = await deps.client.paneStart(plan.paneStart);
	} catch (error: any) {
		const message = error?.message ?? String(error);
		return { error: `Failed to start herdr pane for "${request.name}": ${message}` };
	}
	// Best-effort sidebar label; the pane is already running the subagent.
	await deps.client.paneRename(started.paneId, request.name ?? "Subagent").catch(() => {});

	const running: RunningSubagent = {
		id: plan.id,
		name: request.name ?? "Subagent",
		task: request.task,
		agent: request.agent,
		paneId: started.paneId,
		startTime: Date.now(),
		sessionFile: plan.sessionFile,
		launchScriptFile: plan.launchScriptFile,
		interactive: plan.interactive,
		autoExit: plan.autoExit,
	};
	armWatcher(pi, running, { sessionId: ctx.sessionManager.getSessionId() });

	return {
		ack: {
			id: running.id,
			name: running.name,
			agent: running.agent,
			profile: request.profile,
			paneId: running.paneId,
			sessionFile: running.sessionFile,
			launchScriptFile: running.launchScriptFile,
		},
	};
}

async function executeSubagentSpawn(
	pi: SteerSender,
	params: HerdrSpawnParams,
	ctx: HerdrToolContext,
) {
	const agentScope: AgentScope = params.agentScope ?? "both";
	const discovery = discoverAgents(ctx.cwd, agentScope);
	const agents = discovery.agents;

	// ── mode validation ──
	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasTasks) + Number(hasSingle);
	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [
				{
					type: "text" as const,
					text: `Invalid parameters. Provide exactly one mode: single (agent + task) or parallel (tasks array).\nAvailable agents: ${available}`,
				},
			],
			details: { error: "invalid parameters", agentScope },
		};
	}

	// ── profile validation (same semantics as the kept dispatch path) ──
	const profiles = loadProfilesIfEnabled(ctx.cwd, ctx.isProjectTrusted());
	const requestedProfiles: (string | undefined)[] = [];
	if (params.tasks) for (const t of params.tasks) requestedProfiles.push(t.profile);
	requestedProfiles.push(params.profile);
	const invalid = validateProfiles(requestedProfiles, profiles);
	if (invalid.length > 0) {
		const validNames = Object.keys(profiles).join(", ") || "none";
		return errorResult(
			`Unknown subagent profile(s): ${invalid.join(", ")}. Available profiles: ${validNames}.`,
			"unknown profile",
		);
	}

	// ── collect requested spawns ──
	const requests: HerdrSpawnRequest[] = [];
	if (hasSingle) {
		requests.push({
			agent: params.agent!,
			task: params.task!,
			cwd: params.cwd,
			profile: params.profile,
			name: params.name,
			model: params.model,
			tools: params.tools,
			systemPrompt: params.systemPrompt,
			interactive: params.interactive,
		});
	} else {
		if ((params.tasks?.length ?? 0) > MAX_PARALLEL_TASKS) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.`,
					},
				],
				details: { error: "too many parallel tasks", agentScope },
			};
		}
		for (const t of params.tasks!) {
			requests.push({
				agent: t.agent,
				task: t.task,
				cwd: t.cwd,
				profile: t.profile,
				// Explicit overrides apply to every parallel child, matching the
				// single-mode behavior of the same parameters.
				model: params.model,
				tools: params.tools,
				systemPrompt: params.systemPrompt,
				interactive: params.interactive,
				// params.name is a single-mode concept; parallel children are named
				// after their agent (deduplicated below).
			});
		}
	}

	// ── confirmProjectAgents hook (kept from the dispatch path; the
	// confirmation UI itself is intentionally disabled pending a
	// trusted-repo flow — the gate is computed so it can be re-enabled) ──
	const confirmProjectAgents = params.confirmProjectAgents ?? true;
	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI && !ctx.isProjectTrusted()) {
		const projectAgentsRequested = requests
			.map((r) => agents.find((a) => a.name === r.agent))
			.filter((a): a is AgentConfig => a?.source === "project");
		void projectAgentsRequested;
	}

	// ── self-spawn block ──
	const currentAgent = process.env.PI_SUBAGENT_AGENT;
	if (currentAgent) {
		const selfSpawn = requests.find((r) => r.agent === currentAgent);
		if (selfSpawn) {
			return errorResult(
				`You are the ${currentAgent} agent — do not start another ${currentAgent}. ` +
					`You were spawned to do this work yourself. Complete the task directly.`,
				"self-spawn blocked",
			);
		}
	}

	// ── capability check: must stop BEFORE artifacts/panes are created ──
	let setupError: string | null;
	try {
		setupError = await ensureHerdrCapability();
	} catch (error: any) {
		setupError = `capability check failed: ${error?.message ?? String(error)}`;
	}
	if (setupError) {
		return errorResult(
			`Cannot start subagent: ${setupError}`,
			"herdr setup incomplete",
		);
	}

	// ── per-spawn resolution + launch ──
	const parentDefaults = {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel: ctx.thinkingLevel,
	};

	const spawned: SpawnedAck[] = [];
	const failed: Array<{ agent: string; error: string }> = [];
	const usedNames = new Set<string>();

	for (const request of requests) {
		const agentConfig = agents.find((a) => a.name === request.agent);
		if (!agentConfig) {
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			failed.push({
				agent: request.agent,
				error: `Agent "${request.agent}" not found. Available agents: ${available}.`,
			});
			continue;
		}

		const profileName = request.profile;
		const resolved = resolveProfile(
			profileName ? profiles[profileName] : undefined,
			agentConfig,
			parentDefaults,
		);

		// Display name: explicit name (single mode) > agent name > "Subagent",
		// deduplicated so interrupt-by-name stays unambiguous.
		let name = request.name ?? agentConfig.name ?? "Subagent";
		if (usedNames.has(name)) {
			let n = 2;
			while (usedNames.has(`${name}-${n}`)) n++;
			name = `${name}-${n}`;
		}
		usedNames.add(name);

		const agentDefs = loadAgentDefFor(agentConfig);
		const result = await spawnOneSubagent(pi, { ...request, name }, resolved, agentDefs, ctx);
		if ("error" in result) failed.push({ agent: request.agent, error: result.error });
		else spawned.push(result.ack);
	}

	if (spawned.length === 0) {
		const message = failed.map((f) => `${f.agent}: ${f.error}`).join("\n");
		return errorResult(message, "subagent launch failed");
	}

	const lines = [
		...spawned.map((s) => `spawned ${s.name} (pane ${s.paneId})${s.profile ? ` [${s.profile}]` : ""}`),
		...failed.map((f) => `failed ${f.agent}: ${f.error}`),
	];
	return {
		content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n${FIRE_AND_FORGET_NOTE}` }],
		details: {
			status: "started",
			agentScope,
			spawned,
			failed,
		},
	};
}

// ── herdr tool registration ─────────────────────────────────────────────────

function registerSubagentTool(pi: ExtensionAPI): void {
	// Registration-time advert for the herdr branch (per-call discovery remains
	// authoritative; unknown names return the current list).
	const advert = formatAgentNames(discoverAgents(process.cwd(), "both").agents, MAX_LISTED_AGENTS);
	const namesText = advert.remaining > 0 ? `${advert.text} +${advert.remaining} more` : advert.text;
	const agentsSentence = namesText
		? `Available agents: ${namesText}. Passing an unknown name returns the full current list.`
		: `No agents found at startup; project-local agents in ${CONFIG_DIR_NAME}/agents may still exist. Passing any name returns the current list.`;

	const profileSentence =
		registeredProfileNames.length > 0
			? `Profiles (model+thinking overrides): ${registeredProfileSummary}.`
			: "No subagent profiles are defined; each subagent uses its own model/settings.";

	const description = [
		"Delegate tasks to specialized subagents running in dedicated herdr panes with isolated context.",
		"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement (one 'spawned <name> (pane <id>)' line per subagent).",
		"When a sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it.",
		"NEVER write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. NEVER call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you.",
		"NEVER fabricate, assume, or summarize results after calling this tool.",
		"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel); the harness will wake you with each result when it is ready.",
		`Modes: single (agent + task) or parallel (tasks array). ${agentsSentence} ${profileSentence}`,
	].join(" ");

	const HerdrTaskItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		profile: Type.Optional(Type.String({ description: `Execution profile (model+thinking). ${profileHint}` })),
	});

	const HerdrSubagentParams = Type.Object({
		agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
		task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
		tasks: Type.Optional(Type.Array(HerdrTaskItem, { description: "Array of {agent, task} for parallel fire-and-forget execution" })),
		profile: Type.Optional(Type.String({ description: `Execution profile for this single task. ${profileHint}` })),
		agentScope: Type.Optional(AgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
		name: Type.Optional(
			Type.String({ description: "Display name for the subagent (single mode). Default: the agent's name, or 'Subagent'." }),
		),
		model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
		tools: Type.Optional(Type.String({ description: "Comma-separated tools (overrides agent default)" })),
		systemPrompt: Type.Optional(Type.String({ description: "Role instructions appended to the system prompt (used when the agent has no definition body)" })),
		interactive: Type.Optional(
			Type.Boolean({
				description:
					"Mark the subagent as interactive (long-running, user drives the conversation in its own pane). If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`.",
			}),
		),
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description,
		promptGuidelines: [
			"subagent is fire-and-forget: it returns immediately with a spawn acknowledgement; results arrive later as steer messages that start a new turn.",
			"Do not poll, sleep, tail logs, or call other tools to check subagent status; do not fabricate results. After spawning, end the turn or do other independent work.",
			`Choose an agent name from the Available agents list rather than inventing one; an unknown name returns the current list. ${profileSentence}`,
		],
		parameters: HerdrSubagentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeSubagentSpawn(pi, params as HerdrSpawnParams, ctx as unknown as HerdrToolContext);
		},

		renderCall(args, theme, _context) {
			const partialArgs = args as Record<string, unknown>;
			const name =
				typeof partialArgs.name === "string" && partialArgs.name
					? partialArgs.name
					: typeof partialArgs.agent === "string" && partialArgs.agent
						? partialArgs.agent
						: "(unnamed)";
			const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
			const agent =
				typeof partialArgs.agent === "string" && partialArgs.agent
					? theme.fg("dim", ` (${partialArgs.agent})`)
					: "";
			const cwdHint =
				typeof partialArgs.cwd === "string" && partialArgs.cwd
					? theme.fg("dim", ` in ${partialArgs.cwd}`)
					: "";
			let text = "▸ " + theme.fg("toolTitle", theme.bold(name)) + agent + cwdHint;

			if (task) {
				const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
				const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
				if (preview) {
					text += "\n" + theme.fg("toolOutput", preview);
				}
				const totalLines = task.split("\n").length;
				if (totalLines > 1) {
					text += theme.fg("muted", ` (${totalLines} lines)`);
				}
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as any;
			if (details?.status === "started") {
				const spawned: Array<{ name: string; paneId: string; profile?: string }> = details.spawned ?? [];
				const first = spawned[0];
				const profileTag = first?.profile ? theme.fg("dim", ` [${first.profile}]`) : "";
				const text =
					theme.fg("accent", "▸") +
					" " +
					theme.fg("toolTitle", theme.bold(first?.name ?? "subagent")) +
					profileTag +
					theme.fg("dim", first ? ` — spawned (pane ${first.paneId})` : " — started");
				return new Text(text, 0, 0);
			}
			const text = typeof (result.content[0] as { text?: string } | undefined)?.text === "string" ? (result.content[0] as { text?: string }).text : "";
			return new Text(theme.fg("dim", text ?? ""), 0, 0);
		},
	});
}

// ── subagent_resume (herdr branch) ──────────────────────────────────────────

function safeGetNewEntries(sessionFile: string, afterLine: number) {
	try {
		return getNewEntries(sessionFile, afterLine);
	} catch {
		return [];
	}
}

/**
 * Re-scope a resumed subagent's outcome summary to entries added AFTER the
 * resume launch: the pre-existing conversation must not masquerade as new
 * output. Launch failures and pings pass through untouched — their payloads
 * are already truthful.
 */
function resolveResumeOutcome(
	outcome: SubagentOutcome,
	sessionPath: string,
	entryCountBefore: number,
): SubagentOutcome {
	const newSummary = () =>
		findLastAssistantMessage(safeGetNewEntries(sessionPath, entryCountBefore));

	switch (outcome.kind) {
		case "completed":
		case "completed-user-exit":
			return { ...outcome, summary: newSummary() ?? "Resumed session exited without new output" };
		case "crashed":
		case "pane-killed":
		case "gap-exit":
			return { ...outcome, summary: newSummary() };
		default:
			return outcome;
	}
}

const RESUME_DESCRIPTION =
	"Resume a previous sub-agent session in a new herdr pane. " +
	"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
	"When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
	"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
	"DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
	"Use when a sub-agent was cancelled or needs follow-up work.";

async function executeSubagentResume(
	pi: SteerSender,
	params: { sessionPath: string; name?: string; message?: string; autoExit?: boolean },
	ctx: HerdrToolContext,
) {
	if (!existsSync(params.sessionPath)) {
		return errorResult(
			`Error: session file not found: ${params.sessionPath}`,
			"session not found",
		);
	}

	let setupError: string | null;
	try {
		setupError = await ensureHerdrCapability();
	} catch (error: any) {
		setupError = `capability check failed: ${error?.message ?? String(error)}`;
	}
	if (setupError) {
		return errorResult(
			`Cannot resume subagent: ${setupError}`,
			"herdr setup incomplete",
		);
	}

	// Record entry count before resuming so we can extract only new messages.
	const entryCountBefore = safeGetNewEntries(params.sessionPath, 0).length;

	let plan;
	try {
		plan = buildResumeLaunchPlan(params, {
			sessionDir: ctx.sessionManager.getSessionDir(),
			sessionId: ctx.sessionManager.getSessionId(),
			parentCwd: ctx.cwd,
			env: process.env,
		});
	} catch (error: any) {
		const message = error?.message ?? String(error);
		return errorResult(`Failed to plan resume launch: ${message}`, message);
	}

	// Stale-sidecar belt & braces: completion signals from the previous run
	// would resolve the new watcher instantly.
	rmSync(`${params.sessionPath}.exit`, { force: true });
	rmSync(`${params.sessionPath}.exitcode`, { force: true });
	rmSync(contextUsagePath(params.sessionPath), { force: true });

	writePlanFiles(plan.files);

	let started;
	try {
		started = await deps.client.paneStart(plan.paneStart);
	} catch (error: any) {
		const message = error?.message ?? String(error);
		return errorResult(`Failed to start herdr pane for "${plan.name}": ${message}`, message);
	}
	await deps.client.paneRename(started.paneId, plan.name).catch(() => {});

	const running: RunningSubagent = {
		id: plan.id,
		name: plan.name,
		task: params.message ?? "resumed session",
		paneId: started.paneId,
		startTime: Date.now(),
		sessionFile: params.sessionPath,
		launchScriptFile: plan.launchScriptFile,
		interactive: plan.interactive,
		autoExit: plan.autoExit,
	};
	armWatcher(pi, running, {
		sessionId: ctx.sessionManager.getSessionId(),
		mapOutcome: (outcome) => resolveResumeOutcome(outcome, params.sessionPath, entryCountBefore),
	});

	return {
		content: [{ type: "text" as const, text: `Session "${plan.name}" resumed. ${FIRE_AND_FORGET_NOTE}` }],
		details: {
			status: "started",
			id: running.id,
			name: plan.name,
			paneId: running.paneId,
			sessionPath: params.sessionPath,
			launchScriptFile: plan.launchScriptFile,
		},
	};
}

function registerResumeTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_resume",
		label: "Resume Subagent",
		description: RESUME_DESCRIPTION,
		promptGuidelines: [
			"subagent_resume is fire-and-forget: it returns immediately; the resumed session's result arrives later as a steer message. Do not poll or fabricate results.",
		],
		parameters: Type.Object({
			sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
			name: Type.Optional(
				Type.String({ description: "Display name for the herdr pane. Default: 'Resume'" }),
			),
			message: Type.Optional(
				Type.String({
					description: "Optional message to send after resuming (e.g. follow-up instructions)",
				}),
			),
			autoExit: Type.Optional(
				Type.Boolean({
					description:
						"Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeSubagentResume(
				pi,
				params as { sessionPath: string; name?: string; message?: string; autoExit?: boolean },
				ctx as unknown as HerdrToolContext,
			);
		},

		renderCall(args, theme, _context) {
			const name = (args as any).name ?? "Resume";
			return new Text(
				"▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session"),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as any;
			const name = details?.name ?? "Resume";

			if (details?.status === "started") {
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(name)) +
						theme.fg("dim", " — resumed"),
					0,
					0,
				);
			}

			const text = typeof (result.content[0] as { text?: string } | undefined)?.text === "string" ? (result.content[0] as { text?: string }).text : "";
			return new Text(theme.fg("dim", text ?? ""), 0, 0);
		},
	});
}

// ── subagent_interrupt (herdr branch) ───────────────────────────────────────

export function resolveInterruptTarget(params: {
	id?: string;
	name?: string;
}): { running: RunningSubagent } | { error: string } {
	const requestedId = params.id?.trim();
	if (requestedId) {
		const running = runningSubagents.get(requestedId);
		return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
	}

	const requestedName = params.name?.trim();
	if (!requestedName) {
		return { error: "Provide a running subagent id or exact display name." };
	}

	const matches = Array.from(runningSubagents.values()).filter(
		(running) => running.name === requestedName,
	);
	if (matches.length === 1) return { running: matches[0] };
	if (matches.length === 0) {
		return { error: `No running subagent named "${requestedName}".` };
	}

	const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
	return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

async function handleSubagentInterrupt(params: {
	id?: string;
	name?: string;
}): Promise<AgentToolResult<{ id?: string; name?: string; status?: string; error?: string }>> {
	const resolved = resolveInterruptTarget(params);
	if ("error" in resolved) {
		return errorResult(resolved.error, resolved.error);
	}

	const running = resolved.running;
	try {
		// "esc" is herdr key-combo syntax (src/input/parse.rs maps it to KeyCode::Esc).
		await deps.client.paneSendKeys(running.paneId, ["esc"]);
	} catch (error: any) {
		const message =
			`Failed to send Escape to subagent "${running.name}" via herdr: ` +
			`${error?.message ?? String(error)}`;
		return {
			content: [{ type: "text" as const, text: message }],
			details: { error: error?.message ?? String(error), id: running.id, name: running.name },
		};
	}

	return {
		content: [
			{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` },
		],
		details: { id: running.id, name: running.name, status: "interrupt_requested" },
	};
}

const INTERRUPT_DESCRIPTION =
	"Send Escape to the active turn of a currently running subagent. " +
	"The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
	"and does not emit a subagent_result solely because of this request.";

function registerInterruptTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_interrupt",
		label: "Interrupt Subagent",
		description: INTERRUPT_DESCRIPTION,
		promptGuidelines: [
			"subagent_interrupt only sends Escape and returns a local acknowledgement; it never produces a subagent_result by itself. Resolve targets by exact id or unique display name; ambiguous names are reported, never guessed.",
		],
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
			name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
		}),

		async execute(_toolCallId, params) {
			return handleSubagentInterrupt(params as { id?: string; name?: string });
		},

		renderCall(args, theme, _context) {
			const target = (args as any).id ? `${(args as any).id}` : ((args as any).name ?? "(unknown)");
			return new Text(
				theme.fg("accent", "▸") +
					" " +
					theme.fg("toolTitle", theme.bold(target)) +
					theme.fg("dim", " — interrupt turn"),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as any;
			if (details?.status === "interrupt_requested") {
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
						theme.fg("dim", " — interrupt requested"),
					0,
					0,
				);
			}

			const text = typeof (result.content[0] as { text?: string } | undefined)?.text === "string" ? (result.content[0] as { text?: string }).text : "";
			return new Text(theme.fg("dim", text ?? ""), 0, 0);
		},
	});
}

// ── subagents_list (herdr branch, backed by the kept discovery) ─────────────

const LIST_DESCRIPTION =
	"List all available subagent definitions (names and source directory). " +
	"Backed by the same discovery as the subagent tool: user agents plus project-local agents " +
	"(project agents win name conflicts). Honors the agentScope parameter.";

function registerListTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagents_list",
		label: "List Subagents",
		description: LIST_DESCRIPTION,
		promptGuidelines: [
			"subagents_list is informational only; it never reports running status or results of fire-and-forget subagents.",
		],
		parameters: Type.Object({
			agentScope: Type.Optional(AgentScopeSchema),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope: AgentScope =
				(params as { agentScope?: AgentScope }).agentScope ?? "both";
			const discovery = discoverAgents(ctx.cwd, scope);
			const agents = discovery.agents;

			if (agents.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No subagent definitions found." }],
					details: { agents: [] },
				};
			}

			const lines = agents.map((a) => {
				const badge = ` (${a.source})`;
				const desc = a.description ? ` — ${a.description}` : "";
				const model = a.model ? ` [${a.model}]` : "";
				return `• ${a.name}${badge}${model}${desc}`;
			});

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { agents, projectAgentsDir: discovery.projectAgentsDir },
			};
		},

		renderResult(result, _opts, theme) {
			const details = result.details as any;
			const agents = details?.agents ?? [];
			if (agents.length === 0) {
				return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
			}
			const lines = agents.map((a: any) => {
				const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
				const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
				const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
				return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

// ── steer-message renderers (BOTH branches — past-session replay) ───────────

function registerSteerRenderers(pi: ExtensionAPI): void {
	// The messages.ts renderers return a RenderedMessage shape; the extension
	// API expects a Component — the cast mirrors the target extension's wiring.
	pi.registerMessageRenderer("subagent_result", ((message: any, options: any, theme: any) =>
		renderSubagentResult(message, options, theme)) as any);
	pi.registerMessageRenderer("subagent_ping", ((message: any, options: any, theme: any) =>
		renderSubagentPing(message, options, theme)) as any);
}

// ── extension entry ─────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Herdr branch requires BOTH the herdr environment (panes to launch into)
	// AND the explicit opt-in (`"subagent": { "herdr": true }` in settings.json).
	// Anything else falls back to the blocking tool.
	if (isInsideHerdr() && isHerdrEnabled()) {
		registerHerdrBranch(pi);
		return;
	}

	// Outside herdr: the original blocking tool, registered exactly as before
	// the herdr migration (single + parallel, one blocking result).
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task) or parallel (tasks array).",
			`Default agent scope is "both" (recommended): user agents from ${path.join(getAgentDir(), "agents")} plus project-local agents from ${CONFIG_DIR_NAME}/agents (project agents win name conflicts).`,
			`Other options is "user" and "project"`,
			availableAgentsSentence,
			`Profiles: ${registeredProfileSummary}. ${registeredProfileNames.length > 0
				? "Pass one of these names per task to control the subagent's model and thinking; omit to use the agent's own model/settings."
				: "Omit the profile parameter and let the agent use its own model/settings."
			}`,
		].join(" "),
		promptGuidelines: (() => {
			const pick = (() => {
				if (registeredProfileNames.length === 0) {
					return "No subagent profiles are defined, so do not pass a profile parameter; each subagent uses its own model/settings.";
				}
				return `Available subagent profile(s): ${registeredProfileSummary}. Check and evaluate the task (priority), pick one by name (${registeredProfileNames.join("/")}); omit profile to let the agent use its own model/settings.`;
			})();
			return [
				pick,
				"Project-level .pi/settings.json may define additional or overriding profiles beyond this global list, so the full set is resolved per-session.",
				"When calling subagent, choose an agent name from its Available agents list rather than inventing one; an unknown name returns the current list.",
			];
		})(),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "both";
			const discovery = discoverAgents(ctx.cwd, agentScope);

			return executeDispatch(ctx, params, signal, onUpdate, agentScope, discovery);
		},

		renderCall(args, theme, _context) {
			return renderCall(args as DispatchParams, theme as Theme);
		},

		renderResult(result, { expanded }, theme, _context) {
			return renderResult(result, { expanded }, theme as Theme);
		},
	});

	registerSteerRenderers(pi);
}

function registerHerdrBranch(pi: ExtensionAPI): void {
	// Tools denied via PI_DENY_TOOLS env var (set by the parent agent based on
	// frontmatter when this process itself was spawned as a subagent).
	const deniedTools = new Set(
		(process.env.PI_DENY_TOOLS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	const shouldRegister = (name: string) => !deniedTools.has(name);

	if (shouldRegister("subagent")) registerSubagentTool(pi);
	if (shouldRegister("subagent_resume")) registerResumeTool(pi);
	if (shouldRegister("subagent_interrupt")) registerInterruptTool(pi);
	if (shouldRegister("subagents_list")) registerListTool(pi);

	pi.on("session_start", (_event, ctx) => {
		// Registry race: pi resolves duplicate tool names first-loaded-wins,
		// silently. If another extension's `subagent` tool won, warn visibly —
		// never fail silently. sourceInfo.path is preferred; when it is
		// unavailable for every same-name tool, degrade to name-based detection
		// (more than one tool with our name ⇒ possible collision).
		const sameName = pi.getAllTools().filter((tool) => tool.name === "subagent");
		const normalize = (p: string): string => {
			try {
				return realpathSync(p);
			} catch {
				return p;
			}
		};
		const withPaths = sameName.filter((tool) => tool.sourceInfo?.path);
		const foreign = withPaths.find(
			(tool) => normalize(tool.sourceInfo.path) !== normalize(MODULE_PATH),
		);
		if (foreign) {
			ctx.ui.notify(
				`pi-herdr-subagents: another extension's "subagent" tool won the registry race ` +
					`(${foreign.sourceInfo.path}). List pi-herdr-subagents BEFORE other subagent providers ` +
					`in your packages to use the herdr-native tools.`,
				"warning",
			);
		} else if (withPaths.length === 0 && sameName.length > 1) {
			ctx.ui.notify(
				`pi-herdr-subagents: ${sameName.length} "subagent" tools are registered and their sources ` +
					`cannot be determined — another extension may have won the registry race.`,
				"warning",
			);
		}

		// Cheap, asynchronous readiness check. Import stays side-effect free; tool
		// execution awaits the same promise so setup failures stop before artifacts
		// or panes are created.
		capabilityCheck = null;
		void ensureHerdrCapability()
			.then((message) => {
				if (message) {
					ctx.ui.notify(`pi-herdr-subagents: ${message}`, "warning");
				}
			})
			.catch((error: any) => {
				ctx.ui.notify(
					`pi-herdr-subagents: capability check failed: ${error?.message ?? String(error)}`,
					"warning",
				);
			});
	});

	pi.on("session_shutdown", () => {
		for (const running of runningSubagents.values()) {
			running.abortController?.abort();
			markSubagentInactive(running.id);
		}
		runningSubagents.clear();
		const stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
		if (stream) stream.close();
		(globalThis as any)[STREAM_KEY] = null;
		((globalThis as any)[ABORT_KEY] as AbortController).abort();
	});

	registerSteerRenderers(pi);
}

// ── test seam ───────────────────────────────────────────────────────────────

export const __test__ = {
	isInsideHerdr,
	runningSubagents,
	resolveInterruptTarget,
	resolveResumeOutcome,
	versionAtLeast,
	modulePath: MODULE_PATH,
	setDeps(overrides: Partial<RuntimeDeps>): void {
		deps = { ...deps, ...overrides };
	},
	reset(): void {
		deps = defaultDeps();
		capabilityCheck = null;
		for (const running of runningSubagents.values()) {
			running.abortController?.abort();
			markSubagentInactive(running.id);
		}
		runningSubagents.clear();
		const stream = (globalThis as any)[STREAM_KEY] as WatcherStream | null;
		if (stream) stream.close();
		(globalThis as any)[STREAM_KEY] = null;
		((globalThis as any)[ABORT_KEY] as AbortController).abort();
		(globalThis as any)[ABORT_KEY] = new AbortController();
	},
};
