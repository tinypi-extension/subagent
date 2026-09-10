# Subagent — Advertise Agent Names in the Tool Description

## Goal

Tell the main agent which subagent names are valid, *before* it calls the tool, so it
stops inventing names and burning a failed spawn per attempt.

Today the `subagent` tool description advertises profiles (`index.ts:79-90`) but never
names an agent. `agent` is declared as a bare
`Type.String({ description: "Name of the agent to invoke" })`. The model learns the real
set only after a failed call, from `run.ts:89`
(`Unknown agent: "x". Available agents: "planner", "scout", …`). This feature moves that
information one hop earlier.

## Requirements (confirmed)

1. **Validity, not routing.** List names only. No per-agent descriptions — the goal is
   legal names, not agent selection quality.
2. **Project-first union.** One list containing project-local *and* user agents,
   ordered project before user, `(source)` tag on every name. With no project agents the
   list is naturally user-level only.
3. **Load-time snapshot.** Built once when the extension loads. No `session_start`
   re-registration, no live refresh.
4. **Cap at 12 names.** Overflow renders as `+K more`. Project names claim slots first,
   so a large global set can never crowd out the repo-specific agents.
5. **Two insertion points only:** the tool `description` and the top-level `agent`
   parameter hint. `TaskItem.agent` and `ChainItem.agent` are left alone — all three
   modes share one name list, so repeating it is pure token waste.
6. **One `promptGuidelines` bullet,** free of agent names (so it is not a third copy of
   the list). Per `docs/extensions.md`, a guideline must name the tool it refers to, so
   it says `subagent`.
7. **No config flag.** Not gated behind anything like `enableProfiles`.
8. **A malformed agent file may only shorten the list — never abort registration, never
   swallow its siblings.** Requirement 3 moves agent discovery to module load time, so
   any throw inside `discoverAgents` now kills the whole extension. This must be held at
   the source, not at the new call site (see *Error handling*).

## Exact output

Both insertions interpolate **the same single `AGENT_LIST` string**, so the two places
cannot drift. `formatAgentNames` returns `text` and `remaining`; the caller appends
` +K more` to `text` only when `remaining > 0`.

Directory names use `CONFIG_DIR_NAME` and `getAgentDir()` rather than a literal `.pi`,
matching the sentences already in the description.

Tool description sentence, inserted after the existing agent-scope sentences and before
`Profiles:` —

> `Available agents: scout (project), planner (user), reviewer (user), worker (user).`
> `Captured at startup from the launch directory, so project-local agents added since`
> `then are missing. Passing an unknown name returns the full current list.`

When capped, `AGENT_LIST` alone differs — `…, worker (user) +3 more` — and the sentence
otherwise reads the same.

Top-level `agent` parameter —

> `Name of the agent to invoke (for single mode; the same names apply to items in`
> `tasks/chain). Valid: scout (project), planner (user), reviewer (user), worker (user).`
> `Passing an unknown name returns the current list.`

Appended to `promptGuidelines` —

> `When calling subagent, choose an agent name from its Available agents list rather`
> `than inventing one; an unknown name returns the current list.`

Empty case (no agents discoverable at startup) — description sentence becomes
`Available agents: none found at startup; project-local agents in .pi/agents may still
exist. Passing an unknown name returns the full current list.` and the parameter hint
drops the `Valid:` clause entirely.

Rendered output on this machine, captured by registering the tool against a stub `pi`
object — the check to redo whenever these strings change:

```
Available agents: planner (user), reviewer (user), scout (user), worker (user). Captured
at startup from the launch directory, so project-local agents added since then are
missing. Passing an unknown name returns the full current list.
```

One adjacent defect, recorded so nobody mistakes it for this feature's text: the
`Profiles:` sentence that follows ends in a stray literal `]` — observed tail
`…omit to use the agent's own model/settings.]`, from `index.ts:116` (`}]` before the
closing backtick), introduced by `2fae34d`. It is outside this spec's scope and is
handled as its own commit in the implementation plan.

## Design

### Two discovery calls, on purpose

- **Load time** (`index.ts`): `discoverAgents(process.cwd(), "both")` — advisory text
  for the prompt. Scope `"both"` so project agents found by walking up from the launch
  directory are included.
- **Per call** (`index.ts:execute` → `dispatch.ts`): unchanged,
  `discoverAgents(ctx.cwd, agentScope)` — authoritative. Execution always uses the real
  session cwd and scope, so a stale or wrong advertised name cannot cause a wrong agent
  to run. `run.ts:89` stays the source of truth and self-heals in one round-trip.

  Advertising at load time does not change which agents can run, but it does change what
  happens when discovery itself fails: a throw that used to surface as one failed tool
  call now aborts registration. That asymmetry is the whole of requirement 8.

### `formatAgentNames` (in `agents.ts`)

```ts
formatAgentNames(agents: AgentConfig[], maxItems: number): { text: string; remaining: number }
```

Sort by `source` priority (`project` before `user`), then alphabetically by name within
each group; slice to `maxItems`; join as `${name} (${source})` with `", "`. Returns the
dropped count separately so the caller composes `+K more`. Pure and total — no fs, no
throwing — which keeps every interesting decision unit-testable on synthetic input.

`formatAgentList` (line 149) is deleted: it is unreferenced anywhere in the repo and
emits full descriptions, which requirement 1 rules out. Leaving it would mean two
formatters that disagree about what the prompt should carry.

### `MAX_LISTED_AGENTS`

`export const MAX_LISTED_AGENTS = 12;` in `types.ts`, alongside `MAX_PARALLEL_TASKS` and
`MAX_CONCURRENCY`. Comfortably above the four agents shipped in `agents/`, so today's
output shows every name.

### String composition

`index.ts` builds two module-level strings next to the existing
`profileHint`/`registeredProfileSummary` block and reuses that block's comment style to
record *why* the list is a load-time snapshot and what goes stale. The `agentScope`
schema already documents `"both"` as the default, so the sentences stay consistent with
it.

## Error handling

- **Requirement 8 is not satisfied by the code as it stands.** `agents.ts:88` calls
  `parseFrontmatter` *outside* the `try` that guards `readFileSync` (`:82-85`), and
  `parseFrontmatter` is a synchronous YAML parse (`ParsedFrontmatter<T>`, no error-return
  variant) that throws on malformed frontmatter. Reproduced:

  ```
  $ discoverAgents(<dir containing a .md with 'description: ['>, "project")
  THREW: YAMLParseError Flow sequence in block collection must be sufficiently
  indented and end with a ]
  ```

  Two consequences, and only the first is new. **New:** `loader.js:466` wraps extension
  load and returns `{ extension: null, error: "Failed to load extension: …" }`, so one bad
  `.md` anywhere in the two scanned directories means the `subagent` tool never registers
  at all — a silent, whole-feature loss introduced by advertising names at load time.
  **Pre-existing:** the same throw escapes `execute()`'s per-call discovery, so a file
  created mid-session already breaks every `subagent` call today.
- **Fix at the source, not the new call site.** Wrapping `parseFrontmatter` in
  `loadAgentsFromDir` with `continue` repairs both paths at once, whereas a `try/catch`
  around `index.ts`'s load-time call would fix only the symptom this plan introduced and
  leave the call-time hole open. It also matches the policy `agents.ts` already states for
  `parseToolList` — "a single bad file must not take down every other agent in the same
  directory" — which the unguarded parse contradicts. Note the failure is currently
  all-or-nothing per directory: the repro's *valid* `foo.md` is lost alongside the bad
  `bad.md`, which is exactly what the guard restores.
- A missing directory and an unreadable file are already handled (`existsSync`,
  `readdirSync` and `statSync` guards, `readFileSync` in `try { … } catch { continue }`).
  With the parse guard in place, every remaining load-time input failure shortens the
  list instead of aborting registration.
- Agents whose names collide across scopes keep existing `discoverAgents` semantics —
  project overwrites user in the `Map` (`agents.ts:134-141`) — so `formatAgentNames`
  receives a deduped list and never prints a name twice.
- A name the model passes that is absent at runtime is unchanged behavior: error +
  authoritative list, nothing spawned.

## Testing

- **Unit** (`test/agents.test.ts`, new): project precedes user; alphabetical within each
  group, exercised with input deliberately out of order because `discoverAgents` returns
  `Map` insertion order (user first) rather than sorted output; cap at `maxItems` with
  correct `remaining`; `maxItems: 0`; empty input → `{ text: "", remaining: 0 }`; the
  input array is not mutated.
- **Malformed-file test (requirement 8):** build a temp directory holding `.pi/agents/`
  with one valid `foo.md` and one `bad.md` whose frontmatter is `description: [`, then
  assert `discoverAgents(dir, "project")` does not throw and yields exactly `["foo"]`.
  Scope `"project"` reads only that directory, so the test needs no `HOME` manipulation
  and no real user agents — the mechanism was verified against the current code before
  this spec was approved, and it fails with `YAMLParseError` until the guard exists.
- **`npm run typecheck`** and **`npm test`** must pass. Baseline at the time of writing:
  typecheck exit 0, 17/17 tests passing.
- **Manual end-to-end:** register the tool against a stub `pi` object from the repository
  directory and print the captured `description`, the `agent` parameter, both nested
  `agent` parameters, and `promptGuidelines` — expected: the four `(user)` names with no
  `+K more`, `TaskItem.agent`/`ChainItem.agent` still exactly `"Name of the agent to
  invoke"`, and three guidelines. The exact command form matters and is recorded in the
  plan; a harness file placed outside the repository fails to resolve
  `@earendil-works/pi-coding-agent`.
- **Empty case:** redirect `HOME` to an empty temp directory and run the same capture —
  `getAgentDir()` resolves through `os.homedir()`, which honors `$HOME`, so discovery
  returns `[]` and the empty-case strings are observed rather than inferred. Verified
  against the current code: `discoverAgents(cwd, "both")` returns `[]` under an empty
  `$HOME`.
- **Capped-list path:** covered by the `maxItems` unit test, plus a direct composition
  check that formats 15 synthetic agents through `formatAgentNames` and renders the
  `+K more` suffix exactly as `index.ts` does — observed tail: 12 names then ` +3 more`.
  Project-first ordering means the truncated tail is always user-level names. Building a
  real 13-agent install to test this would mean writing into `~/.pi/agent/agents`, which
  is not worth it for a formatting branch.

## Non-goals

- No per-agent descriptions, routing hints, or "use X for Y" guidance.
- No `session_start` refresh, file watcher, or live re-registration.
- No `enum`/`StringEnum` constraint on the `agent` parameter — it would break
  project-local agents and any mid-session addition.
- No changes to `dispatch.ts`, `run.ts`, `render.ts`, `format.ts`, or the
  parallel/chain schemas.
- No settings key, enable flag, or UI.
- No new warning channel for skipped agent files. A malformed file is dropped in silence,
  matching the existing `catch { continue; }` for unreadable files and `parseToolList`.
  Surfacing "why is my agent missing" is a separate problem with a separate audience.

## Risks & tradeoffs

- **Launch-directory mismatch.** Extensions load once per process, so project agents are
  discovered from `process.cwd()` at startup, not `ctx.cwd`. Launching `pi` from a parent
  folder advertises no project agents until `/reload`. Accepted under the load-time
  snapshot decision; the note in the description plus the runtime error cover it.
- **Deletion drift.** A removed agent stays advertised until reload; the model's call
  fails with the current list and it retries in one hop.
- **Token cost.** Bounded: ≤12 tagged names (≈60–90 tokens each) duplicated twice, plus
  one short guideline. Rejected alternative: repeating the list in `TaskItem` and
  `ChainItem`, a third and fourth copy for identical information.
- **Exclusive fallback rejected.** Showing *only* project agents when any exist would
  hide `planner`/`reviewer`/`scout`/`worker` and reinstate the invented-name failure.

## Amendment (2026-08-31b): requirement 1 reversed — the description is advertised

The owner asked for agent descriptions in the tool description, which is exactly what
requirement 1 and the *Non-goals* ruled out. Reversal applied; the rest of this spec
(project-first ordering, load-time snapshot, 12-item cap, self-healing unknown names)
still holds.

What changed:

- `formatAgentRoster(agents, maxItems, maxDescChars)` (`agents.ts`) renders
  `name (source) — description` joined by `"; "`, sharing `selectAdvertisedAgents` with
  `formatAgentNames` so both lists cap and truncate identically and can never disagree.
- `advert.ts` puts the **roster** in both branches' `Available agents:` sentence and
  keeps **names only** in the `agent` param hint. Routing happens from the description;
  the hint's job is legal values to copy, so repeating the prose there was rejected as a
  second copy of the same tokens. `TaskItem.agent`/`ChainItem.agent` remain untouched.
- `clampDescription` collapses whitespace runs to single spaces and truncates at
  `MAX_AGENT_DESC_CHARS = 120` (`types.ts`) with an ellipsis. An agent file must not be
  able to inflate every prompt turn via a multi-line YAML block scalar. A blank
  description degrades to a bare `name (source)`; the separator is `"; "` because
  descriptions contain commas.

Wording: `Available agents, with what each is for: …` — the qualifier is what tells the
model the entries are routing candidates, not just a name census.

Token cost, measured on this machine (5 user agents, real frontmatter): the roster adds
≈95 tokens per turn versus the names-only sentence in the description; the param hint is
unchanged. Accepted as the price of the reversal.

`formatAgentList` stays deleted (`docs/superpowers/plans/2026-08-31-subagent-agent-names-in-description.md`
Task 1) — `formatAgentRoster` replaces its role with a cap and one-line clamping.
