// test/dispatch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeDispatch } from "../dispatch.ts";
import type { DispatchContext, DispatchParams } from "../types.ts";
import type { AgentConfig, AgentDiscoveryResult } from "../agents.ts";
import type { SubagentProfile } from "../profiles.ts";

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
	assert.equal(result.isError, true);
	const text = result.content[0].text;
	assert.match(text, /turbo/);
	assert.ok(Object.keys(profiles).every((n) => text.includes(n)), "lists available profiles");
});

test("valid mixed profiles pass validation (no error)", async () => {
	const params: DispatchParams = {
		tasks: [
			{ agent: "test-agent", task: "t1", profile: "low" },
			{ agent: "test-agent", task: "t2", profile: "high" },
		],
	};
	const result = await executeDispatch(ctx, params, undefined, undefined, "project", discovery, profiles);
	// Validation passes (no isError from profiles); the batch then attempts to spawn
	// but the stubbed agent file path doesn't exist -> the agent lookup still finds it,
	// then pi spawn fails. We only assert validation cleared the invalid-name gate:
	assert.notEqual(result.isError, true);
});
