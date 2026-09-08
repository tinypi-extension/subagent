// The legacy (non-herdr) blocking `subagent` tool.
//
// Phase A2: extracted verbatim from the else-branch of index.ts's default
// export. Descriptions, promptGuidelines and parameter descriptions must stay
// byte-identical.

import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolAdvert } from "./advert.ts";
import { AgentScopeSchema } from "./tool-schemas.ts";
import { type AgentScope, discoverAgents } from "./agents.ts";
import { executeDispatch, type DispatchParams } from "./dispatch.ts";
import { renderCall, renderResult, type Theme } from "./render.ts";
import { registerSteerRenderers } from "./herdr-tools/renderers.ts";

export function registerBlockingTool(pi: ExtensionAPI, advert: ToolAdvert): void {
	const {
		registeredProfileNames,
		registeredProfileSummary,
		profileHint,
		availableAgentsSentence,
		agentParamHint,
	} = advert;

	const TaskItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		profile: Type.Optional(Type.String({ description: `Execution profile (model+thinking). ${profileHint}` })),
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
