// Steer-message renderers (registered in BOTH activation branches so
// past-session entries replay correctly wherever the session is opened).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderSubagentPing, renderSubagentResult } from "../messages.ts";

export function registerSteerRenderers(pi: ExtensionAPI): void {
	// The messages.ts renderers return a RenderedMessage shape; the extension
	// API expects a Component — the cast mirrors the target extension's wiring.
	pi.registerMessageRenderer("subagent_result", ((message: any, options: any, theme: any) =>
		renderSubagentResult(message, options, theme)) as any);
	pi.registerMessageRenderer("subagent_ping", ((message: any, options: any, theme: any) =>
		renderSubagentPing(message, options, theme)) as any);
}
