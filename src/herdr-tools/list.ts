// `subagents_list` (herdr branch, backed by the kept discovery).
//
// Phase A2: extracted verbatim from index.ts. Descriptions, promptGuidelines
// and parameter descriptions must stay byte-identical.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentScope, discoverAgents } from "../agents.ts";
import { AgentScopeSchema } from "../tool-schemas.ts";

export const LIST_DESCRIPTION =
	"List all available subagent definitions (names and source directory). " +
	"Backed by the same discovery as the subagent tool: user agents plus project-local agents " +
	"(project agents win name conflicts). Honors the agentScope parameter.";

export function registerListTool(pi: ExtensionAPI): void {
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
