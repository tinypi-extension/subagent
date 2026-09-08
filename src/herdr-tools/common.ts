// Shared helpers and context types for the herdr tool modules.
//
// Phase A2: extracted verbatim from index.ts. Nothing here touches runtime
// state — this module must never import runtime.ts (cycle safety).

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export function errorResult(text: string, error: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { error },
		isError: true,
	};
}

export function writePlanFiles(files: Array<{ path: string; content: string }>): void {
	for (const file of files) {
		mkdirSync(path.dirname(file.path), { recursive: true });
		writeFileSync(file.path, file.content, "utf8");
	}
}

/** Minimal ExtensionContext surface the herdr tools consume. */
export interface HerdrToolContext {
	cwd: string;
	hasUI: boolean;
	model?: { provider: string; id: string };
	thinkingLevel?: ThinkingLevel;
	isProjectTrusted(): boolean;
	sessionManager: {
		getSessionFile(): string | undefined;
		getSessionId(): string;
		getSessionDir(): string;
	};
}

export interface SteerSender {
	sendMessage(
		message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): unknown;
}

export const FIRE_AND_FORGET_NOTE =
	"The sub-agent is running in the background. " +
	"Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. " +
	"The results will be delivered to you automatically as a steer message when the sub-agent finishes. " +
	"Until then, move on to other work or tell the user you're waiting.";
