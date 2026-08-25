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
import { renderCall, renderResult, type Theme } from "./render.ts";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	profile: Type.Optional(Type.String({ description: "Execution profile (model+thinking) from settings subagent.profiles, e.g. 'low'|'medium'|'high'|'expert'. Omit to use the agent's own model or the current settings." })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	profile: Type.Optional(Type.String({ description: "Execution profile (model+thinking) from settings subagent.profiles, e.g. 'low'|'medium'|'high'|'expert'. Omit to use the agent's own model or the current settings." })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "project". Use "user" or "both" to broaden the scope.',
	default: "project",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	profile: Type.Optional(Type.String({ description: "Execution profile for this single task (see subagent.profiles in settings). Omit to fall back." })),
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
			`Default agent scope is "project" (recommend): project-local agents from ${CONFIG_DIR_NAME}/agents.`,
			`Use agentScope="user" or "both" for user agents from ${path.join(getAgentDir(), "agents")}.`,
			"Profiles (model + thinking level) are defined in settings.json under subagent.profiles (e.g. low/medium/high/expert); pass one per task to control the subagent's model and thinking. Omit to use the agent's own model, then the current model/settings."
		].join(" "),
		promptGuidelines: [
			"Use subagent profile='low' for simple lookups/quick tasks, 'medium' for default work, 'high' for complex reasoning, 'expert' for the hardest architectural/novel problems. Profiles are defined in settings.json subagent.profiles.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "project";
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