// test/dispatch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDispatch, type DispatchParams } from "../dispatch.ts";
import type { DispatchContext, SubagentDetails } from "../types.ts";
import type { AgentConfig, AgentDiscoveryResult } from "../agents.ts";
import type { SubagentProfile } from "../profiles.ts";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

const ctx: DispatchContext = {
	cwd: "/tmp",
	model: { provider: "p", id: "react" },
	thinkingLevel: "medium",
	hasUI: false,
	isProjectTrusted: () => true,
};

const agent: AgentConfig = {
	name: "test-agent", description: "d", tools: [], systemPrompt: "", source: "project", filePath: "/tmp/.pi/agents/test-agent.md",
};

const discovery: AgentDiscoveryResult = { agents: [agent], projectAgentsDir: null };

const profiles: Record<string, SubagentProfile> = { low: { model: "p/low", thinking: "off" }, high: {} };

test("invalid profile in a parallel batch errors before spawning", async () => {
	const params: DispatchParams = {
		tasks: [
			{ agent: "test-agent", task: "t1", profile: "low" },
			{ agent: "test-agent", task: "t2", profile: "turbo" },
		],
	};
	const result = await executeDispatch(ctx, params, undefined, undefined, "project", discovery, profiles);
	// `isError` is not part of `AgentToolResult`; dispatch casts it on the error path.
	const withIsError = result as AgentToolResult<SubagentDetails> & { isError?: boolean };
	assert.equal(withIsError.isError, true);
	const text = result.content[0].type === "text" ? result.content[0].text : "";
	assert.match(text, /turbo/);
	assert.ok(Object.keys(profiles).every((n) => text.includes(n)), "lists available profiles");
});
