// `subagent_resume` (herdr branch): re-open a previous session in a new pane.
//
// Descriptions, promptGuidelines and parameter descriptions are part of the
// advertised surface and must stay byte-identical.

import { existsSync, rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { contextUsagePath } from "../context-usage.ts";
import { buildResumeLaunchPlan } from "../launch.ts";
import { findLastAssistantMessage, getNewEntries } from "../session.ts";
import type { RunningSubagent, SubagentOutcome } from "../watcher.ts";
import { armWatcher, ensureHerdrCapability, getDeps } from "./runtime.ts";
import {
	errorResult,
	FIRE_AND_FORGET_NOTE,
	type HerdrToolContext,
	type SteerSender,
	writePlanFiles,
} from "./common.ts";

function safeGetNewEntries(sessionFile: string, afterLine: number) {
	try {
		return getNewEntries(sessionFile, afterLine);
	} catch {
		return [];
	}
}

/**
 * Re-scope a resumed subagent's outcome summary to entries added AFTER the
 * resume launch: the pre-existing conversation must not masquerade as new
 * output. Launch failures and pings pass through untouched — their payloads
 * are already truthful.
 */
export function resolveResumeOutcome(
	outcome: SubagentOutcome,
	sessionPath: string,
	entryCountBefore: number,
): SubagentOutcome {
	const newSummary = () =>
		findLastAssistantMessage(safeGetNewEntries(sessionPath, entryCountBefore));

	switch (outcome.kind) {
		case "completed":
		case "completed-user-exit":
			return { ...outcome, summary: newSummary() ?? "Resumed session exited without new output" };
		case "crashed":
		case "pane-killed":
		case "gap-exit":
			return { ...outcome, summary: newSummary() };
		default:
			return outcome;
	}
}

export const RESUME_DESCRIPTION =
	"Resume a previous sub-agent session in a new herdr pane. " +
	"This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
	"When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
	"DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
	"DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
	"Use when a sub-agent was cancelled or needs follow-up work.";

async function executeSubagentResume(
	pi: SteerSender,
	params: { sessionPath: string; name?: string; message?: string; autoExit?: boolean },
	ctx: HerdrToolContext,
) {
	if (!existsSync(params.sessionPath)) {
		return errorResult(
			`Error: session file not found: ${params.sessionPath}`,
			"session not found",
		);
	}

	let setupError: string | null;
	try {
		setupError = await ensureHerdrCapability();
	} catch (error: any) {
		setupError = `capability check failed: ${error?.message ?? String(error)}`;
	}
	if (setupError) {
		return errorResult(
			`Cannot resume subagent: ${setupError}`,
			"herdr setup incomplete",
		);
	}

	// Record entry count before resuming so we can extract only new messages.
	const entryCountBefore = safeGetNewEntries(params.sessionPath, 0).length;

	let plan;
	try {
		plan = buildResumeLaunchPlan(params, {
			sessionDir: ctx.sessionManager.getSessionDir(),
			sessionId: ctx.sessionManager.getSessionId(),
			parentCwd: ctx.cwd,
			env: process.env,
		});
	} catch (error: any) {
		const message = error?.message ?? String(error);
		return errorResult(`Failed to plan resume launch: ${message}`, message);
	}

	// Stale-sidecar belt & braces: completion signals from the previous run
	// would resolve the new watcher instantly.
	rmSync(`${params.sessionPath}.exit`, { force: true });
	rmSync(`${params.sessionPath}.exitcode`, { force: true });
	rmSync(contextUsagePath(params.sessionPath), { force: true });

	writePlanFiles(plan.files);

	let started;
	try {
		started = await getDeps().client.paneStart(plan.paneStart);
	} catch (error: any) {
		const message = error?.message ?? String(error);
		return errorResult(`Failed to start herdr pane for "${plan.name}": ${message}`, message);
	}
	await getDeps().client.paneRename(started.paneId, plan.name).catch(() => {});

	const running: RunningSubagent = {
		id: plan.id,
		name: plan.name,
		task: params.message ?? "resumed session",
		paneId: started.paneId,
		startTime: Date.now(),
		sessionFile: params.sessionPath,
		launchScriptFile: plan.launchScriptFile,
		interactive: plan.interactive,
		autoExit: plan.autoExit,
	};
	armWatcher(pi, running, {
		sessionId: ctx.sessionManager.getSessionId(),
		mapOutcome: (outcome) => resolveResumeOutcome(outcome, params.sessionPath, entryCountBefore),
	});

	return {
		content: [{ type: "text" as const, text: `Session "${plan.name}" resumed. ${FIRE_AND_FORGET_NOTE}` }],
		details: {
			status: "started",
			id: running.id,
			name: plan.name,
			paneId: running.paneId,
			sessionPath: params.sessionPath,
			launchScriptFile: plan.launchScriptFile,
		},
	};
}

export function registerResumeTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_resume",
		label: "Resume Subagent",
		description: RESUME_DESCRIPTION,
		promptGuidelines: [
			"subagent_resume is fire-and-forget: it returns immediately; the resumed session's result arrives later as a steer message. Do not poll or fabricate results.",
		],
		parameters: Type.Object({
			sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
			name: Type.Optional(
				Type.String({ description: "Display name for the herdr pane. Default: 'Resume'" }),
			),
			message: Type.Optional(
				Type.String({
					description: "Optional message to send after resuming (e.g. follow-up instructions)",
				}),
			),
			autoExit: Type.Optional(
				Type.Boolean({
					description:
						"Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return executeSubagentResume(
				pi,
				params as { sessionPath: string; name?: string; message?: string; autoExit?: boolean },
				ctx as unknown as HerdrToolContext,
			);
		},

		renderCall(args, theme, _context) {
			const name = (args as any).name ?? "Resume";
			return new Text(
				"▸ " + theme.fg("toolTitle", theme.bold(name)) + theme.fg("dim", " — resuming session"),
				0,
				0,
			);
		},

		renderResult(result, _opts, theme) {
			const details = result.details as any;
			const name = details?.name ?? "Resume";

			if (details?.status === "started") {
				return new Text(
					theme.fg("accent", "▸") +
						" " +
						theme.fg("toolTitle", theme.bold(name)) +
						theme.fg("dim", " — resumed"),
					0,
					0,
				);
			}

			const text = typeof (result.content[0] as { text?: string } | undefined)?.text === "string" ? (result.content[0] as { text?: string }).text : "";
			return new Text(theme.fg("dim", text ?? ""), 0, 0);
		},
	});
}
