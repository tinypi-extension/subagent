# Subagent Profiles — Design

## Goal

Let the main agent choose an execution profile for each spawned subagent. A profile
maps to a concrete LLM + thinking level. If no profile is given, fall back to the
agent's own model, then to the main agent's current settings.

## Requirements (confirmed)

1. The main AI agent picks the profile by passing a `profile` param on the `subagent`
   tool call. No automatic/code-side scoring.
2. Priority chain per task: `profile` → agent frontmatter `model` → main agent settings.
3. Profiles live in `settings.json` under the `subagent.profiles` key. Profile fields:
   `model` (optional) and `thinking` (optional). A missing field falls back
   independently down the chain.
4. `profile` is settable per task/step in single, parallel, and chain modes.
   No call-level default.
5. Project `.pi/settings.json` overrides global — **union merge, project wins per
   profile name**, gated on project trust (`ctx.isProjectTrusted()`).
6. An explicitly-passed but unknown profile name is a **hard error** listing valid
   names. An omitted profile never errors and falls back.
7. Field name is `thinking` (not `thinkingLevel`) in profile config, matching the
   `--thinking` CLI flag.

## Settings schema

```json
{
  "subagent": {
    "profiles": {
      "low":    { "model": "oc-openai/deepseek-v4-flash", "thinking": "off" },
      "medium": { "model": "oc-openai/deepseek-v4-pro",  "thinking": "low" },
      "high":   { "model": "oc-openai/deepseek-v4-pro",  "thinking": "medium" },
      "expert": { "model": "oc-openai/hy3",              "thinking": "high" }
    }
  }
}
```

- `model`: same `provider/id` string the CLI accepts.
- `thinking`: a valid `ThinkingLevel` (`off|minimal|low|medium|high|xhigh|max`).
- Global = `<agentDir>/settings.json`; project = `<cwd>/.pi/settings.json`, loaded
  only when the project is trusted. Merge is a union of names; for a name defined in
  both, the project entry wins.
- If no profiles are configured (empty set): any explicit `profile` errors; omitted
  profiles behave exactly as today.

## Resolution / fallback chain (per task)

For a task `{ agent, task, profile? }` with parent defaults
`{ model, thinkingLevel }` (the main agent's current model + thinking):

- **model** = `profile.model` → else `agent.model` (frontmatter) → else `parent.model`
  → else *(no `--model` flag)*
- **thinking** = `profile.thinking` → else (if the agent has **no** own model)
  `parent.thinkingLevel` → else *(no `--thinking` flag → model default)*

Notes:
- The thinking branch preserves the existing rule: an agent with its own model does
  not inherit the parent's thinking level.
- A profile's `thinking` always wins, even over an agent that has its own model.

## Tool API & validation

- Single mode: `profile?: string` top-level on the call.
- Parallel/chain: `profile?: string` on each `TaskItem` / `ChainItem`.
- No call-level default.
- Explicit-but-unknown profile → hard error before spawning, listing valid names
  (`Available profiles: low, medium, ... Unavailable: turbo`). No error when omitted.

## Module breakdown & data flow

- **`profiles.ts`** (new):
  - `SubagentProfile` type `{ model?: string; thinking?: ThinkingLevel }`.
  - `loadProfiles(cwd, isProjectTrusted): Record<string, SubagentProfile>`
    (reads/merges global + project; returns empty on missing files).
  - `validateProfiles(requested: (string|undefined)[], available): { valid: boolean;
    invalid: string[] }`.
  - `resolveProfile(profile, agent, parent): { model?: string; thinkingLevel?:
    ThinkingLevel }` — applies the fallback chain.
- **`dispatch.ts`**: load profiles once; collect + validate all requested names
  (all modes) *before* spawning; resolve each task → pass `{ model, thinkingLevel }`
  to `runSingleAgent`.
- **`run.ts`**: remove its own model/thinking derivation. `runSingleAgent` accepts the
  pre-resolved `{ model, thinkingLevel }` and emits `--model` / `--thinking` from
  those exact values (a missing value = no flag). The fallback rules live solely in
  `resolveProfile`, so `run.ts` stays a dumb pass-through.
- **`index.ts`**: add `profile` (and optional per-item) to the schema; extend the tool
  description to tell the model profiles exist, are defined in `subagent.profiles`,
  and how to choose (low/medium/high/expert).

## Error handling

- Invalid profile → error message with valid names; nothing is spawned.
- Malformed profile config (e.g. `thinking` not a valid level) → that profile is
  treated as unusable; referencing it errors. Unreferenced malformed entries are
  ignored (a bad entry must not break other agents/profiles).
- Missing settings file(s) → empty profile set, no error.

## Testing

- Unit: `loadProfiles` (global-only, merge, project override, trust-gated, malformed
  entries ignored when unreferenced).
- Unit: `validateProfiles` (valid, invalid, mixed).
- Unit: `resolveProfile` (full chains, partial profiles, agent-with-own-model thinking
  branch, no-fallback flags).
- Dispatch-level: invalid profile in a parallel batch errors before any spawn; valid
  mixed batch resolves per-task correctly.

## Non-goals

- No automatic difficulty scoring.
- No call-level default profile.
- No profile UI/editor — editing happens in `settings.json`.
