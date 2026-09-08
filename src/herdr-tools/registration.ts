// Registration of the whole herdr activation branch.
//
// Phase A2: extracted verbatim from index.ts — the PI_DENY_TOOLS filter, the
// four tool registrations, the session_start registry-race check + readiness
// notify, the session_shutdown cleanup, and the steer renderers.

import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolAdvert } from "../advert.ts";
import { markSubagentInactive } from "../runtime-state.ts";
import { registerSubagentTool } from "./spawn.ts";
import { registerResumeTool } from "./resume.ts";
import { registerInterruptTool } from "./interrupt.ts";
import { registerListTool } from "./list.ts";
import { registerSteerRenderers } from "./renderers.ts";
import {
	closeStreamAndAbort,
	ensureHerdrCapability,
	getModulePath,
	invalidateCapability,
	runningSubagents,
} from "./runtime.ts";

export function registerHerdrBranch(pi: ExtensionAPI, advert: ToolAdvert): void {
	// Tools denied via PI_DENY_TOOLS env var (set by the parent agent based on
	// frontmatter when this process itself was spawned as a subagent).
	const deniedTools = new Set(
		(process.env.PI_DENY_TOOLS ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	const shouldRegister = (name: string) => !deniedTools.has(name);

	if (shouldRegister("subagent")) registerSubagentTool(pi, advert);
	if (shouldRegister("subagent_resume")) registerResumeTool(pi);
	if (shouldRegister("subagent_interrupt")) registerInterruptTool(pi);
	if (shouldRegister("subagents_list")) registerListTool(pi);

	pi.on("session_start", (_event, ctx) => {
		// Registry race: pi resolves duplicate tool names first-loaded-wins,
		// silently. If another extension's `subagent` tool won, warn visibly —
		// never fail silently. sourceInfo.path is preferred; when it is
		// unavailable for every same-name tool, degrade to name-based detection
		// (more than one tool with our name ⇒ possible collision).
		const modulePath = getModulePath() ?? "";
		const sameName = pi.getAllTools().filter((tool) => tool.name === "subagent");
		const normalize = (p: string): string => {
			try {
				return realpathSync(p);
			} catch {
				return p;
			}
		};
		const withPaths = sameName.filter((tool) => tool.sourceInfo?.path);
		const foreign = withPaths.find(
			(tool) => normalize(tool.sourceInfo.path) !== normalize(modulePath),
		);
		if (foreign) {
			ctx.ui.notify(
				`pi-herdr-subagents: another extension's "subagent" tool won the registry race ` +
					`(${foreign.sourceInfo.path}). List pi-herdr-subagents BEFORE other subagent providers ` +
					`in your packages to use the herdr-native tools.`,
				"warning",
			);
		} else if (withPaths.length === 0 && sameName.length > 1) {
			ctx.ui.notify(
				`pi-herdr-subagents: ${sameName.length} "subagent" tools are registered and their sources ` +
					`cannot be determined — another extension may have won the registry race.`,
				"warning",
			);
		}

		// Cheap, asynchronous readiness check. Import stays side-effect free; tool
		// execution awaits the same promise so setup failures stop before artifacts
		// or panes are created.
		invalidateCapability();
		void ensureHerdrCapability()
			.then((message) => {
				if (message) {
					ctx.ui.notify(`pi-herdr-subagents: ${message}`, "warning");
				}
			})
			.catch((error: any) => {
				ctx.ui.notify(
					`pi-herdr-subagents: capability check failed: ${error?.message ?? String(error)}`,
					"warning",
				);
			});
	});

	pi.on("session_shutdown", () => {
		for (const running of runningSubagents.values()) {
			running.abortController?.abort();
			markSubagentInactive(running.id);
		}
		runningSubagents.clear();
		closeStreamAndAbort();
	});

	registerSteerRenderers(pi);
}
