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

## Design

### Two discovery calls, on purpose

- **Load time** (`index.ts`): `discoverAgents(process.cwd(), "both")` — advisory text
  for the prompt. Scope `"both"` so project agents found by walking up from the launch
  directory are included.
- **Per call** (`index.ts:execute` → `dispatch.ts`): unchanged,
  `discoverAgents(ctx.cwd, agentScope)` — authoritative. Execution always uses the real
  session cwd and scope, so a stale or wrong advertised name cannot cause a wrong agent
  to run. `run.ts:89` stays the source of truth and self-heals in one round-trip.

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

- Extension load must never throw: `loadAgentsFromDir` already skips unreadable files
  and missing directories, and malformed frontmatter files are dropped
  (`agents.ts:88-91`), so the worst case is a shorter or empty list.
- Agents whose names collide across scopes keep existing `discoverAgents` semantics —
  project overwrites user in the `Map` (`agents.ts:134-141`) — so `formatAgentNames`
  receives a deduped list and never prints a name twice.
- A name the model passes that is absent at runtime is unchanged behavior: error +
  authoritative list, nothing spawned.

## Testing

- **Unit** (`test/agents.test.ts`, new): project precedes user; alphabetical within each
  group is exercised with input deliberately out of order, since `discoverAgents` returns
  `Map` insertion order (user first) rather than sorted output.
  group; cap at `maxItems` with correct `remaining`; `+K more` absent at zero overflow;
  `maxItems: 0`; empty input → `{ text: "", remaining: 0 }`; conflict-resolution input
  (one name, `project` source) prints once.
- **`npm run typecheck`** and **`npm test`** must pass.
- **Manual end-to-end:** in a scratch directory containing `.pi/agents/foo.md`, launch
  `pi`, read back the registered `subagent` description, and confirm `foo (project)`
  precedes the user agents. Reported as observed output, not assumed.
- **Capped-list path:** covered by the `maxItems` unit test, plus a scratch directory
  holding enough agent files (project and user scopes combined) to exceed 12, confirming
  the `+K more` suffix renders in both insertion points. Project-first ordering means the
  truncated tail is always user-level names.

## Non-goals

- No per-agent descriptions, routing hints, or "use X for Y" guidance.
- No `session_start` refresh, file watcher, or live re-registration.
- No `enum`/`StringEnum` constraint on the `agent` parameter — it would break
  project-local agents and any mid-session addition.
- No changes to `dispatch.ts`, `run.ts`, `render.ts`, `format.ts`, or the
  parallel/chain schemas.
- No settings key, enable flag, or UI.

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
