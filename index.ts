/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * Implementation is split across modules to keep this entry point small:
 *   - dispatch.ts   - execute orchestration (single/parallel/chain)
 *   - run.ts        - spawning and parsing individual subagent processes
 *   - render.ts     - TUI rendering for calls and results
 *   - format.ts     - formatting / output helpers
 *   - types.ts      - shared types and constants
 *   - agents.ts     - agent discovery and configuration
 */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type AgentScope, discoverAgents, formatAgentNames } from "./agents.ts";
import { executeDispatch, type DispatchParams } from "./dispatch.ts";
import { formatProfileSummary, isProfilesEnabled, loadProfilesFrom } from "./profiles.ts";
import { renderCall, renderResult, type Theme } from "./render.ts";
import { MAX_LISTED_AGENTS } from "./types.ts";

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
// Two stale-by-construction cases, both self-healing in one round-trip: agents created
// after startup are missing, a removed agent may still be advertised, and launching from
// a parent directory finds no project agents at all. The authoritative set is always the
// per-call discoverAgents(ctx.cwd, agentScope) in execute() below, and run.ts answers an
// unknown name with the full current list.
const agentAdvert = formatAgentNames(discoverAgents(process.cwd(), "both").agents, MAX_LISTED_AGENTS);
const agentNamesText =
	agentAdvert.remaining > 0 ? `${agentAdvert.text} +${agentAdvert.remaining} more` : agentAdvert.text;
const hasAgentNames = agentAdvert.text.length > 0;
// One string, interpolated in both places below, so the two can never disagree.
const availableAgentsSentence = hasAgentNames
	? `Available agents: ${agentNamesText}. Captured at startup from the launch directory, so project-local agents added since then are missing. Passing an unknown name returns the full current list.`
	: `Available agents: none found at startup; project-local agents in ${CONFIG_DIR_NAME}/agents may still exist. Passing an unknown name returns the full current list.`;
const agentParamHint = hasAgentNames
	? `Name of the agent to invoke (for single mode; the same names apply to items in tasks/chain). Valid: ${agentNamesText}. Passing an unknown name returns the current list.`
	: `Name of the agent to invoke (for single mode; the same names apply to items in tasks/chain). No agents were found at startup; passing any name returns the current list.`;

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	profile: Type.Optional(Type.String({ description: `Execution profile (model+thinking). ${profileHint}` })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
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
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
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
}