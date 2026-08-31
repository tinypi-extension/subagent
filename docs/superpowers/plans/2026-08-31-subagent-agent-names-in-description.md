# Advertise Agent Names in the Subagent Tool Description — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the valid subagent names into the `subagent` tool description and top-level `agent` parameter hint, so the model stops inventing names and burning a failed spawn per attempt.

**Architecture:** One pure, total formatter (`formatAgentNames`) turns a discovered `AgentConfig[]` into a capped, project-first, `(source)`-tagged name list. `index.ts` interpolates that single string twice at module load — the tool description and the `agent` param hint — plus one agent-name-free `promptGuidelines` bullet. Runtime behavior is untouched: `execute()` still discovers per call from `ctx.cwd`, and `run.ts`'s `Unknown agent` error remains authoritative.

**Tech Stack:** TypeScript (ES2022, NodeNext, `strict`), loaded directly as `.ts` by pi's extension loader via `tsx`; `typebox` schemas; `node:test` + `node:assert/strict`.

Spec: `docs/superpowers/specs/2026-08-31-subagent-agent-names-in-description-design.md`

## Global Constraints

- **Validity, not routing.** Never emit an agent's `description` in any prompt text. Names only.
- **Order:** project agents before user agents; alphabetical within each group; `(project)` / `(user)` tag on every name.
- **Cap:** `MAX_LISTED_AGENTS = 12`, defined in `types.ts`. Overflow renders as ` +K more`.
- **Exactly two insertion points:** the tool `description` and the top-level `agent` param. `TaskItem.agent` (`index.ts:49`) and `ChainItem.agent` (`index.ts:56`) **must not change** — all three modes share one list.
- **`promptGuidelines`** gains exactly one bullet, and it must name the tool (`subagent`) while containing **no** agent names (per `docs/extensions.md`: guidelines must name their own tool).
- **No literal `.pi`** in new strings: interpolate `CONFIG_DIR_NAME`, as `index.ts:87` already does.
- **Extension load must never throw.** A missing/unreadable agents dir or bad frontmatter may only shorten the list, never abort registration.
- **No config flag** — not gated behind `enableProfiles` or anything else.
- **Indentation follows the file:** tabs in `agents.ts`, `index.ts`, `types.ts`; 2 spaces in `test/*.test.ts`.
- **Do not commit the pre-existing WIP.** The working tree already has unrelated uncommitted changes to `dispatch.ts`, `profiles.ts`, `test/profiles.test.ts`, and two `enableProfiles` hunks in `index.ts`. Stage only the paths each task names, and use `git add -p index.ts` where flagged.

---

### Task 1: `formatAgentNames` pure formatter

**Files:**
- Modify: `types.ts` (after line 11, `MAX_CONCURRENCY`)
- Modify: `agents.ts:149-157` — replace the unreferenced `formatAgentList` with `formatAgentNames`
- Create: `test/agents.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `formatAgentNames(agents: AgentConfig[], maxItems: number): { text: string; remaining: number }` from `agents.ts` — `text` is `name (source)` pairs joined by `", "`, project-first; `remaining` is the count of dropped names; `""` (never `"none"`) when there is nothing to list. Also produces `MAX_LISTED_AGENTS: number` from `types.ts`. Task 2 consumes both.
- Removes: `formatAgentList` — grep-verified unreferenced outside its own definition, and its `name (source): description` output contradicts the names-only constraint.

- [ ] **Step 1: Write the failing tests**

Create `test/agents.test.ts` (2-space indent, matching `test/profiles.test.ts`):

```ts
// test/agents.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAgentNames, type AgentConfig } from "../agents.ts";

function agent(name: string, source: "user" | "project"): AgentConfig {
  return { name, source, description: `${name} does things`, systemPrompt: "", filePath: `/agents/${name}.md` };
}

test("formatAgentNames lists project agents before user agents, alphabetical within each group", () => {
  const r = formatAgentNames(
    [agent("worker", "user"), agent("zulu", "project"), agent("planner", "user"), agent("alpha", "project")],
    12,
  );
  assert.equal(r.text, "alpha (project), zulu (project), planner (user), worker (user)");
  assert.equal(r.remaining, 0);
});

test("formatAgentNames does not depend on input order", () => {
  // discoverAgents returns Map insertion order (user first), not sorted output.
  const r = formatAgentNames([agent("zeta", "user"), agent("beta", "project")], 12);
  assert.equal(r.text, "beta (project), zeta (user)");
});

test("formatAgentNames does not mutate the input array", () => {
  const input = [agent("worker", "user"), agent("foo", "project")];
  formatAgentNames(input, 12);
  assert.deepEqual(input.map((a) => a.name), ["worker", "foo"]);
});

test("formatAgentNames caps at maxItems and reports the dropped count", () => {
  const input = ["a", "b", "c", "d", "e"].map((n) => agent(n, "user"));
  const r = formatAgentNames(input, 3);
  assert.equal(r.text, "a (user), b (user), c (user)");
  assert.equal(r.remaining, 2);
});

test("truncation drops user-level names before any project agent", () => {
  const r = formatAgentNames(
    [agent("zulu", "project"), agent("alpha", "user"), agent("bravo", "user"), agent("charlie", "user"), agent("delta", "user")],
    2,
  );
  assert.equal(r.text, "zulu (project), alpha (user)");
  assert.equal(r.remaining, 3);
});

test("formatAgentNames with maxItems 0 lists nothing but still counts the rest", () => {
  const r = formatAgentNames([agent("planner", "user"), agent("scout", "user")], 0);
  assert.equal(r.text, "");
  assert.equal(r.remaining, 2);
});

test("formatAgentNames returns empty text for no agents", () => {
  assert.deepEqual(formatAgentNames([], 12), { text: "", remaining: 0 });
});
```

- [ ] **Step 2: Run them and confirm they fail for the right reason**

Run: `cd /Users/tinyphat/.pi/agent/extensions/subagent && node --test --import tsx test/agents.test.ts`
Expected: FAIL at import — `SyntaxError: The requested module '../agents.ts' does not provide an export named 'formatAgentNames'`. Any other failure means the harness is broken, not the missing export.

- [ ] **Step 3: Add the cap constant**

In `types.ts`, insert after `export const MAX_CONCURRENCY = 4;` (tabs):

```ts
// How many agent names the tool description + `agent` param hint list before
// collapsing to "+K more". Comfortably above the agents shipped in agents/, so a
// normal install lists every name, while a large library cannot grow the prompt.
export const MAX_LISTED_AGENTS = 12;
```

- [ ] **Step 4: Replace `formatAgentList` with `formatAgentNames`**

In `agents.ts`, delete lines 149-157 (`formatAgentList`, the whole function) and put this in its place (tabs):

```ts
/**
 * Rank used to order names in prompt text: project agents first, then user agents.
 * The advertised list is capped by `MAX_LISTED_AGENTS` and truncated from the tail, so
 * the repo-specific names are the ones guaranteed a slot.
 */
const SOURCE_RANK: Record<AgentConfig["source"], number> = { project: 0, user: 1 };

/**
 * Render agent names for the tool description and the top-level `agent` param hint.
 *
 * Deliberately names only. An agent's `description` is long prose, and repeating one per
 * name on every prompt turn buys routing quality this feature does not claim — its goal
 * is giving the model legal values to copy. See
 * docs/superpowers/specs/2026-08-31-subagent-agent-names-in-description-design.md.
 *
 * `text` holds up to `maxItems` entries as `name (source)`, project-first and
 * alphabetical within each source; `remaining` is how many were dropped, so the caller
 * can append `+K more`. A dropped name still self-corrects: `run.ts` answers an unknown
 * agent with the full current list.
 *
 * Pure and total: returns `""` (not `"none"`) when there is nothing to list, so the
 * caller picks the empty-case wording, and never mutates `agents`.
 */
export function formatAgentNames(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	const sorted = [...agents].sort((a, b) => {
		const bySource = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
		return bySource !== 0 ? bySource : a.name.localeCompare(b.name);
	});
	const listed = sorted.slice(0, Math.max(0, maxItems));
	return {
		text: listed.map((a) => `${a.name} (${a.source})`).join(", "),
		remaining: sorted.length - listed.length,
	};
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test --import tsx test/agents.test.ts`
Expected: PASS, 7/7, no failures.

- [ ] **Step 6: Verify nothing referenced the deleted function, and typecheck**

Run: `grep -rn "formatAgentList" --include="*.ts" . --exclude-dir=node_modules && echo "STILL REFERENCED"`
Expected: no output, no `STILL REFERENCED` line (the `&&` short-circuits because grep exits 1).
Run: `npm run typecheck`
Expected: exit 0, no diagnostics.

- [ ] **Step 7: Commit**

```bash
git add agents.ts types.ts test/agents.test.ts
git commit -m "feat: add capped project-first agent name formatter"
```

---

### Task 2: Wire the name list into the description, param hint, and guideline

**Files:**
- Modify: `index.ts:28` (agents import), a new import line after `index.ts:31`, after `index.ts:46` (composition block), `index.ts:68` (`agent` param), `index.ts:84-93` (`description` array), `index.ts:101-104` (`promptGuidelines`)
- Create: `/tmp/agent-advert.ts` (throwaway verification harness — lives outside the repo on purpose, so `tsconfig.json`'s `include: ["*.ts", ...]` never typechecks it and it is never committed)

**Interfaces:**
- Consumes: `formatAgentNames(agents, maxItems) -> { text, remaining }` and `MAX_LISTED_AGENTS` from Task 1; `discoverAgents(cwd, scope) -> AgentDiscoveryResult` (existing).
- Produces: the registered `subagent` tool's `description`, `parameters.properties.agent.description`, and a third `promptGuidelines` entry. Nothing else in the codebase reads these.

- [ ] **Step 1: Protect the unrelated WIP in `index.ts`**

Run: `git diff index.ts`
Expected: exactly two hunks — `registeredGlobalProfiles` gaining the `profilesEnabled ? … : {}` guard, and removal of `if (!profilesEnabled) return;` from the exported function. These are not ours. Every commit in this task stages `index.ts` with `git add -p index.ts`, selecting only the hunks we add. If the tree shows more, stop and ask the user before proceeding.

- [ ] **Step 2: Extend the imports**

Replace `index.ts:28` (tabs — keep the existing `type AgentScope` import form, and keep alphabetical member order):

```ts
import { type AgentScope, discoverAgents, formatAgentNames } from "./agents.ts";
```

Then add one new import line immediately after `index.ts:31` (the `./render.ts` line). `index.ts` does not import from `./types.ts` today, so this is a new intra-package import:

```ts
import { MAX_LISTED_AGENTS } from "./types.ts";
```

This adds no import cycle: `types.ts` imports `AgentScope` from `./agents.ts` as `import type` only (erased at runtime), and `agents.ts` never imports `types.ts`.

- [ ] **Step 3: Add the composition block after the profiles block**

Insert immediately after `index.ts:46` (the end of the `profileHint` ternary), before the blank line and `const TaskItem = …`:

```ts
// Bake the agent names that exist at load time into the tool description and the
// top-level `agent` hint, so the model has legal names to copy instead of inventing
// them. Scope "both" and the launch directory: extensions load once per process, so
// this is the best available guess at the project set.
//
// Two stale-by-construction cases, both self-healing in one round-trip: agents created
// after startup are missing, a removed agent may still be advertised, and launching from
// a parent directory finds no project agents at all. The authoritative set is always the
// per-call discoverAgents(ctx.cwd, agentScope) in execute() below, and run.ts answers an
// unknown name with the full current list.
const agentAdvert = formatAgentNames(discoverAgents(process.cwd(), "both").agents, MAX_LISTED_AGENTS);
const agentNamesText =
	agentAdvert.remaining > 0 ? `${agentAdvert.text} +${agentAdvert.remaining} more` : agentAdvert.text;
const hasAgentNames = agentAdvert.text.length > 0;
// One string, interpolated in both places below, so the two can never disagree.
const availableAgentsSentence = hasAgentNames
	? `Available agents: ${agentNamesText}. Captured at startup from the launch directory, so project-local agents added since then are missing. Passing an unknown name returns the full current list.`
	: `Available agents: none found at startup; project-local agents in ${CONFIG_DIR_NAME}/agents may still exist. Passing an unknown name returns the full current list.`;
const agentParamHint = hasAgentNames
	? `Name of the agent to invoke (for single mode; the same names apply to items in tasks/chain). Valid: ${agentNamesText}. Passing an unknown name returns the current list.`
	: `Name of the agent to invoke (for single mode; the same names apply to items in tasks/chain). No agents were found at startup; passing any name returns the current list.`;
```

- [ ] **Step 4: Put the list in the `description` array**

In the `description: [ … ].join(" ")` array, insert `availableAgentsSentence` as its own element between the `` `Other options is "user" and "project"` `` element and the `` `Profiles: …` `` element:

```ts
			`Other options is "user" and "project"`,
			availableAgentsSentence,
			`Profiles: ${registeredProfileSummary}. ${registeredProfileNames.length > 0
```

- [ ] **Step 5: Point the top-level `agent` param at the list**

Replace line 68 (tabs):

```ts
	agent: Type.Optional(Type.String({ description: agentParamHint })),
```

Do **not** touch `TaskItem.agent` or `ChainItem.agent` — both keep `"Name of the agent to invoke"`. The param hint above already tells the model the names apply to all three modes.

- [ ] **Step 6: Add the guideline bullet**

In `promptGuidelines`, append one entry after the existing profiles bullet (so the array literal ends):

```ts
			return [
				pick,
				"Project-level .pi/settings.json may define additional or overriding profiles beyond this global list, so the full set is resolved per-session.",
				"When calling subagent, choose an agent name from its Available agents list rather than inventing one; an unknown name returns the current list.",
			];
```

This bullet is intentionally free of agent names — a third copy of the list would cost the tokens this design exists to save. The existing `.pi/settings.json` bullet above it is pre-existing text, not ours to change.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 8: Build the verification harness**

Create `/tmp/agent-advert.ts`. It imports the real extension and captures what `pi.registerTool()` was handed — the exact text the model will see. No pi imports inside the file, because `/tmp` has no `node_modules` to resolve them from; the absolute path import resolves its own dependencies from the repo.

```ts
// /tmp/agent-advert.ts
import extension from "/Users/tinyphat/.pi/agent/extensions/subagent/index.ts";

let captured: any;
(extension as any)({ registerTool: (def: any) => { captured = def; } });

console.log("process.cwd():", process.cwd());
console.log("\n--- description ---\n" + captured.description);
console.log("\n--- agent param ---\n" + JSON.stringify(captured.parameters.properties.agent, null, 2));
console.log("\n--- TaskItem/ChainItem agent (must be unchanged) ---");
console.log(JSON.stringify(captured.parameters.properties.tasks.items.properties.agent));
console.log(JSON.stringify(captured.parameters.properties.chain.items.properties.agent));
console.log("\n--- promptGuidelines ---");
for (const g of captured.promptGuidelines) console.log("- " + g);
```

- [ ] **Step 9: Verify from the home directory (user agents only)**

Run: `cd /Users/tinyphat && npx --prefix /Users/tinyphat/.pi/agent/extensions/subagent tsx /tmp/agent-advert.ts`
Expected: `--- description ---` contains `Available agents: planner (user), reviewer (user), scout (user), worker (user).` with **no** `+K more` (4 < 12); the `agent param` JSON contains the same four names and the phrase `the same names apply to items in tasks/chain`; the two `TaskItem/ChainItem agent` lines read exactly `"Name of the agent to invoke"`; the guidelines list ends with the new `subagent` bullet.

If `npx --prefix` misbehaves, run `cd /Users/tinyphat && /Users/tinyphat/.pi/agent/extensions/subagent/node_modules/.bin/tsx /tmp/agent-advert.ts` instead.

- [ ] **Step 10: Verify project agents sort first (the ordering claim, end to end)**

```bash
SCRATCH=$(mktemp -d) && mkdir -p "$SCRATCH/.pi/agents"
printf -- '---\nname: foo\ndescription: scratch project agent\n---\nbody\n' > "$SCRATCH/.pi/agents/foo.md"
cd "$SCRATCH" && /Users/tinyphat/.pi/agent/extensions/subagent/node_modules/.bin/tsx /tmp/agent-advert.ts
```

Expected: `Available agents: foo (project), planner (user), reviewer (user), scout (user), worker (user).` — `foo (project)` **first**, proving both project discovery and the project-first sort from a real filesystem. Then clean up: `cd /Users/tinyphat && rm -rf "$SCRATCH"`.

- [ ] **Step 11: Verify the cap and the empty case**

Cap — 13 user-level-equivalent names is not installable without touching `~/.pi/agent/agents`, so drive `formatAgentNames` directly instead, which is what `agentNamesText` wraps:

```bash
cd /Users/tinyphat/.pi/agent/extensions/subagent && node --import tsx -e '
import("./agents.ts").then(({ formatAgentNames }) => {
  const a = (n, s) => ({ name: n, source: s, description: "", systemPrompt: "", filePath: "" });
  const many = [...Array(15).keys()].map((i) => a("agent" + String(i).padStart(2, "0"), "user"));
  const r = formatAgentNames(many, 12);
  console.log(r.text + (r.remaining > 0 ? ` +${r.remaining} more` : ""));
  console.log("empty:", JSON.stringify(formatAgentNames([], 12)));
});'
```

Expected: 12 names then ` +3 more`; `empty: {"text":"","remaining":0}`.

- [ ] **Step 12: Verify the empty-case sentences end to end**

`pi-coding-agent`'s `getAgentDir()` resolves from `os.homedir()`, which honors `$HOME`. Pointing `$HOME` at an empty directory from a directory with no `.pi/agents` therefore yields zero agents of either source — verified against the current code before this plan was written (`discoverAgents(cwd, "both")` returned `[]` under an empty `$HOME`). This is the only cheap way to observe the empty branch rather than reason about it:

```bash
EMPTY=$(mktemp -d) && cd "$EMPTY" && HOME="$EMPTY" /Users/tinyphat/.pi/agent/extensions/subagent/node_modules/.bin/tsx /tmp/agent-advert.ts; cd /Users/tinyphat && rm -rf "$EMPTY"
```

Expected: description contains `Available agents: none found at startup; project-local agents in .pi/agents may still exist.` with no `(user)`/`(project)` names anywhere; the `agent` param contains `No agents were found at startup; passing any name returns the current list.` and no `Valid:` clause. Also expect `Profiles: no profiles defined` — that string comes from the user's uncommitted `enableProfiles` WIP, not from this task; do not treat it as a regression.

- [ ] **Step 13: Run the full suite**

Run: `npm test`
Expected: PASS for `test/agents.test.ts`, `test/dispatch.test.ts`, `test/profiles.test.ts`; 0 failures. (The last two exercise the user's in-flight WIP; if either fails in a way unrelated to agent names, report it rather than fixing it.)

- [ ] **Step 14: Commit, hunk by hunk**

```bash
git add -p index.ts    # select ONLY the agent-name hunks: import, composition block,
                        # description element, param hint, guideline bullet. Skip the two
                        # enableProfiles hunks.
git commit -m "feat: advertise valid subagent agent names in the tool description"
```

Verify before committing: `git diff --cached index.ts` must contain no `enableProfiles`, `profilesEnabled ?`, or `if (!profilesEnabled) return;` lines. Confirm after: `git show --stat HEAD` should list only `index.ts`, and `git status --short` should still show `M index.ts` (the WIP survives, uncommitted).

---

### Task 3: Document the behavior and re-verify

**Files:**
- Modify: `README.md:14` (feature bullet), `README.md:99-112` (Agents section), `README.md:158-163` (Limits), `README.md:172` (test list)

**Interfaces:**
- Consumes: `MAX_LISTED_AGENTS` and the rendered sentences from Tasks 1-2 (quotes real output, not intent).
- Produces: nothing consumed by code.

- [ ] **Step 1: Feature bullet**

Replace `README.md:14`:

```markdown
- **Agent discovery.** Agents are loaded from your user agent directory and the project's agent directory (see [Configuration](#configuration)). The names available at startup are listed in the `subagent` tool description — project agents first — so the model has valid names to copy instead of inventing them (see [Limits](#limits)).
```

- [ ] **Step 2: Agents section note**

After `README.md:112` (`The \`name\` and \`description\` are required; …`) add:

```markdown
Only the `name` is advertised to the model, along with whether it came from the user or project directory. The `description` steers a subagent's own behavior but is not used to pick between agents — add agent files, then `/reload` (or restart pi) for their names to appear in the tool description.
```

- [ ] **Step 3: Limits entry**

Add as the last bullet of `## Limits`:

```markdown
- Agent names advertised in the tool description: max **12** listed (`MAX_LISTED_AGENTS`, `types.ts`), project agents first, the rest collapsed to `+K more`. Snapshot taken when the extension loads, from the directory pi was launched in — new or removed agents need a `/reload`. Calling an unknown name is not fatal: it returns the full current list.
```

- [ ] **Step 4: Test list**

Replace `README.md:172`:

```markdown
Tests: `test/agents.test.ts` (agent name formatting), `test/dispatch.test.ts` (orchestration) and `test/profiles.test.ts` (profile resolution/validation).
```

- [ ] **Step 5: Verify the documented numbers are true, not remembered**

Re-run the two commands from Task 2 Steps 10 and 11, plus `npm run typecheck && npm test`. Expected: the cap line shows 12 names + `+3 more`, the scratch-dir run shows `foo (project)` first, typecheck exits 0, all tests pass. If any README number disagrees with observed output, fix the README, not the observation.

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: document agent name advertising in the subagent tool description"
```

---

## Definition of Done

- `npm run typecheck` exits 0 and `npm test` passes.
- A real `registerTool` capture shows the same capped, project-first name list in both the description and the `agent` param, `TaskItem.agent`/`ChainItem.agent` unchanged, and exactly three `promptGuidelines`.
- All three branches are observed executing, not inferred: normal list (Task 2 Step 9), project-first (Step 10), and empty (Step 12).
- The user's `enableProfiles` WIP is still uncommitted in `dispatch.ts`, `profiles.ts`, `test/profiles.test.ts`, and `index.ts`.
- Spec constraints 1-7 each map to shipped, observed behavior.
