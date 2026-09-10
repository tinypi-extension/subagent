// herdr-tools tests — Phase 5 orchestrator branch in index.ts, exercised
// through a fake ExtensionAPI + fake RuntimeDeps (the __test__.setDeps seam).
//
// Conventions: node --test --import tsx (same as the rest of the suite).
// The fallback branch (outside herdr) is asserted to be unchanged: same tool
// name, single/parallel params + description, and no herdr tools registered.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import registerExtension, { __test__, isHerdrEnabled, isInsideHerdr } from "../index.ts";
import type { HerdrClient } from "../src/herdr/client.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_SOCKET_PATH",
	"PI_CODING_AGENT_DIR",
	"PI_HERDR_PI_BIN",
	"PI_HERDR_DIRENV",
	"PI_HERDR_HOLD_OPEN_SECS",
	"PI_SUBAGENT_AGENT",
	"PI_DENY_TOOLS",
];

function saveEnv(): void {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
}

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

interface Fixture {
	root: string;
	cwd: string;
	agentDir: string;
	sessionDir: string;
}

function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "herdr-tools-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));

	const cwd = join(root, "work");
	mkdirSync(cwd, { recursive: true });
	const agentDir = join(root, "agent-config");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	const sessionDir = join(root, "sessions");
	mkdirSync(sessionDir, { recursive: true });

	// One user agent with a model + definition body.
	writeFileSync(
		join(agentDir, "agents", "worker.md"),
		[
			"---",
			"name: worker",
			"description: Does the work",
			"model: test/model",
			"auto-exit: true",
			"---",
			"You are a worker.",
			"",
		].join("\n"),
		"utf8",
	);

	// Profiles enabled globally + herdr branch opt-in (fixture agent dir is
	// PI_CODING_AGENT_DIR, so these settings back both baked load-time reads and
	// the per-entry settings gate).
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			subagent: {
				enableProfiles: true,
				herdr: true,
				profiles: { fast: { model: "test/fast-model", thinking: "low" } },
			},
		}),
		"utf8",
	);

	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("PI_HERDR_PI_BIN", "/usr/bin/true");
	setEnv("PI_HERDR_DIRENV", "0");
	setEnv("PI_HERDR_HOLD_OPEN_SECS", "0");

	return { root, cwd, agentDir, sessionDir };
}

function makeHerdrEnv(fixture: Fixture): void {
	setEnv("HERDR_ENV", "1");
	setEnv("HERDR_PANE_ID", "orchestrator-pane");
	setEnv("HERDR_SOCKET_PATH", join(fixture.root, "herdr.sock"));
}

// ── fake ExtensionAPI ───────────────────────────────────────────────────────

interface SentMessage {
	message: { customType: string; content: string; details: Record<string, unknown> };
	options?: { triggerTurn?: boolean; deliverAs?: string };
}

function makeFakePi(options: { toolSourcePath?: string } = {}) {
	const tools: any[] = [];
	const renderers = new Map<string, unknown>();
	const handlers = new Map<string, Array<(...args: any[]) => void>>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const sent: SentMessage[] = [];

	const pi: any = {
		registerTool: (tool: any) => {
			tools.push(tool);
		},
		registerMessageRenderer: (type: string, renderer: unknown) => {
			renderers.set(type, renderer);
		},
		on: (event: string, handler: (...args: any[]) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		getAllTools: () =>
			tools.map((tool) => ({
				name: tool.name,
				sourceInfo: { path: options.toolSourcePath ?? "/fake/extension-path.ts" },
			})),
		sendMessage: (message: any, opts?: any) => {
			sent.push({ message, options: opts });
		},
	};

	function makeCtx(overrides: Record<string, unknown> = {}) {
		return {
			cwd: "",
			hasUI: false,
			mode: "tui",
			isProjectTrusted: () => false,
			ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "parent-session-id",
				getSessionDir: () => "",
			},
			...overrides,
		};
	}

	return { pi, tools, renderers, handlers, notifications, sent, makeCtx };
}

// ── fake RuntimeDeps ────────────────────────────────────────────────────────

const NEVER: Promise<never> = new Promise(() => {});

function makeFakeClient(overrides: Partial<HerdrClient> = {}) {
	const calls = {
		paneStart: [] as any[],
		paneRename: [] as Array<[string, string]>,
		paneSendKeys: [] as Array<[string, string[]]>,
		ping: 0,
	};
	const client: HerdrClient = {
		paneStart: async (p) => {
			calls.paneStart.push(p);
			return {
				paneId: `pane-${calls.paneStart.length}`,
				terminalId: "t",
				workspaceId: "w",
				tabId: "tab",
			};
		},
		paneRename: async (paneId, label) => {
			calls.paneRename.push([paneId, label]);
		},
		paneGet: async () => null,
		paneRead: async () => null,
		paneList: async () => [],
		paneClose: async () => {},
		paneSendKeys: async (paneId, keys) => {
			calls.paneSendKeys.push([paneId, keys]);
		},
		ping: async () => {
			calls.ping++;
			return { ok: true, version: "0.8.3" };
		},
		pluginGet: async () => ({ plugin_id: "pi-herdr-subagents", enabled: true }),
		...overrides,
	};
	return { client, calls };
}

const fakeStream = {
	watch: () => () => {},
	onReconcile: () => () => {},
	close() {},
};

function installFakeDeps(client: HerdrClient, watched: any[]): void {
	__test__.setDeps({
		client,
		watch: ((running: any) => {
			watched.push(running);
			return NEVER;
		}) as any,
		createStream: (() => fakeStream) as any,
	});
}

// ── shared setup ────────────────────────────────────────────────────────────

beforeEach(() => {
	saveEnv();
	__test__.reset();
});

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()!();
	restoreEnv();
});

function toolByName(tools: any[], name: string): any {
	const tool = tools.find((t) => t.name === name);
	assert.ok(tool, `expected tool "${name}" to be registered`);
	return tool;
}

// ── isInsideHerdr env matrix ────────────────────────────────────────────────

describe("isInsideHerdr", () => {
	const matrix: Array<[Record<string, string | undefined>, boolean]> = [
		[{ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s" }, true],
		[{ HERDR_ENV: "0", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s" }, false],
		[{ HERDR_ENV: "1", HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: "/s" }, false],
		[{ HERDR_ENV: "1", HERDR_PANE_ID: "", HERDR_SOCKET_PATH: "/s" }, false],
		[{ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: undefined }, false],
		[{ HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "" }, false],
		[{ HERDR_ENV: undefined, HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: undefined }, false],
		[{}, false],
	];

	for (const [env, expected] of matrix) {
		it(`HERDR_ENV=${JSON.stringify(env.HERDR_ENV)} PANE=${JSON.stringify(env.HERDR_PANE_ID)} SOCK=${JSON.stringify(env.HERDR_SOCKET_PATH)} → ${expected}`, () => {
			assert.equal(isInsideHerdr(env), expected);
		});
	}
});

// ── herdr settings gate (subagent.herdr) ────────────────────────────────────

describe("isHerdrEnabled (subagent.herdr setting)", () => {
	it("returns true when settings.json sets subagent.herdr to true", () => {
		const fixture = makeFixture();
		assert.equal(isHerdrEnabled(join(fixture.agentDir, "settings.json")), true);
	});

	it("returns false when subagent.herdr is false", () => {
		const fixture = makeFixture();
		const file = join(fixture.agentDir, "settings.json");
		writeFileSync(file, JSON.stringify({ subagent: { enableProfiles: true, herdr: false } }));
		assert.equal(isHerdrEnabled(file), false);
	});

	it("returns false when subagent.herdr is absent", () => {
		const fixture = makeFixture();
		const file = join(fixture.agentDir, "settings.json");
		writeFileSync(file, JSON.stringify({ subagent: { enableProfiles: true } }));
		assert.equal(isHerdrEnabled(file), false);
	});

	it("returns false when the settings file does not exist", () => {
		assert.equal(isHerdrEnabled(join(tmpdir(), "does-not-exist", "settings.json")), false);
	});

	it("returns false when settings.json is malformed", () => {
		const fixture = makeFixture();
		const file = join(fixture.agentDir, "settings.json");
		writeFileSync(file, "{ not json");
		assert.equal(isHerdrEnabled(file), false);
	});
});

describe("herdr settings gate (extension entry)", () => {
	it("registers the herdr branch when subagent.herdr is true", () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { pi, tools, renderers } = makeFakePi();
		registerExtension(pi);

		assert.ok(tools.some((t) => t.name === "subagent_resume"), "herdr tools registered");
		assert.ok(renderers.has("subagent_result"));
	});

	it("falls back to the blocking tool when subagent.herdr is false, even inside herdr", () => {
		const fixture = makeFixture();
		writeFileSync(
			join(fixture.agentDir, "settings.json"),
			JSON.stringify({ subagent: { herdr: false } }),
		);
		makeHerdrEnv(fixture);
		const { pi, tools } = makeFakePi();
		registerExtension(pi);

		assert.equal(tools.length, 1, "only the fallback subagent tool is registered");
		assert.equal(toolByName(tools, "subagent").label, "Subagent");
		assert.ok(!tools.some((t) => t.name === "subagent_resume"));
	});

	it("falls back when subagent.herdr is absent from settings", () => {
		const fixture = makeFixture();
		writeFileSync(
			join(fixture.agentDir, "settings.json"),
			JSON.stringify({ subagent: { enableProfiles: true } }),
		);
		makeHerdrEnv(fixture);
		const { pi, tools } = makeFakePi();
		registerExtension(pi);

		assert.equal(tools.length, 1, "only the fallback subagent tool is registered");
	});

	it("falls back when settings.json is missing entirely", () => {
		const fixture = makeFixture();
		rmSync(join(fixture.agentDir, "settings.json"));
		makeHerdrEnv(fixture);
		const { pi, tools } = makeFakePi();
		registerExtension(pi);

		assert.equal(tools.length, 1, "only the fallback subagent tool is registered");
	});

	it("falls back outside herdr even when subagent.herdr is true", () => {
		const fixture = makeFixture(); // herdr: true in settings, no herdr env
		setEnv("HERDR_ENV", undefined);
		setEnv("HERDR_PANE_ID", undefined);
		setEnv("HERDR_SOCKET_PATH", undefined);
		const { pi, tools } = makeFakePi();
		registerExtension(pi);

		assert.equal(tools.length, 1, "only the fallback subagent tool is registered");
	});
});

// ── fallback branch (outside herdr) — behavior unchanged ────────────────────

describe("fallback branch (outside herdr)", () => {
	it("registers only the blocking subagent tool", () => {
		const fixture = makeFixture();
		setEnv("HERDR_ENV", undefined);
		const { pi, tools, renderers } = makeFakePi();
		registerExtension(pi);

		assert.equal(tools.length, 1, "only the fallback subagent tool is registered");
		const tool = toolByName(tools, "subagent");
		assert.equal(tool.label, "Subagent");

		const description: string = tool.description;
		assert.ok(description.includes("Modes: single (agent + task) or parallel (tasks array)"));

		const paramNames = Object.keys(tool.parameters.properties ?? {});
		assert.ok(!paramNames.includes("chain"), "chain mode has been removed");
		assert.ok(paramNames.includes("tasks"));
		assert.ok(paramNames.includes("agentScope"));
		assert.ok(paramNames.includes("confirmProjectAgents"));
		assert.ok(Array.isArray(tool.promptGuidelines));
		assert.ok(tool.promptGuidelines.length > 0);

		assert.ok(renderers.has("subagent_result"), "steer renderers registered for replay");
		assert.ok(renderers.has("subagent_ping"), "steer renderers registered for replay");

		void fixture;
	});
});

// ── herdr branch registration ───────────────────────────────────────────────

describe("herdr branch registration", () => {
	it("registers the fire-and-forget toolset + renderers when inside herdr", () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { pi, tools, renderers } = makeFakePi();
		registerExtension(pi);

		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["subagent", "subagent_interrupt", "subagent_resume", "subagents_list"]);

		const spawnTool = toolByName(tools, "subagent");
		const description: string = spawnTool.description;
		assert.ok(description.includes("fire-and-forget"));
		assert.ok(description.includes("NEVER"));
		assert.ok(description.includes("steer message"));
		assert.ok(Array.isArray(spawnTool.promptGuidelines));

		const paramNames = Object.keys(spawnTool.parameters.properties ?? {});
		for (const expected of ["agent", "task", "tasks", "agentScope", "confirmProjectAgents", "cwd", "name", "model", "tools", "systemPrompt", "interactive"]) {
			assert.ok(paramNames.includes(expected), `param ${expected} expected`);
		}
		assert.ok(!paramNames.includes("chain"), "chain is not part of the herdr toolset");

		assert.ok(renderers.has("subagent_result"));
		assert.ok(renderers.has("subagent_ping"));
	});

	it("honors PI_DENY_TOOLS when registering herdr tools", () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		setEnv("PI_DENY_TOOLS", "subagent_resume,subagent_interrupt");
		const { pi, tools } = makeFakePi();
		registerExtension(pi);

		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["subagent", "subagents_list"]);
	});

	it("honors `*` glob patterns in PI_DENY_TOOLS", () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		// `subagent_*` denies the underscore-suffixed siblings but NOT `subagent`
		// itself, and `mcp_*` matches nothing among our candidates without error.
		setEnv("PI_DENY_TOOLS", "subagent_*,mcp_*");
		const { pi, tools } = makeFakePi();
		registerExtension(pi);

		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, ["subagent", "subagents_list"]);
	});

	it("`*` alone in PI_DENY_TOOLS denies every gated tool", () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		setEnv("PI_DENY_TOOLS", "*");
		const { pi, tools } = makeFakePi();
		registerExtension(pi);

		assert.deepEqual(tools.map((t) => t.name), []);
	});
});

// ── herdr subagent spawn ────────────────────────────────────────────────────

describe("herdr subagent spawn", () => {
	function artifactDirs(fixture: Fixture): { artifactsRoot: string; scriptDir: string; contextDir: string } {
		const artifactsRoot = join(fixture.sessionDir, "artifacts", "parent-session-id");
		return {
			artifactsRoot,
			scriptDir: join(artifactsRoot, "subagent-scripts"),
			contextDir: join(artifactsRoot, "context"),
		};
	}

	it("returns an ack, writes plan files, and arms the watcher", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client, calls } = makeFakeClient();
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({
			cwd: fixture.cwd,
			sessionManager: {
				getSessionFile: () => join(fixture.sessionDir, "parent.jsonl"),
				getSessionId: () => "parent-session-id",
				getSessionDir: () => fixture.sessionDir,
			},
		});

		const result = await tool.execute("call1", { agent: "worker", task: "do the thing", profile: "current" }, undefined, undefined, ctx);

		const text: string = result.content[0].text;
		assert.ok(text.includes("spawned worker (pane pane-1)"), text);
		assert.ok(text.includes("Do NOT generate or assume any results"));
		assert.equal(result.details.status, "started");
		assert.equal(result.details.spawned.length, 1);
		assert.equal(result.details.spawned[0].paneId, "pane-1");
		assert.equal(result.details.spawned[0].agent, "worker");

		// paneStart went through the plugin "subagent" entrypoint plan shape.
		assert.equal(calls.paneStart.length, 1);
		assert.equal(calls.paneStart[0].targetPaneId, "orchestrator-pane");
		assert.equal(calls.paneStart[0].direction, "right");
		assert.equal(calls.paneRename.length, 1);
		assert.equal(calls.paneRename[0][1], "worker");

		// Plan artifacts written (task file + launch script).
		const { scriptDir, contextDir } = artifactDirs(fixture);
		assert.equal(readdirSync(scriptDir).filter((f) => f.endsWith(".sh")).length, 1);
		assert.equal(readdirSync(contextDir).length >= 1, true);

		// Agent-def model flows into the launch script as --model (each argv
		// element is shell-escaped separately).
		const script = readdirSync(scriptDir).map((f) => join(scriptDir, f)).map((p) => readFileSync(p, "utf8") as string).join("\n");
		assert.ok(script.includes("'--model' 'test/model'"), script);
		assert.ok(script.includes("@"));

		// Watcher armed for the spawned child.
		assert.equal(watched.length, 1);
		assert.equal(watched[0].paneId, "pane-1");
		assert.equal(watched[0].sessionFile, result.details.spawned[0].sessionFile);
	});

	it("applies profile model/thinking over agent def and parent defaults", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client } = makeFakeClient();
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({
			cwd: fixture.cwd,
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "parent-session-id",
				getSessionDir: () => fixture.sessionDir,
			},
		});

		await tool.execute("call1", { agent: "worker", task: "x", profile: "fast" }, undefined, undefined, ctx);

		const { scriptDir } = artifactDirs(fixture);
		const script = readdirSync(scriptDir).map((f) => join(scriptDir, f)).map((p) => readFileSync(p, "utf8") as string).join("\n");
		assert.ok(script.includes("'--model' 'test/fast-model'"), script);
		assert.ok(script.includes("'--thinking' 'low'"), script);
		assert.equal(watched.length, 1);
	});

	it("shows [profile] in the spawn ack and TUI result when a profile is used", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client } = makeFakeClient();
		installFakeDeps(client, []);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({
			cwd: fixture.cwd,
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "parent-session-id",
				getSessionDir: () => fixture.sessionDir,
			},
		});

		const withProfile = await tool.execute("call1", { agent: "worker", task: "x", profile: "fast" }, undefined, undefined, ctx);
		const text: string = withProfile.content[0].text;
		assert.ok(text.includes("spawned worker (pane pane-1) [fast]"), text);
		assert.equal(withProfile.details.spawned[0].profile, "fast");

		const withoutProfile = await tool.execute("call2", { agent: "worker", task: "y" }, undefined, undefined, ctx);
		const text2: string = withoutProfile.content[0].text;
		// The profile parameter is compulsory: a single-mode call without one errors
		// and spawns nothing.
		assert.ok(withoutProfile.isError, text2);
		assert.ok(text2.includes("compulsory"), text2);
	});

	it("runs single-mode spawn without profile as a hard error listing options", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client, calls } = makeFakeClient();
		installFakeDeps(client, []);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({ cwd: fixture.cwd });
		const result = await tool.execute("call1", { agent: "worker", task: "x", profile: "" }, undefined, undefined, ctx);
		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("current"), result.content[0].text);
		assert.ok(result.content[0].text.includes("fast"), result.content[0].text);
		assert.equal(calls.paneStart.length, 0);
	});

	it('built-in "current" profile pins the parent session\'s model+thinking over the agent def', async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client } = makeFakeClient();
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({
			cwd: fixture.cwd,
			model: { provider: "test", id: "parent-model" },
			thinkingLevel: "high",
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "parent-session-id",
				getSessionDir: () => fixture.sessionDir,
			},
		});

		// The fixture's worker agent defines `model: test/model`; "current" must beat it.
		const result = await tool.execute("call1", { agent: "worker", task: "x", profile: "current" }, undefined, undefined, ctx);
		assert.ok(!result.isError, result.content[0].text);
		assert.equal(result.details.spawned[0].profile, "current");

		const { scriptDir } = artifactDirs(fixture);
		const script = readdirSync(scriptDir).map((f) => join(scriptDir, f)).map((p) => readFileSync(p, "utf8") as string).join("\n");
		assert.ok(script.includes("'--model' 'test/parent-model'"), script);
		assert.ok(script.includes("'--thinking' 'high'"), script);
	});

	it("renders [profile] in the TUI result view", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client } = makeFakeClient();
		installFakeDeps(client, []);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const theme = { fg: (_s: string, t: string) => t, bold: (t: string) => t };
		const started = {
			content: [{ type: "text", text: "spawned worker (pane pane-1) [fast]" }],
			details: {
				status: "started",
				agentScope: "both",
				spawned: [{ name: "worker", paneId: "pane-1", profile: "fast" }],
				failed: [],
			},
		};
		const rendered = tool.renderResult(started as any, {}, theme as any);
		assert.ok((rendered as any).text.includes("[fast]"), (rendered as any).text);

		const noProfile = {
			...started,
			details: { ...started.details, spawned: [{ name: "worker", paneId: "pane-1" }] },
		};
		const rendered2 = tool.renderResult(noProfile as any, {}, theme as any);
		assert.ok(!(rendered2 as any).text.includes("[]"), (rendered2 as any).text);
	});

	it("rejects self-spawn via PI_SUBAGENT_AGENT", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		setEnv("PI_SUBAGENT_AGENT", "worker");
		const { client, calls } = makeFakeClient();
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({ cwd: fixture.cwd });
		const result = await tool.execute("call1", { agent: "worker", task: "x", profile: "fast" }, undefined, undefined, ctx);

		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("do not start another worker"));
		assert.equal(result.details.error, "self-spawn blocked");
		assert.equal(calls.paneStart.length, 0);
		assert.equal(watched.length, 0);
	});

	it("runs parallel spawns, each with its own ack line and watcher", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client, calls } = makeFakeClient();
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({
			cwd: fixture.cwd,
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "parent-session-id",
				getSessionDir: () => fixture.sessionDir,
			},
		});

		const result = await tool.execute(
			"call1",
			{
				tasks: [
					{ agent: "worker", task: "a", profile: "fast" },
					{ agent: "worker", task: "b", profile: "current" },
				],
			},
			undefined,
			undefined,
			ctx,
		);

		const text: string = result.content[0].text;
		assert.ok(text.includes("spawned worker (pane pane-1)"), text);
		assert.ok(text.includes("spawned worker-2 (pane pane-2)"), text);
		assert.equal(calls.paneStart.length, 2);
		assert.equal(watched.length, 2);
		assert.equal(result.details.spawned.length, 2);
	});

	it("validates mode: neither single nor parallel is an error", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client, calls } = makeFakeClient();
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({ cwd: fixture.cwd });
		const result = await tool.execute("call1", {}, undefined, undefined, ctx);

		assert.ok(result.content[0].text.includes("exactly one mode"));
		assert.equal(calls.paneStart.length, 0);
		assert.equal(watched.length, 0);
	});

	it("rejects unknown profiles without creating artifacts", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client, calls } = makeFakeClient();
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({ cwd: fixture.cwd });
		const result = await tool.execute("call1", { agent: "worker", task: "x", profile: "nope" }, undefined, undefined, ctx);

		assert.ok(result.content[0].text.includes("Unknown subagent profile(s): nope"));
		assert.equal(calls.paneStart.length, 0);
		assert.equal(watched.length, 0);
		assert.ok(!existsSync(join(fixture.sessionDir, "artifacts")));
	});
});

// ── capability check ────────────────────────────────────────────────────────

describe("herdr capability check", () => {
	it("setup failure stops before artifacts/panes and surfaces a clear error", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client, calls } = makeFakeClient({
			ping: async () => ({ ok: false }),
		});
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({
			cwd: fixture.cwd,
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "parent-session-id",
				getSessionDir: () => fixture.sessionDir,
			},
		});
		const result = await tool.execute("call1", { agent: "worker", task: "x", profile: "fast" }, undefined, undefined, ctx);

		assert.ok(result.content[0].text.includes("Cannot start subagent"));
		assert.ok(result.content[0].text.includes("herdr server is not reachable"));
		assert.equal(result.details.error, "herdr setup incomplete");
		assert.equal(calls.paneStart.length, 0);
		assert.equal(watched.length, 0);
		assert.ok(!existsSync(join(fixture.sessionDir, "artifacts")));
	});

	it("rejects herdr versions older than 0.7.0", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client } = makeFakeClient({
			ping: async () => ({ ok: true, version: "0.6.9" }),
		});
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({ cwd: fixture.cwd });
		const result = await tool.execute("call1", { agent: "worker", task: "x", profile: "fast" }, undefined, undefined, ctx);

		assert.ok(result.content[0].text.includes("herdr >= 0.7.0 is required"));
		assert.equal(watched.length, 0);
	});

	it("reports an unlinked plugin", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client } = makeFakeClient({
			pluginGet: async () => null,
		});
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");

		const ctx = fake.makeCtx({ cwd: fixture.cwd });
		const result = await tool.execute("call1", { agent: "worker", task: "x", profile: "fast" }, undefined, undefined, ctx);

		assert.ok(result.content[0].text.includes("plugin is not linked"));
		assert.equal(watched.length, 0);
	});

	it("versionAtLeast compares semver-ish versions", () => {
		const { versionAtLeast } = __test__ as any;
		assert.equal(versionAtLeast("0.7.0", "0.7.0"), true);
		assert.equal(versionAtLeast("0.7.1", "0.7.0"), true);
		assert.equal(versionAtLeast("0.8.0", "0.7.0"), true);
		assert.equal(versionAtLeast("0.6.9", "0.7.0"), false);
		assert.equal(versionAtLeast("0.6.10", "0.7.0"), false);
		assert.equal(versionAtLeast("v0.7.0", "0.7.0"), true);
	});
});

// ── subagent_interrupt ──────────────────────────────────────────────────────

describe("subagent_interrupt", () => {
	function seedRunning(): void {
		const entries: Array<[string, any]> = [
			["id-alpha", { id: "id-alpha", name: "alpha", task: "t", paneId: "pane-a", startTime: 0, sessionFile: "/s/a.jsonl", launchScriptFile: "/s/a.sh", interactive: false, autoExit: true }],
			["id-beta", { id: "id-beta", name: "dup", task: "t", paneId: "pane-b", startTime: 0, sessionFile: "/s/b.jsonl", launchScriptFile: "/s/b.sh", interactive: false, autoExit: true }],
			["id-gamma", { id: "id-gamma", name: "dup", task: "t", paneId: "pane-c", startTime: 0, sessionFile: "/s/c.jsonl", launchScriptFile: "/s/c.sh", interactive: false, autoExit: true }],
		];
		for (const [id, value] of entries) __test__.runningSubagents.set(id, value);
	}

	it("resolves by exact id and sends esc (local ack only, no steer)", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		seedRunning();
		const { client, calls } = makeFakeClient();
		installFakeDeps(client, []);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent_interrupt");

		const result = await tool.execute("call1", { id: "id-alpha" }, undefined, undefined, fake.makeCtx());

		assert.equal(result.details.status, "interrupt_requested");
		assert.deepEqual(calls.paneSendKeys, [["pane-a", ["esc"]]]);
		assert.equal(fake.sent.length, 0, "interrupt must not emit a steer message");
		__test__.runningSubagents.clear();
	});

	it("resolves by unique display name", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		seedRunning();
		const { client, calls } = makeFakeClient();
		installFakeDeps(client, []);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent_interrupt");

		const result = await tool.execute("call1", { name: "alpha" }, undefined, undefined, fake.makeCtx());

		assert.equal(result.details.status, "interrupt_requested");
		assert.deepEqual(calls.paneSendKeys, [["pane-a", ["esc"]]]);
		__test__.runningSubagents.clear();
	});

	it("reports ambiguous names instead of guessing", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		seedRunning();
		const { client, calls } = makeFakeClient();
		installFakeDeps(client, []);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent_interrupt");

		const result = await tool.execute("call1", { name: "dup" }, undefined, undefined, fake.makeCtx());

		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("Ambiguous"));
		assert.ok(result.content[0].text.includes("id-beta"));
		assert.ok(result.content[0].text.includes("id-gamma"));
		assert.equal(calls.paneSendKeys.length, 0);
		__test__.runningSubagents.clear();
	});

	it("errors on unknown id/name", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		seedRunning();
		const { client, calls } = makeFakeClient();
		installFakeDeps(client, []);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent_interrupt");

		const missing = await tool.execute("call1", { id: "nope" }, undefined, undefined, fake.makeCtx());
		assert.ok(missing.isError);
		const noArgs = await tool.execute("call2", {}, undefined, undefined, fake.makeCtx());
		assert.ok(noArgs.isError);
		assert.equal(calls.paneSendKeys.length, 0);
		__test__.runningSubagents.clear();
	});
});

// ── subagent_resume ─────────────────────────────────────────────────────────

describe("subagent_resume", () => {
	it("clears sidecars, writes the resume plan, and arms the watcher", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const sessionPath = join(fixture.sessionDir, "child.jsonl");
		writeFileSync(sessionPath, [
			JSON.stringify({ type: "session", id: "child-uuid", version: 3 }),
			JSON.stringify({ type: "message", id: "e1", message: { role: "assistant", content: [{ type: "text", text: "earlier" }] } }),
			"",
		].join("\n"), "utf8");
		// Stale sidecars from the previous run.
		writeFileSync(`${sessionPath}.exit`, '{"type":"done"}', "utf8");
		writeFileSync(`${sessionPath}.exitcode`, "0 some-run-id", "utf8");
		writeFileSync(`${sessionPath}.context-usage`, "{}", "utf8");

		const { client, calls } = makeFakeClient();
		const watched: any[] = [];
		installFakeDeps(client, watched);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent_resume");

		const ctx = fake.makeCtx({
			cwd: fixture.cwd,
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "parent-session-id",
				getSessionDir: () => fixture.sessionDir,
			},
		});

		const result = await tool.execute("call1", { sessionPath, name: "Follow-up" }, undefined, undefined, ctx);

		assert.equal(result.details.status, "started");
		assert.equal(result.details.sessionPath, sessionPath);
		assert.ok(result.content[0].text.includes("resumed"));

		// Sidecars cleared before launch.
		assert.ok(!existsSync(`${sessionPath}.exit`));
		assert.ok(!existsSync(`${sessionPath}.exitcode`));
		assert.ok(!existsSync(`${sessionPath}.context-usage`));

		// Resume plan written + pane started.
		assert.equal(calls.paneStart.length, 1);
		const { scriptDir } = {
			scriptDir: join(fixture.sessionDir, "artifacts", "parent-session-id", "subagent-scripts"),
		};
		assert.ok(readdirSync(scriptDir).some((f) => f.includes("resume")), readdirSync(scriptDir).join(","));

		// Watcher armed against the resumed session with re-scoped outcome.
		assert.equal(watched.length, 1);
		assert.equal(watched[0].sessionFile, sessionPath);
		assert.equal(watched[0].name, "Follow-up");
	});

	it("errors when the session file does not exist", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const { client, calls } = makeFakeClient();
		installFakeDeps(client, []);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent_resume");

		const ctx = fake.makeCtx({ cwd: fixture.cwd });
		const result = await tool.execute("call1", { sessionPath: "/does/not/exist.jsonl" }, undefined, undefined, ctx);

		assert.ok(result.isError);
		assert.ok(result.content[0].text.includes("session file not found"));
		assert.equal(calls.paneStart.length, 0);
	});
});

// ── subagents_list ──────────────────────────────────────────────────────────

describe("subagents_list", () => {
	it("lists discovered agents with source, honoring agentScope", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);

		// A project agent that should appear only under "project"/"both".
		const projectAgentsDir = join(fixture.cwd, ".pi", "agents");
		mkdirSync(projectAgentsDir, { recursive: true });
		writeFileSync(
			join(projectAgentsDir, "helper.md"),
			"---\nname: helper\ndescription: Project helper\n---\nbody\n",
			"utf8",
		);

		const { client } = makeFakeClient();
		installFakeDeps(client, []);

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagents_list");

		const ctx = fake.makeCtx({ cwd: fixture.cwd });

		const both = await tool.execute("call1", {}, undefined, undefined, ctx);
		const bothText: string = both.content[0].text;
		assert.ok(bothText.includes("worker (user)"), bothText);
		assert.ok(bothText.includes("helper (project)"), bothText);
		assert.ok(bothText.includes("Does the work"));

		const userOnly = await tool.execute("call2", { agentScope: "user" }, undefined, undefined, ctx);
		const userText: string = userOnly.content[0].text;
		assert.ok(userText.includes("worker (user)"));
		assert.ok(!userText.includes("helper"));

		const projectOnly = await tool.execute("call3", { agentScope: "project" }, undefined, undefined, ctx);
		const projectText: string = projectOnly.content[0].text;
		assert.ok(projectText.includes("helper (project)"));
		assert.ok(!projectText.includes("worker"));
	});
});

// ── lifecycle ───────────────────────────────────────────────────────────────

describe("herdr lifecycle", () => {
	it("session_start warns when another extension won the registry race", () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const fake = makeFakePi({ toolSourcePath: "/other/extension.ts" });
		registerExtension(fake.pi);

		const handlers = fake.handlers.get("session_start") ?? [];
		assert.equal(handlers.length, 1);
		handlers[0]({}, fake.makeCtx({ cwd: fixture.cwd }));

		assert.ok(
			fake.notifications.some((n) => n.type === "warning" && n.message.includes("registry race")),
			JSON.stringify(fake.notifications),
		);
	});

	it("session_start does not warn when this module owns the tool", () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);
		const fake = makeFakePi({ toolSourcePath: (__test__ as any).modulePath });
		registerExtension(fake.pi);

		const handlers = fake.handlers.get("session_start") ?? [];
		handlers[0]({}, fake.makeCtx({ cwd: fixture.cwd }));

		assert.ok(
			!fake.notifications.some((n) => n.message.includes("registry race")),
			JSON.stringify(fake.notifications),
		);
	});

	it("session_shutdown aborts watchers and closes the event stream", async () => {
		const fixture = makeFixture();
		makeHerdrEnv(fixture);

		let closed = false;
		__test__.setDeps({
			client: makeFakeClient().client,
			watch: (() => NEVER) as any,
			createStream: (() => ({ ...fakeStream, close: () => (closed = true) })) as any,
		});

		const fake = makeFakePi();
		registerExtension(fake.pi);
		const tool = toolByName(fake.tools, "subagent");
		const ctx = fake.makeCtx({
			cwd: fixture.cwd,
			sessionManager: {
				getSessionFile: () => undefined,
				getSessionId: () => "parent-session-id",
				getSessionDir: () => fixture.sessionDir,
			},
		});
		await tool.execute("call1", { agent: "worker", task: "x", profile: "fast" }, undefined, undefined, ctx);
		assert.equal(__test__.runningSubagents.size, 1);

		const shutdown = (fake.handlers.get("session_shutdown") ?? [])[0];
		assert.ok(shutdown, "session_shutdown handler registered");
		shutdown({}, fake.makeCtx());

		assert.equal(__test__.runningSubagents.size, 0);
		assert.equal(closed, true);
	});
});
