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
- **Extension load must never throw.** A missing/unreadable agents dir, bad frontmatter, or unreadable file may only shorten the advertised list, never abort registration. **Task 1-2 shipped this constraint violated** — see *Review Findings* below and **Task 4**, which restores it at the source.
- **No config flag** — not gated behind `enableProfiles` or anything else.
- **Indentation follows the file:** tabs in `agents.ts`, `index.ts`, `types.ts`; 2 spaces in `test/*.test.ts`.
- **Commit only what a task changes.** Your `enableProfiles` WIP is now committed (`6a706b8`), so the tree starts clean. Stage the explicit paths each task names; if `git status --short` ever shows a file you did not touch, leave it unstaged and say so.

---

## Review Findings & Rulings

Recorded after Tasks 1-2 shipped. Both findings were reproduced against the working tree,
not accepted on report.

### Finding 1 — Critical, plan-mandated: load-time discovery can abort registration

**Ruling: the constraint governs.** The plan contradicted itself: Global Constraints said
extension load must never throw, while Task 2 Step 3 mandated an unguarded
`discoverAgents(process.cwd(), "both")`. That is a plan bug, and the shipped code inherits
it.

Reproduced — a `.md` whose frontmatter contains `description: [`:

```
$ discoverAgents(<dir with bad.md>, "project")
THREW: YAMLParseError Flow sequence in block collection must be sufficiently indented
and end with a ]
```

`agents.ts:88` calls `parseFrontmatter` outside the `try` that guards `readFileSync`
(`:82-85`), and `parseFrontmatter` exposes no error-return variant. `loader.js:466` wraps
extension load and yields `{ extension: null, error: "Failed to load extension: …" }`, so
one bad file means the `subagent` tool never registers. The repro also loses the
*valid* `foo.md` sitting beside it — the failure is per-directory, not per-file.

**Fixed in Task 4, in `loadAgentsFromDir`, not with a `try/catch` around the load-time
call.** Two reasons: the identical throw already escapes `execute()`'s per-call discovery
(pre-existing, and a load-site catch would leave it open), and `agents.ts`'s own
`parseToolList` comment already states the per-file-skip policy that the unguarded parse
contradicts.

### Finding 2 — model-facing string defect: stray literal `]`

**Ruling: fix it, as its own commit.** `index.ts:116` reads `}\``, with a `]` before the
closing backtick, so the rendered `Profiles:` sentence ends
`…omit to use the agent's own model/settings.].` — observed tail from a live registration
capture:

```
"s one of these names per task to control the subagent's model and thinking; omit to use the agent's own model/settings.]"
```

Two corrections to the finding as reported:

- **Both branches, not one.** Line 116 sits after the entire
  `registeredProfileNames.length > 0 ? … : …` interpolation, so the bracket is appended
  whether or not profiles are defined. It is not conditional on the empty branch.
- **Attribution.** `git blame -L 116,116` → `2fae34d "Add 'profiles' to subagent"`, not
  `6a706b8`. Pre-existing; the `enableProfiles` default-off change only made its branch
  the common one.

Kept out of Task 4's commit so a reviewer can accept or reject each diff independently.

### Baseline at time of writing

`npm run typecheck` exits 0; `npm test` reports **17/17 pass**. Tasks 1 and 2 are
committed (`2ac7920`, `b07c878`); Task 3 (README) is not started.

**Execution order from here: Task 4 → Task 5 → Task 3.** Task 3 is documented last on
purpose but runs last, since its README text describes Task 4's skip behavior and Task 5's
corrected string.

---

### Task 1: `formatAgentNames` pure formatter

**Status: executed, committed `2ac7920`.** Steps below are retained as the record of what
was built and re-run as regression checks.

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

**Status: code executed, committed `b07c878`; verification pending.** Steps 1-7 are done
and the shipped strings were captured live (see Task 2 Steps 8-12, rewritten: the harness
form originally documented does not run). Step 3's `discoverAgents` call is the site of
Critical Finding 1 — do **not** wrap it in `try/catch`; the guard lands in Task 4.

**Files:**
- Modify: `index.ts:28` (agents import), a new import line after `index.ts:31`, after `index.ts:46` (composition block), `index.ts:68` (`agent` param), `index.ts:84-93` (`description` array), `index.ts:101-104` (`promptGuidelines`)
- Create: nothing. The Step 8 capture is an inline `node --import tsx -e` script run from the repo, so no harness file exists in the tree or in `/tmp`.

**Interfaces:**
- Consumes: `formatAgentNames(agents, maxItems) -> { text, remaining }` and `MAX_LISTED_AGENTS` from Task 1; `discoverAgents(cwd, scope) -> AgentDiscoveryResult` (existing).
- Produces: the registered `subagent` tool's `description`, `parameters.properties.agent.description`, and a third `promptGuidelines` entry. Nothing else in the codebase reads these.

- [ ] **Step 1: Confirm a clean starting point**

Run: `git status --short && git log --oneline -1`
Expected: no modified files (your `enableProfiles` WIP landed in `6a706b8`, so `index.ts` is clean), and `index.ts:40` reads `const registeredGlobalProfiles = profilesEnabled ? loadProfilesFrom(globalSettingsPath) : {};`. If unrelated files *are* modified, stop and ask before touching them.

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

- [ ] **Step 8: Build the verification capture**

> **This step's original form did not work and has been replaced.** A harness file at
> `/tmp/agent-advert.ts` fails: `ERR_PACKAGE_PATH_NOT_EXPORTED`, no `"exports"` main
> defined in `@earendil-works/pi-coding-agent/package.json`, because the out-of-tree entry
> lands on tsx's CJS require path. Not chased further — the form below is verified and
> avoids the problem by keeping the entry an inline `-e` script run from the repo, which
> also means nothing is written into the repo (`tsconfig.json` includes `*.ts`, so a root
> harness file would be typechecked and would have to be deleted before every commit).

Run from the repository directory:

```bash
cd /Users/tinyphat/.pi/agent/extensions/subagent && node --import tsx -e '
import("/Users/tinyphat/.pi/agent/extensions/subagent/index.ts").then((m) => {
  let c; m.default({ registerTool: (d) => { c = d; } });
  const d = c.description;
  console.log("--- AVAILABLE AGENTS ---");
  console.log(d.slice(d.indexOf("Available agents"), d.indexOf("Profiles:")).trim());
  console.log("\n--- AGENT PARAM ---\n" + JSON.stringify(c.parameters.properties.agent.description));
  console.log("\n--- NESTED agent (must be unchanged) ---");
  console.log(JSON.stringify(c.parameters.properties.tasks.items.properties.agent));
  console.log(JSON.stringify(c.parameters.properties.chain.items.properties.agent));
  console.log("\n--- GUIDELINES (" + c.promptGuidelines.length + ") ---");
  for (const g of c.promptGuidelines) console.log(" - " + g);
  console.log("\n--- DESCRIPTION TAIL ---\n" + JSON.stringify(d.slice(-120)));
})'
```

This registers the real extension against a stub `pi` object and prints exactly what the
model would see. Re-run it after every change to these strings.

- [ ] **Step 9: Verify the populated list (user agents only, no overflow)**

Observed output of Step 8 on this machine, which is the assertion for this step:

```
--- AVAILABLE AGENTS ---
Available agents: planner (user), reviewer (user), scout (user), worker (user). Captured
at startup from the launch directory, so project-local agents added since then are
missing. Passing an unknown name returns the full current list.
--- GUIDELINES (3) ---
```

Check all four: no `+K more` (4 names < 12), the param description carries
`the same names apply to items in tasks/chain`, both nested `agent` schemas read exactly
`"Name of the agent to invoke"`, and `promptGuidelines` has length 3.

The `DESCRIPTION TAIL` line is where Finding 2 shows up: it currently ends
`…own model/settings.]`. Treat that as Task 5's expected failure, not Task 2's.

- [ ] **Step 10: Verify project discovery against a real filesystem**

The original step changed `cd` into a scratch directory, which breaks the module
resolution Step 8 depends on. Use scope `"project"` instead, which reads only the temp
directory and needs no cwd change:

```bash
S=$(mktemp -d) && mkdir -p "$S/.pi/agents"
printf -- '---\nname: foo\ndescription: scratch project agent\n---\nbody\n' > "$S/.pi/agents/foo.md"
cd /Users/tinyphat/.pi/agent/extensions/subagent && node --import tsx -e "
import('/Users/tinyphat/.pi/agent/extensions/subagent/agents.ts').then((m) => {
  const r = m.discoverAgents('$S', 'project');
  console.log(JSON.stringify(m.formatAgentNames(r.agents, 12)));
})"; rm -rf "$S"
```

Expected: `{"text":"foo (project)","remaining":0}` — real file → real discovery → real
`(project)` tag.

**Scope this honestly.** It proves project-scope discovery and tagging. It does *not*
prove the merged project-before-user sort, because scope `"project"` never loads user
agents; that ordering is asserted by the Task 1 unit tests on synthetic input, which is
the only place both sources can be controlled. Do not describe Step 10 as an end-to-end
ordering proof.

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

Expected (observed, from the real module rather than a re-implementation):

```
CAP: agent00 (user), agent01 (user), … agent11 (user) +3 more
EMPTY: {"text":"","remaining":0}
```

- [ ] **Step 12: Verify the empty-case sentences end to end**

`getAgentDir()` resolves through `os.homedir()`, which honors `$HOME`, so an empty `HOME`
plus the repo (which has no `.pi/agents`) yields zero agents of either source. Run the
Step 8 capture with `HOME` overridden, from the repo directory so resolution still works:

```bash
EMPTY=$(mktemp -d) && cd /Users/tinyphat/.pi/agent/extensions/subagent && HOME="$EMPTY" node --import tsx -e '<the Step 8 script>' ; cd /Users/tinyphat && rm -rf "$EMPTY"
```

Observed output, which is the assertion:

```
EMPTY CASE SENTENCE: Available agents: none found at startup; project-local agents in
.pi/agents may still exist. Passing an unknown name returns the full current list.
EMPTY CASE PARAM: "Name of the agent to invoke (for single mode; the same names apply to
items in tasks/chain). No agents were found at startup; passing any name returns the current list."
PROFILES PART: Profiles: no profiles defined. Omit the profile parameter an
```

No `(user)`/`(project)` names anywhere, and no `Valid:` clause in the param. The
`Profiles: no profiles defined` tail is expected: with `$HOME` redirected, `settings.json`
is unreadable so profiles are off — correct behavior from `6a706b8`, not a regression here.

- [ ] **Step 13: Run the full suite**

Run: `npm test`
Expected: PASS for `test/agents.test.ts`, `test/dispatch.test.ts`, `test/profiles.test.ts`; 0 failures. These now exercise your committed `enableProfiles` code; if either of the last two fails in a way unrelated to agent names, report it rather than fixing it.

- [ ] **Step 14: Commit**

```bash
git add index.ts
git commit -m "feat: advertise valid subagent agent names in the tool description"
```

Verify after: `git show --stat HEAD` lists only `index.ts`, and `git status --short` is clean.

---

### Task 3: Document the behavior and re-verify

**Status: not started.** `README.md` is untouched by `2ac7920`/`b07c878`, so the line
references below are still accurate. Do this task *after* Tasks 4-5, since Task 4 adds a
behavior the Limits section should mention.

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

An agent file whose frontmatter cannot be parsed is skipped silently, along with any file missing `name` or a string `description`; it disappears from discovery rather than being reported. If an agent seems to be missing, check its frontmatter — a colon-introduced value such as `description: [ …` starts a YAML flow sequence and must be quoted.
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

### Task 4: Stop a malformed agent file from aborting registration (Critical Finding 1)

**Files:**
- Modify: `agents.ts:88` (the unguarded `parseFrontmatter` call inside `loadAgentsFromDir`)
- Modify: `test/agents.test.ts` (add `fs`/`os`/`path`/`discoverAgents` imports and one test)

**Interfaces:**
- Consumes: nothing new.
- Produces: `discoverAgents` that never throws on per-file YAML errors — the guarantee Task 2's load-time call at `index.ts:59` and `execute()`'s per-call discovery both depend on. Signatures are unchanged, so no caller edits.

- [ ] **Step 1: Write the failing test**

Add to `test/agents.test.ts` (2-space indent), extending the existing import to
`import { discoverAgents, formatAgentNames, type AgentConfig } from "../agents.ts";` and
adding `import * as fs from "node:fs";`, `import * as os from "node:os";`,
`import * as path from "node:path";` alongside the existing two imports:

```ts
test("a malformed frontmatter file is skipped without taking down its siblings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-"));
  try {
    const agentsDir = path.join(root, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "foo.md"), "---\nname: foo\ndescription: project agent\n---\nbody\n");
    fs.writeFileSync(path.join(agentsDir, "bad.md"), "---\nname: bad\ndescription: [\n---\nbody\n");
    const result = discoverAgents(root, "project");
    assert.deepEqual(result.agents.map((a) => a.name), ["foo"]);
    assert.equal(formatAgentNames(result.agents, 12).text, "foo (project)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and confirm the documented failure**

Run: `cd /Users/tinyphat/.pi/agent/extensions/subagent && node --test --import tsx test/agents.test.ts`
Expected: FAIL with `YAMLParseError: Flow sequence in block collection must be sufficiently indented and end with a ]` — the pre-fix behavior reproduced by hand before this task was written. If it fails any other way, the test is wrong, not the code.

- [ ] **Step 3: Guard the parse at its source**

Replace `agents.ts:88`, the single line
`const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);`, with (tabs):

```ts
		let frontmatter: AgentFrontmatter;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
		} catch {
			// Frontmatter is real YAML and throws on malformed input. Skipping the file is
			// the only safe response: this loop runs at extension-load time as well as per
			// call (index.ts discovers agents on module load to advertise their names), and
			// loader.js turns any throw during load into a null extension — one bad file
			// would silently remove the whole subagent tool. Same policy as parseToolList
			// above: a single bad file shortens the list, it never takes down the directory.
			continue;
		}
```

Deliberately **no** `try/catch` at `index.ts:59`: the source guard also closes the
pre-existing per-call failure path, and a load-site catch would swallow unrelated
registration errors behind an empty list.

- [ ] **Step 4: Confirm the fix and the regression it closes**

Run: `node --test --import tsx test/agents.test.ts`
Expected: PASS — 8/8, the new test included.

Run the Task 2 Step 10 command with `bad.md` added next to `foo.md`:

```bash
S=$(mktemp -d) && mkdir -p "$S/.pi/agents"
printf -- '---\nname: foo\ndescription: ok\n---\nbody\n' > "$S/.pi/agents/foo.md"
printf -- '---\nname: bad\ndescription: [\n---\nbody\n' > "$S/.pi/agents/bad.md"
cd /Users/tinyphat/.pi/agent/extensions/subagent && node --import tsx -e "
import('/Users/tinyphat/.pi/agent/extensions/subagent/agents.ts').then((m) => {
  console.log(JSON.stringify(m.formatAgentNames(m.discoverAgents('$S', 'project').agents, 12)));
})"; rm -rf "$S"
```

Expected: `{"text":"foo (project)","remaining":0}` — previously `THREW: YAMLParseError`.
This is the same input that killed registration before Step 3, now reduced to one dropped
file.

- [ ] **Step 5: Full validation, then commit**

Run: `npm run typecheck && npm test`
Expected: exit 0; 18/18 pass (17 baseline + the new test).

```bash
git add agents.ts test/agents.test.ts
git commit -m "fix: skip agent files with malformed frontmatter instead of failing discovery"
```

---

### Task 5: Drop the stray bracket from the model-facing description (Finding 2)

**Files:**
- Modify: `index.ts:116` only

**Interfaces:**
- Consumes: nothing.
- Produces: a clean `Profiles:` sentence tail in both branches. No code reads this string.

- [ ] **Step 1: Confirm the defect in the rendered string, not just the source**

Run the Task 2 Step 8 capture and read `--- DESCRIPTION TAIL ---`.
Expected: ends `…own model/settings.]` — one character too many, present regardless of
which side of the `registeredProfileNames.length > 0` ternary is taken, because the `]`
sits after the interpolation closes on line 116.

- [ ] **Step 2: Remove the bracket**

On `index.ts:116`, change `			}]`,` to `			}``,` — delete only the `]`. The `}` closes the
ternary interpolation and the backtick closes the template literal; the array's own
`]` is on line 117 (`		].join(" "),`), which is what the stray character was mistaken for.

- [ ] **Step 3: Verify the tail is clean and nothing else moved**

Re-run the Task 2 Step 8 capture.
Expected: tail ends `…own model/settings."` with no `]`, and the Available-agents sentence,
param text, nested schemas and guideline count are byte-identical to Step 9's recorded
output. Then `npm run typecheck && npm test` (18/18).

- [ ] **Step 4: Commit alone**

```bash
git add index.ts
git commit -m "fix: drop stray bracket terminating the subagent profiles description"
```

Its own commit, so Task 4's behavior change and this one-character text change can be
reviewed and reverted independently.

---

## Definition of Done

- `npm run typecheck` exits 0; `npm test` passes at 18/18 (17 baseline + Task 4's
  malformed-file test). Baseline measured before these tasks: typecheck exit 0, 17/17.
- A real `registerTool` capture shows the same capped, project-first name list in both the description and the `agent` param, `TaskItem.agent`/`ChainItem.agent` unchanged, and exactly three `promptGuidelines`.
- All branches are observed executing, not inferred: populated list (Task 2 Step 9),
  project discovery from a real filesystem (Step 10), cap (`+3 more`, Step 11), empty
  (Step 12), malformed file skipped (Task 4 Step 4).
- A directory containing a malformed agent `.md` registers the tool and advertises its
  valid siblings (spec requirement 8).
- The rendered description contains no stray `]`.
- Your `enableProfiles` work stays intact in `6a706b8`; this plan adds Tasks 3-5 on top of
  `2ac7920` and `b07c878`.
