// herdr activation guard.
//
// Phase A2: extracted verbatim from index.ts (these were exported from the
// entry point and are re-exported there so importers keep working).

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** herdr injects all three; all three must be present to use the herdr branch. */
export function isInsideHerdr(env: Record<string, string | undefined> = process.env): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
}

/**
 * Whether the herdr-native branch is opted in via settings (`subagent.herdr === true`).
 * Reads the global settings.json (same source as profiles). Project-level settings
 * intentionally do not participate: an untrusted project must not be able to switch
 * the orchestrator into herdr mode. Malformed or missing settings ⇒ disabled.
 */
export function isHerdrEnabled(file: string = path.join(getAgentDir(), "settings.json")): boolean {
	if (!existsSync(file)) return false;
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8")) as { subagent?: { herdr?: unknown } };
		return raw?.subagent?.herdr === true;
	} catch {
		return false;
	}
}
