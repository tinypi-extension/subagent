// Shared TypeBox schemas for the subagent tools (both activation branches).
//
// AgentScopeSchema is shared verbatim by every tool that discovers agents.
// buildSubagentParamSchemas() is the single source of truth for the two
// `subagent` variants: the legacy blocking tool and the herdr fire-and-forget
// tool register nearly identical parameter graphs, so both are built here.
//
// INVARIANT: every description string below is part of the tool's advertised
// surface (and of the byte-identical-descriptions rule). Changing one changes
// what the model sees — treat these literals as API, not copy.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ToolAdvert } from "./advert.ts";

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both" (user agents plus project agents; project agents win name conflicts). Use "user" or "project" to restrict discovery.',
	default: "both",
});

/** Which `subagent` tool flavor to build parameter schemas for. */
export type ToolVariant = "blocking" | "herdr";

/**
 * Build the `{ taskItem, params }` TypeBox graphs for one tool variant:
 * `taskItem` is one entry of the parallel `tasks` array, `params` is the
 * tool's top-level schema.
 *
 * The two variants differ only in three description wordings (the blocking
 * branch advertises the load-time agent names in its `agent` hint) and in the
 * herdr-only launch overrides (name/model/tools/systemPrompt/interactive).
 * Field order, `.Optional` wrapping and defaults match both registrations
 * exactly.
 *
 * The return type is intentionally inferred: registerTool() derives the
 * execute() params type from the schema (Static<typeof params>), so widening it
 * to a bare TObject here would erase every parameter's type at the call sites.
 */
export function buildSubagentParamSchemas(variant: ToolVariant, advert: ToolAdvert) {
	const herdr = variant === "herdr";

	// Identical in both variants: one entry of the parallel `tasks` array.
	const taskItem = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate to the agent" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		profile: Type.Optional(Type.String({ description: `Execution profile (model+thinking). ${advert.profileHint}` })),
	});

	const shared = {
		agent: Type.Optional(
			Type.String({
				description: herdr ? "Name of the agent to invoke (single mode)" : advert.agentParamHint,
			}),
		),
		task: Type.Optional(
			Type.String({ description: herdr ? "Task to delegate (single mode)" : "Task to delegate (for single mode)" }),
		),
		tasks: Type.Optional(
			Type.Array(taskItem, {
				description: herdr
					? "Array of {agent, task} for parallel fire-and-forget execution"
					: "Array of {agent, task} for parallel execution",
			}),
		),
		profile: Type.Optional(Type.String({ description: `Execution profile for this single task. ${advert.profileHint}` })),
		agentScope: Type.Optional(AgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	};

	if (!herdr) return { taskItem, params: Type.Object(shared) };

	return {
		taskItem,
		params: Type.Object({
			...shared,
			name: Type.Optional(
				Type.String({ description: "Display name for the subagent (single mode). Default: the agent's name, or 'Subagent'." }),
			),
			model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
			tools: Type.Optional(Type.String({ description: "Comma-separated tools (overrides agent default)" })),
			systemPrompt: Type.Optional(
				Type.String({ description: "Role instructions appended to the system prompt (used when the agent has no definition body)" }),
			),
			interactive: Type.Optional(
				Type.Boolean({
					description:
						"Mark the subagent as interactive (long-running, user drives the conversation in its own pane). If omitted, falls back to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`.",
				}),
			),
		}),
	};
}
