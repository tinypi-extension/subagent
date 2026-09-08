// Shared TypeBox schemas for the subagent tools (both activation branches).
//
// Phase A2: extracted verbatim from index.ts so the herdr tool modules and the
// legacy blocking tool can share one definition. The per-branch TaskItem /
// params schemas stay in their own modules for now (Phase B dedupe).

import { StringEnum } from "@earendil-works/pi-ai";

export const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "both" (user agents plus project agents; project agents win name conflicts). Use "user" or "project" to restrict discovery.',
	default: "both",
});
