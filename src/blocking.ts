// The legacy (non-herdr) blocking `subagent` tool: single + parallel, one
// tool result per call.
//
// Descriptions, promptGuidelines and parameter descriptions are part of the
// advertised surface and must stay byte-identical.

import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolAdvert } from "./advert.ts";
import { buildSubagentParamSchemas } from "./tool-schemas.ts";
import { type AgentScope, discoverAgents } from "./agents.ts";
import { type SubagentProfile, availableProfileNames } from "./profiles.ts";
import { executeDispatch, type DispatchParams } from "./dispatch.ts";
import { renderCall, renderResult, type Theme } from "./render.ts";
import { registerSteerRenderers } from "./herdr-tools/renderers.ts";

export function registerBlockingTool(pi: ExtensionAPI, advert: ToolAdvert): void {
	const { registeredProfileNames, registeredProfileSummary, availableAgentsSentence } = advert;
	// Global settings profiles baked at load time (advert inputs), rebuilt as a
	// map so availableProfileNames can list them with the built-in "current" first.
	const registeredProfilesAsMap = (): Record<string, SubagentProfile> => {
		const out: Record<string, SubagentProfile> = {};
		for (const name of registeredProfileNames) out[name] = {};
		return out;
	};

	const { params: SubagentParams } = buildSubagentParamSchemas("blocking", advert);

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task) or parallel (tasks array).",
			`Default agent scope is "both" (recommended): user agents from ${path.join(getAgentDir(), "agents")} plus project-local agents from ${CONFIG_DIR_NAME}/agents (project agents win name conflicts).`,
			`Other options is "user" and "project"`,
			availableAgentsSentence,
			`The profile parameter is compulsory — every subagent must name an execution profile (single mode: top-level profile; parallel mode: per task). Profiles: ${registeredProfileSummary}.`,
		].join(" "),
		promptGuidelines: (() => {
			const pick = (() => {
				if (registeredProfileNames.length === 0) {
					return "The profile parameter is compulsory; pass profile 'current' to run a subagent with this session's current model+thinking (project-level .pi/settings.json may define more profiles).";
				}
				return `The profile parameter is compulsory. Available subagent profile(s): ${registeredProfileSummary}. Check and evaluate the task (priority) and pick one by name (${availableProfileNames(registeredProfilesAsMap()).join("/")}); 'current' runs with this session's current model+thinking.`;
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
