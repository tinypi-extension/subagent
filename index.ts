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
import { type AgentScope, discoverAgents } from "./agents.ts";
import { executeDispatch, type DispatchParams } from "./dispatch.ts";
import { formatProfileSummary, isProfilesEnabled, loadProfilesFrom } from "./profiles.ts";
import { renderCall, renderResult, type Theme } from "./render.ts";

// Bake the actually-defined subagent profiles into the tool's description and
// parameter hints at load time, so the model knows what profiles exist without
// having to read settings.json. Global config is stable here; project-level
// profiles (loaded per-session in dispatch.ts) may add or override these, which
// the description notes so the model doesn't assume this list is exhaustive.
const globalSettingsPath = path.join(getAgentDir(), "settings.json");
const profilesEnabled = isProfilesEnabled(globalSettingsPath);
const registeredGlobalProfiles = loadProfilesFrom(globalSettingsPath);
const registeredProfileNames = Object.keys(registeredGlobalProfiles);
const registeredProfileSummary = formatProfileSummary(registeredGlobalProfiles);
const profileHint =
	registeredProfileNames.length === 0
		? "No subagent profiles are defined, so omit the profile parameter and let the agent use its own model/settings."
		: `Currently available profile(s): ${registeredProfileSummary}. Pick one by name; also check project-level .pi/settings.json for any additional/overriding profiles.`;

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
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
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
	if (!profilesEnabled) return;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			`Default agent scope is "both" (recommended): user agents from ${path.join(getAgentDir(), "agents")} plus project-local agents from ${CONFIG_DIR_NAME}/agents (project agents win name conflicts).`,
			`Other options is "user" and "project"`,
			`Profiles: ${registeredProfileSummary}. ${registeredProfileNames.length > 0
				? "Pass one of these names per task to control the subagent's model and thinking; omit to use the agent's own model/settings."
				: "Omit the profile parameter and let the agent use its own model/settings."
			}]`,
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