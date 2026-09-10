// The herdr-branch `subagent` tool: fire-and-forget spawn into herdr panes.
//
// Descriptions, promptGuidelines and parameter descriptions are part of the
// advertised surface and must stay byte-identical.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import type { ToolAdvert } from "../advert.ts";
import { buildSubagentParamSchemas } from "../tool-schemas.ts";
import { type AgentConfig, type AgentScope, discoverAgents } from "../agents.ts";
import { type SubagentProfile, availableProfileNames, loadProfilesIfEnabled, lookupProfile, profileRequiredMessage, resolveProfile, validateProfiles } from "../profiles.ts";
import { loadAgentDefFor, type AgentDefaults } from "../agent-defs.ts";
import { buildLaunchPlan, type SubagentLaunchParams } from "../launch.ts";
import { MAX_PARALLEL_TASKS } from "../types.ts";
import type { RunningSubagent } from "../watcher.ts";
import {
	armWatcher,
	ensureHerdrCapability,
	getDeps,
} from "./runtime.ts";
import {
	errorResult,
	FIRE_AND_FORGET_NOTE,
	type HerdrToolContext,
	type SteerSender,
	writePlanFiles,
} from "./common.ts";

interface HerdrSpawnRequest {
	agent: string;
	task: string;
	cwd?: string;
	/** Effective profile for this spawn; guaranteed non-empty after collectRequests. */
	profile: string;
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
	/** Tool-list warnings from launch planning (e.g. a `*` pattern that matched nothing). */
	toolWarnings?: string[];
	sessionFile: string;
	launchScriptFile: string;
}

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
		started = await getDeps().client.paneStart(plan.paneStart);
	} catch (error: any) {
		const message = error?.message ?? String(error);
		return { error: `Failed to start herdr pane for "${request.name}": ${message}` };
	}
	// Best-effort sidebar label; the pane is already running the subagent.
	await getDeps().client.paneRename(started.paneId, request.name ?? "Subagent").catch(() => {});

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
			...(plan.toolWarnings.length > 0 ? { toolWarnings: plan.toolWarnings } : {}),
		},
	};
}

/** Tool result returned by an early-exit stage (before anything is spawned). */
interface SpawnErrorResult {
	content: [{ type: "text"; text: string }];
	details: { error: string; agentScope: AgentScope };
	isError: true;
}

/** Exactly one of single (agent + task) or parallel (tasks) must be given. */
function validateMode(
	params: HerdrSpawnParams,
	agents: AgentConfig[],
	agentScope: AgentScope,
): SpawnErrorResult | null {
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
			isError: true,
		};
	}
	return null;
}

/** Turn the validated params into one spawn request per subagent. */
function collectRequests(
	params: HerdrSpawnParams,
	profiles: Record<string, SubagentProfile>,
): { error: string; code: string } | HerdrSpawnRequest[] {
	const requests: HerdrSpawnRequest[] = [];
	if (Boolean(params.agent && params.task)) {
		// The profile parameter is compulsory in single mode. It stays schema-optional
		// because parallel mode carries it per task item; enforce it here.
		if (!params.profile?.trim()) {
			return { error: profileRequiredMessage(profiles), code: "missing profile" };
		}
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
			return { error: `Too many parallel tasks (${params.tasks!.length}). Max is ${MAX_PARALLEL_TASKS}.`, code: "too many parallel tasks" };
		}
		for (const t of params.tasks!) {
			// Parallel mode: every task item must name a profile (the schema
			// requires it; this also catches empty strings from direct calls).
			if (!t.profile?.trim()) {
				return { error: profileRequiredMessage(profiles), code: "missing profile" };
			}
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
	return requests;
}

/**
 * Resolve and launch each request in order, accumulating acks and failures.
 * Called only after every validation has passed: from here on, a request may
 * create artifacts and panes (see spawnOneSubagent's failure contract).
 */
async function launchRequests(
	pi: SteerSender,
	requests: HerdrSpawnRequest[],
	agents: AgentConfig[],
	profiles: Record<string, SubagentProfile>,
	parentDefaults: { model?: string; thinkingLevel?: ThinkingLevel },
	ctx: HerdrToolContext,
): Promise<{ spawned: SpawnedAck[]; failed: Array<{ agent: string; error: string }> }> {
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

		const resolved = resolveProfile(
			lookupProfile(request.profile, profiles, parentDefaults),
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

	return { spawned, failed };
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
	const invalidMode = validateMode(params, agents, agentScope);
	if (invalidMode) return invalidMode;

	// ── profile validation (same semantics as the kept dispatch path) ──
	const profiles = loadProfilesIfEnabled(ctx.cwd, ctx.isProjectTrusted());
	const requestedProfiles: (string | undefined)[] = [];
	if (params.tasks) for (const t of params.tasks) requestedProfiles.push(t.profile);
	requestedProfiles.push(params.profile);
	const invalid = validateProfiles(requestedProfiles, profiles);
	if (invalid.length > 0) {
		const validNames = availableProfileNames(profiles).join(", ");
		return errorResult(
			`Unknown subagent profile(s): ${invalid.join(", ")}. Available profiles: ${validNames}.`,
			"unknown profile",
		);
	}

	// ── collect requested spawns (also enforces the compulsory profile) ──
	const collected = collectRequests(params, profiles);
	if ("error" in collected) {
		return {
			content: [
				{
					type: "text" as const,
					text: collected.error,
				},
			],
			details: { error: collected.code, agentScope },
			isError: true,
		};
	}
	const requests = collected;

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

	const { spawned, failed } = await launchRequests(pi, requests, agents, profiles, parentDefaults, ctx);

	if (spawned.length === 0) {
		const message = failed.map((f) => `${f.agent}: ${f.error}`).join("\n");
		return errorResult(message, "subagent launch failed");
	}

	const lines = [
		...spawned.map((s) => `spawned ${s.name} (pane ${s.paneId})${s.profile ? ` [${s.profile}]` : ""}`),
		...failed.map((f) => `failed ${f.agent}: ${f.error}`),
		...spawned.flatMap((s) => s.toolWarnings ?? []),
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

export function registerSubagentTool(pi: ExtensionAPI, advert: ToolAdvert): void {
	// Registration-time advert for the herdr branch: the agent names come from
	// the same load-time discovery the blocking branch advertises (per-call
	// discovery remains authoritative; unknown names return the current list).
	const agentsSentence = advert.herdrAgentsSentence;

	const profileSentence =
		advert.registeredProfileNames.length > 0
			? `The profile parameter is compulsory (model+thinking overrides): ${advert.registeredProfileSummary}.`
			: `The profile parameter is compulsory: ${advert.registeredProfileSummary}.`;

	const description = [
		"Delegate tasks to specialized subagents running in dedicated herdr panes with isolated context.",
		"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement (one 'spawned <name> (pane <id>)' line per subagent).",
		"When a sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it.",
		"NEVER write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. NEVER call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you.",
		"NEVER fabricate, assume, or summarize results after calling this tool.",
		"After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel); the harness will wake you with each result when it is ready.",
		`Modes: single (agent + task) or parallel (tasks array). ${agentsSentence} ${profileSentence}`,
	].join(" ");

	const { params: HerdrSubagentParams } = buildSubagentParamSchemas("herdr", advert);

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
