/**
 * Dispatch orchestrator: validates the requested mode (single/parallel),
 * handles project-agent trust confirmation, and runs the corresponding branch.
 * Kept separate from the tool registration so `index.ts` stays thin.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentConfig, AgentDiscoveryResult } from "./agents.ts";
import {
	loadProfilesIfEnabled,
	resolveProfile,
	validateProfiles,
	type SubagentProfile,
} from "./profiles.ts";
import {
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	truncateParallelOutput,
} from "./format.ts";
import { mapWithConcurrencyLimit, runSingleAgent } from "./run.ts";
import {
	MAX_PARALLEL_TASKS,
	MAX_CONCURRENCY,
	type DispatchContext,
	type DispatchDefaults,
	type OnUpdateCallback,
	type SingleResult,
	type SubagentDetails,
} from "./types.ts";

/** Mode-agnostic view of the tool parameters the dispatcher acts on. */
export interface DispatchParams {
	agent?: string;
	task?: string;
	profile?: string;
	tasks?: { agent: string; task: string; profile?: string; cwd?: string }[];
	agentScope?: "user" | "project" | "both";
	confirmProjectAgents?: boolean;
	cwd?: string;
}

export async function executeDispatch(
	ctx: DispatchContext,
	params: DispatchParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	agentScope: "user" | "project" | "both",
	discovery: AgentDiscoveryResult,
	profiles: Record<string, SubagentProfile> = loadProfilesIfEnabled(ctx.cwd, ctx.isProjectTrusted()),
): Promise<AgentToolResult<SubagentDetails>> {
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	const parentDefaults: DispatchDefaults = {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel: ctx.thinkingLevel,
	};

	const resolveFor = (agentName: string | undefined, profileName: string | undefined): DispatchDefaults => {
		const agentConfig = agentName ? agents.find((a) => a.name === agentName) : undefined;
		return resolveProfile(profileName ? profiles[profileName] : undefined, agentConfig, parentDefaults);
	};

	const hasTasks = (params.tasks?.length ?? 0) > 0;
	const hasSingle = Boolean(params.agent && params.task);
	const modeCount = Number(hasTasks) + Number(hasSingle);

	const makeDetails =
		(mode: "single" | "parallel") =>
		(results: SingleResult[]): SubagentDetails => ({
			mode,
			agentScope,
			projectAgentsDir: discovery.projectAgentsDir,
			results,
		});

	const requestedProfiles: (string | undefined)[] = [];
	if (params.tasks) for (const t of params.tasks) requestedProfiles.push(t.profile);
	requestedProfiles.push(params.profile);
	const invalid = validateProfiles(requestedProfiles, profiles);
	if (invalid.length > 0) {
		const validNames = Object.keys(profiles).join(", ") || "none";
		return {
			content: [{
				type: "text",
				text: `Unknown subagent profile(s): ${invalid.join(", ")}. Available profiles: ${validNames}.`,
			}],
			details: makeDetails("single")([]),
			isError: true,
		} as AgentToolResult<SubagentDetails>;
	}

	if (modeCount !== 1) {
		const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
		return {
			content: [
				{
					type: "text",
					text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
				},
			],
			details: makeDetails("single")([]),
		};
	}

	if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI && !ctx.isProjectTrusted()) {
		const requestedAgentNames = new Set<string>();
		if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
		if (params.agent) requestedAgentNames.add(params.agent);

		const projectAgentsRequested = Array.from(requestedAgentNames)
			.map((name) => agents.find((a) => a.name === name))
			.filter((a): a is AgentConfig => a?.source === "project");

		// Confirmation UI is intentionally disabled pending a trusted-repo flow.
		// See index.ts: the check is kept so the gate can be re-enabled.
		void projectAgentsRequested;
	}

	if (params.tasks && params.tasks.length > 0) {
		if (params.tasks.length > MAX_PARALLEL_TASKS)
			return {
				content: [
					{
						type: "text",
						text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
					},
				],
				details: makeDetails("parallel")([]),
			};

		// Track all results for streaming updates
		const allResults: SingleResult[] = new Array(params.tasks.length);

		// Initialize placeholder results
		for (let i = 0; i < params.tasks.length; i++) {
			allResults[i] = {
				agent: params.tasks[i].agent,
				agentSource: "unknown",
				task: params.tasks[i].task,
				exitCode: -1, // -1 = still running
				messages: [],
				stderr: "",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			};
		}

		const emitParallelUpdate = () => {
			if (onUpdate) {
				const running = allResults.filter((r) => r.exitCode === -1).length;
				const done = allResults.filter((r) => r.exitCode !== -1).length;
				onUpdate({
					content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
					details: makeDetails("parallel")([...allResults]),
				});
			}
		};

		const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
			const result = await runSingleAgent(
				ctx.cwd,
				resolveFor(t.agent, t.profile),
				t.profile,
				agents,
				t.agent,
				t.task,
				t.cwd,
				signal,
				// Per-task update callback
				(partial) => {
					if (partial.details?.results[0]) {
						allResults[index] = partial.details.results[0];
						emitParallelUpdate();
					}
				},
				makeDetails("parallel"),
			);
			allResults[index] = result;
			emitParallelUpdate();
			return result;
		});

		const successCount = results.filter((r) => !isFailedResult(r)).length;
		const summaries = results.map((r) => {
			const output = truncateParallelOutput(getResultOutput(r));
			const status = isFailedResult(r)
				? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
				: "completed";
			return `### [${r.agent}] ${status}\n\n${output}`;
		});
		return {
			content: [
				{
					type: "text",
					text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
				},
			],
			details: makeDetails("parallel")(results),
		};
	}

	if (params.agent && params.task) {
		const result = await runSingleAgent(
			ctx.cwd,
			resolveFor(params.agent, params.profile),
			params.profile,
			agents,
			params.agent,
			params.task,
			params.cwd,
			signal,
			onUpdate,
			makeDetails("single"),
		);
		const isError = isFailedResult(result);
		if (isError) {
			const errorMsg = getResultOutput(result);
			return {
				content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
				details: makeDetails("single")([result]),
				isError: true,
			} as AgentToolResult<SubagentDetails>;
		}
		return {
			content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
			details: makeDetails("single")([result]),
		};
	}

	const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
	return {
		content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
		details: makeDetails("single")([]),
	};
}