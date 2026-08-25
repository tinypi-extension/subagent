# Subagent Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the main agent choose a `profile` per subagent task that resolves to a concrete model + thinking level, with a defined fallback chain.

**Architecture:** A new `profiles.ts` module loads merged profiles from settings and resolves each task's `profile` (+ agent frontmatter model + parent defaults) into a `{ model, thinkingLevel }`. `dispatch.ts` validates all requested names *before* spawning, resolves each task, and passes resolved values down; `run.ts` becomes a dumb pass-through that emits `--model`/`--thinking` from those values.

**Tech Stack:** TypeScript, Node `node:test`, `tsx`, `@earendil-works/pi-coding-agent` / `pi-agent-core` types.

## Global Constraints

- Profile config key is `subagent.profiles` in `settings.json`, fields `model` (optional) and `thinking` (optional). Field name is `thinking`, NOT `thinkingLevel`.
- `thinking` must be one of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (a `ThinkingLevel`).
- Profile model string is `provider/id`, same as the `--model` CLI flag.
- Project `.pi/settings.json` merges over global by union of profile names, project wins per name, only when the project is trusted (`ctx.isProjectTrusted()`).
- `profile` is settable per task/step (single: top-level; parallel/chain: per item). No call-level default.
- Explicit but unknown profile name = hard error listing valid names. Omitted profile never errors.
- Malformed profile (invalid `thinking`) = profile treated as unusable (excluded from available set); un-referenced malformed entries must not break other profiles/agents.
- No automatic difficulty scoring.

---

### Task 1: `profiles.ts` module + unit tests

**Files:**
- Create: `profiles.ts`
- Test: `test/profiles.test.ts`

**Interfaces:**
- Consumes: `ThinkingLevel` from `@earendil-works/pi-agent-core`; `CONFIG_DIR_NAME`, `getAgentDir` from `@earendil-works/pi-coding-agent`; `DispatchDefaults` from `./types.ts`; `AgentConfig` from `./agents.ts`.
- Produces:
  - `interface SubagentProfile { model?: string; thinking?: ThinkingLevel }`
  - `function loadProfilesFrom(file: string): Record<string, SubagentProfile>` — parse one JSON file; malformed/invalid entries dropped; empty/missing file → `{}`.
  - `function loadProfiles(cwd: string, projectTrusted: boolean): Record<string, SubagentProfile>` — global → project merge.
  - `function validateProfiles(requested: (string | undefined)[], available: Record<string, SubagentProfile>): string[]` — returns unique invalid names.
  - `function resolveProfile(profile: SubagentProfile | undefined, agent: { model?: string } | undefined, parent: DispatchDefaults): DispatchDefaults` — fallback chain.

- [ ] **Step 1: Write the failing tests**

```ts
// test/profiles.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadProfilesFrom,
  resolveProfile,
  validateProfiles,
  type SubagentProfile,
} from "../profiles.ts";
import type { DispatchDefaults } from "../types.ts";

function tmpFile(contents: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profiles-"));
  const f = path.join(d, "settings.json");
  fs.writeFileSync(f, contents);
  return f;
}

const PARENT: DispatchDefaults = { model: "p/react", thinkingLevel: "medium" };

test("loadProfilesFrom parses valid profiles and drops malformed ones", () => {
  const f = tmpFile(JSON.stringify({
    subagent: { profiles: {
      low: { model: "a/x", thinking: "off" },
      medium: { thinking: "low" },              // model missing -> ok
      bad: { thinking: "ultra" },               // invalid level -> dropped
      empty: {},                                // empty -> dropped
      notobj: 42,                               // not object -> dropped
    } },
  }));
  const p = loadProfilesFrom(f);
  assert.deepEqual(Object.keys(p).sort(), ["low", "medium"]);
  assert.deepEqual(p.low, { model: "a/x", thinking: "off" });
  assert.deepEqual(p.medium, { thinking: "low" });
});

test("loadProfilesFrom handles missing file and non-object subagent", () => {
  assert.deepEqual(loadProfilesFrom("/no/such/file.json"), {});
  const f = tmpFile(JSON.stringify({ subagent: "nope" }));
  assert.deepEqual(loadProfilesFrom(f), {});
});

test("resolveProfile full chain: profile -> agent -> parent", () => {
  // profile present (both)
  assert.deepEqual(
    resolveProfile({ model: "pro/m", thinking: "high" }, { model: "ag/m" }, PARENT),
    { model: "pro/m", thinkingLevel: "high" },
  );
  // profile omitted, agent has model -> agent model, no inherited thinking
  assert.deepEqual(resolveProfile(undefined, { model: "ag/m" }, PARENT), { model: "ag/m" });
  // profile omitted, no agent model -> parent model + parent thinking
  assert.deepEqual(resolveProfile(undefined, undefined, PARENT), { model: "p/react", thinkingLevel: "medium" });
  // profile with model only, agent has model -> profile model wins, thinking falls to model default (neither set)
  assert.deepEqual(resolveProfile({ model: "pro/m" }, { model: "ag/m" }, PARENT), { model: "pro/m" });
  // profile with thinking only, no agent model -> parent model + profile thinking
  assert.deepEqual(resolveProfile({ thinking: "off" }, undefined, PARENT), { model: "p/react", thinkingLevel: "off" });
  // profile with thinking only, agent HAS model -> agent model + profile thinking (profile thinking wins)
  assert.deepEqual(resolveProfile({ thinking: "off" }, { model: "ag/m" }, PARENT), { model: "ag/m", thinkingLevel: "off" });
  // no model anywhere
  assert.deepEqual(resolveProfile(undefined, undefined, {}), {});
});

test("validateProfiles returns unique invalid names", () => {
  const available: Record<string, SubagentProfile> = { low: {}, high: {} };
  assert.deepEqual(validateProfiles(["low", "high"], available), []);
  assert.deepEqual(validateProfiles([undefined, "low"], available), []);
  assert.deepEqual(validateProfiles(["low", "turbo", "turbo"], available), ["turbo"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module '../profiles.ts'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

```ts
// profiles.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { DispatchDefaults } from "./types.ts";

export interface SubagentProfile {
  model?: string;
  thinking?: ThinkingLevel;
}

const VALID_THINKING: ReadonlySet<string> = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && VALID_THINKING.has(v);
}

function parseProfile(raw: unknown): SubagentProfile | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.thinking !== undefined && !isThinkingLevel(r.thinking)) return undefined; // unusable
  const out: SubagentProfile = {};
  if (typeof r.model === "string") out.model = r.model;
  if (r.thinking !== undefined) out.thinking = r.thinking;
  return out.model !== undefined || out.thinking !== undefined ? out : undefined;
}

export function loadProfilesFrom(file: string): Record<string, SubagentProfile> {
  if (!fs.existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
  const profiles = (raw as { subagent?: { profiles?: unknown } } | null)?.subagent?.profiles;
  if (typeof profiles !== "object" || profiles === null) return {};
  const out: Record<string, SubagentProfile> = {};
  for (const [name, def] of Object.entries(profiles as Record<string, unknown>)) {
    const p = parseProfile(def);
    if (p) out[name] = p;
  }
  return out;
}

export function loadProfiles(cwd: string, projectTrusted: boolean): Record<string, SubagentProfile> {
  const global = loadProfilesFrom(path.join(getAgentDir(), "settings.json"));
  if (!projectTrusted) return global;
  const project = loadProfilesFrom(path.join(cwd, CONFIG_DIR_NAME, "settings.json"));
  return { ...global, ...project };
}

export function validateProfiles(
  requested: (string | undefined)[],
  available: Record<string, SubagentProfile>,
): string[] {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const name of requested) {
    if (name === undefined) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    if (!(name in available)) invalid.push(name);
  }
  return invalid;
}

export function resolveProfile(
  profile: SubagentProfile | undefined,
  agent: { model?: string } | undefined,
  parent: DispatchDefaults,
): DispatchDefaults {
  const out: DispatchDefaults = {};
  const model = profile?.model ?? agent?.model ?? parent.model;
  if (model !== undefined) out.model = model;

  if (profile?.thinking) {
    out.thinkingLevel = profile.thinking;
  } else if (!agent?.model && parent.thinkingLevel) {
    out.thinkingLevel = parent.thinkingLevel;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — all assertions in `test/profiles.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add profiles.ts test/profiles.test.ts
git commit -m "feat: add subagent profile loading and resolution"
```

---

### Task 2: Adopt resolved config in `run.ts`

**Files:**
- Modify: `run.ts:95-99` (the model/thinking derivation)

**Interfaces:**
- Consumes: nothing new. `runSingleAgent` keeps its existing signature.
- Produces: none (internal change). The `dispatchDefaults` param now means "pre-resolved per-task `{ model, thinkingLevel }`".

- [ ] **Step 1: Replace the derivation block**

Replace lines 95-99:

```ts
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
```

with:

```ts
	if (dispatchDefaults.model) args.push("--model", dispatchDefaults.model);
	if (dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
```

- [ ] **Step 2: Update the local `model` reference**

In `run.ts` the `currentResult` object uses `model,` (the old local). Change it to `model: dispatchDefaults.model,`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no unused `agent.model`/`inheritsDispatchConfig` references remain. If `agent` becomes unused in the block, confirm it is still used elsewhere in the function (it is — for name/systemPrompt/tools lookup).

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add run.ts
git commit -m "refactor: run.ts applies pre-resolved model/thinking"
```

---

### Task 3: Validate + resolve in `dispatch.ts`

**Files:**
- Modify: `dispatch.ts` (imports, `DispatchParams`, top of `executeDispatch`, each `runSingleAgent` call site)

**Interfaces:**
- Consumes: `loadProfiles`, `validateProfiles`, `resolveProfile`, `SubagentProfile` from `./profiles.ts`.
- Produces: `executeDispatch` gains an optional 7th parameter `profiles?: Record<string, SubagentProfile>` defaulting to `loadProfiles(ctx.cwd, ctx.isProjectTrusted())`. `DispatchParams.task`/`chain` items and `DispatchParams.profile` accept `profile?: string`. Each task resolves to a `DispatchDefaults` passed to `runSingleAgent`.

- [ ] **Step 1: Add imports and `profile` fields to `DispatchParams`**

```ts
import {
  loadProfiles,
  resolveProfile,
  validateProfiles,
  type SubagentProfile,
} from "./profiles.ts";
```

In `DispatchParams`:
```ts
export interface DispatchParams {
	agent?: string;
	task?: string;
	profile?: string;
	tasks?: { agent: string; task: string; profile?: string; cwd?: string }[];
	chain?: { agent: string; task: string; profile?: string; cwd?: string }[];
	agentScope?: "user" | "project" | "both";
	confirmProjectAgents?: boolean;
	cwd?: string;
}
```

- [ ] **Step 2: Load profiles + add validation before routing**

Change the signature to:
```ts
export async function executeDispatch(
	ctx: DispatchContext,
	params: DispatchParams,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	agentScope: "user" | "project" | "both",
	discovery: AgentDiscoveryResult,
	profiles: Record<string, SubagentProfile> = loadProfiles(ctx.cwd, ctx.isProjectTrusted()),
): Promise<AgentToolResult<SubagentDetails>> {
```

Replace:
```ts
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	const dispatchDefaults: DispatchDefaults = {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel: ctx.thinkingLevel,
	};
```

with:
```ts
	const agents = discovery.agents;
	const confirmProjectAgents = params.confirmProjectAgents ?? true;

	const parentDefaults: DispatchDefaults = {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel: ctx.thinkingLevel,
	};

	const resolveFor = (agentName: string | undefined, profileName: string | undefined): DispatchDefaults => {
		const agentConfig = agentName ? agents.find((a) => a.name === agentName) : undefined;
		return resolveProfile(profileName ? profiles[profileName] : undefined, agentConfig, parentDefaults);
	};

	const requestedProfiles: (string | undefined)[] = [];
	if (params.chain) for (const s of params.chain) requestedProfiles.push(s.profile);
	if (params.tasks) for (const t of params.tasks) requestedProfiles.push(t.profile);
	requestedProfiles.push(params.profile);
	const invalid = validateProfiles(requestedProfiles, profiles);
	if (invalid.length > 0) {
		const validNames = Object.keys(profiles).join(", ") || "none";
		return {
			content: [{
				type: "text",
				text: `Unknown subagent profile(s): ${invalid.join(", ")}. Available profiles: ${validNames}.`,
			}],
			details: makeDetails("single")([]),
			isError: true,
		};
	}
```

Note: `makeDetails` is referenced before its `const` declaration in the current file — move this validation block to *after* `makeDetails` is defined (it currently is defined just below the mode-count block). Place the validation right after the `makeDetails` definition.

- [ ] **Step 3: Resolve per task at each `runSingleAgent` call site**

Chain call site — change the `runSingleAgent(...)` call's second argument from `dispatchDefaults` to `resolveFor(step.agent, step.profile)`.

Parallel call site — change `dispatchDefaults` to `resolveFor(t.agent, t.profile)`.

Single call site — change `dispatchDefaults` to `resolveFor(params.agent, params.profile)`.

(This leaves the call-site arguments as a single `DispatchDefaults` object, so the call shape is otherwise unchanged.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — `makeDetails` referenced before declaration (step 2 placement) is a runtime TDZ issue, not caught by typecheck; instead verify ordering. Typecheck should PASS if ordering is correct. Verify no leftover `dispatchDefaults` references.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add dispatch.ts
git commit -m "feat: validate and resolve subagent profiles in dispatch"
```

---

### Task 4: Expose `profile` param + guidance in `index.ts`

**Files:**
- Modify: `index.ts` (`TaskItem`, `ChainItem`, `SubagentParams`, tool `description`, optional `promptGuidelines`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `profile` available to the model in single/parallel/chain modes.

- [ ] **Step 1: Add `profile` to the schemas**

In `TaskItem` and `ChainItem`:
```ts
	profile: Type.Optional(Type.String({ description: "Execution profile (model+thinking) from settings subagent.profiles, e.g. 'low'|'medium'|'high'|'expert'. Omit to use the agent's own model or the current settings." })),
```

In `SubagentParams` (single mode):
```ts
	profile: Type.Optional(Type.String({ description: "Execution profile for this single task (see subagent.profiles in settings). Omit to fall back." })),
```

- [ ] **Step 2: Update the tool description**

Append a sentence to the `description` array:
`Profiles (model + thinking level) are defined in settings.json under subagent.profiles (e.g. low/medium/high/expert); pass one per task to control the subagent's model and thinking. Omit to use the agent's own model, then the current model/settings.`

Optionally add to `promptGuidelines`:
```ts
promptGuidelines: [
	"Use subagent profile='low' for simple lookups/quick tasks, 'medium' for default work, 'high' for complex reasoning, 'expert' for the hardest architectural/novel problems. Profiles are defined in settings.json subagent.profiles.",
],
```

- [ ] **Step 3: Typecheck + tests**

Run: `npm run typecheck` then `npm test`
Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add index.ts
git commit -m "feat: expose subagent profile param and guidance"
```

---

### Task 5: Dispatch-level before-spawn validation test

**Files:**
- Create: `test/dispatch.test.ts`

**Interfaces:**
- Consumes: `executeDispatch` (with optional `profiles` param), `DispatchContext`, `DispatchParams`, a stubbed `AgentDiscoveryResult`.
- Produces: none.

- [ ] **Step 1: Write the failing test**

```ts
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
```

Note: the second test asserts validation itself does not error. Real spawning is not exercised deterministically here; the important gate (invalid → error before spawn) is the first test.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test --import tsx test/dispatch.test.ts`
Expected: first test FAILS if `executeDispatch` doesn't yet take `profiles` / validate (but those exist after Task 3, so if running after Task 3, it may pass — this task exists to lock the behavior in with a regression test). If it passes, that's acceptable; the point is the committed test guards future regressions.

- [ ] **Step 3: Adjust to pass**

If the second test fails because spawning errors (the stubbed agent has no real process to run), narrow it: keep only the first (invalid → error) test and drop the second, since spawning behavior isn't the subject under test. Confirm `npm test` passes.

- [ ] **Step 4: Run full suite + typecheck**

Run: `npm run typecheck` and `npm test`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add test/dispatch.test.ts
git commit -m "test: guard against spawning on invalid profile"
```

---

## Self-Review

- **Spec coverage:** sections 1 (schema — Task 1), 2 (fallback chain — Task 1 `resolveProfile`), 3 (tool API/validation — Tasks 3+4), 4 (module breakdown — Tasks 1-4), 5 (error handling — Tasks 1,3), 6 (testing — Tasks 1,5). All covered.
- **Placeholder scan:** no TBD/TODO; every code step has concrete code.
- **Type consistency:** `resolveProfile` returns `DispatchDefaults`; `runSingleAgent`'s second param is `DispatchDefaults`; `validateProfiles` returns `string[]`; `loadProfiles` returns `Record<string, SubagentProfile>` — all consistent across tasks.
