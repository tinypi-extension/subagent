// `subagent_interrupt` (herdr branch): send Escape to a running subagent pane.
//
// Descriptions, promptGuidelines and parameter descriptions are part of the
// advertised surface and must stay byte-identical.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { RunningSubagent } from "../watcher.ts";
import { getDeps, runningSubagents } from "./runtime.ts";
import { errorResult } from "./common.ts";

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
		await getDeps().client.paneSendKeys(running.paneId, ["esc"]);
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

export const INTERRUPT_DESCRIPTION =
	"Send Escape to the active turn of a currently running subagent. " +
	"The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
	"and does not emit a subagent_result solely because of this request.";

export function registerInterruptTool(pi: ExtensionAPI): void {
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
