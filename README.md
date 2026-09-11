# Subagent
> Project archived. Use new extension [tinysubagent](https://github.com/tinypi-extension/tinysubagent)

A [Pi](https://pi.dev) coding-agent extension that spawns isolated `pi` subprocesses — one per delegated task — so each subagent runs in a **fully isolated context window**. It registers a single tool named `subagent`.

Rather than cramming parallel work, research, and implementation into the main agent's context, you hand each task to a specialized agent (`scout`, `planner`, `worker`, `reviewer`, …). The results stream back into the main conversation as TUI-rendered output.

## What it does

- **Isolated subprocesses.** Each delegated task is a separate `pi --mode json --no-session` process (`run.ts`), so subagents never share or pollute the main agent's context window.
- **Two orchestration modes:**
  - **single** — one `{ agent, task }`.
  - **parallel** — an array of `tasks`, run concurrently up to **4** at once (max **8** tasks total, `types.ts`).
- **Agent discovery.** Agents are loaded from your user agent directory and the project's agent directory (see [Configuration](#configuration)). The names *and one-line descriptions* available at startup are listed in the `subagent` tool description — project agents first — so the model has valid names to copy and can route a task by role instead of guessing (see [Limits](#limits)).
- **Execution profiles.** Every task names a profile that controls the subagent's model and thinking level (see [Configuration](#configuration)). The built-in `current` profile runs the subagent with the session's current model and thinking.
- **Structured output + TUI rendering.** Results stream back as JSON and are rendered in the terminal, with usage/stats (tokens, cost, turns) and collapsed/expanded item views.

## Requirements

- A Pi install that provides the bundled core packages (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`). These are declared as `peerDependencies` and are **not** bundled — Pi provides them at runtime.
- For development/type-checking this repo also uses `@types/node`, `tsx`, and `typescript`.

## Installation

> **Security:** Pi extensions run with your full system permissions and can execute arbitrary code. Only install from sources you trust, and review the source before installing.

### Option 1 — Pi package via git (recommended)

The repo is [`tinypi-extension/subagent`](https://github.com/tinypi-extension/subagent). Install it as a Pi package with a pinned git ref:

```bash
pi install git:github.com/tinypi-extension/subagent@main
```

Notes:

- Git refs must be a **tag or commit**. No tags exist yet, so use `@main`, or create and push one
  (e.g. `git tag v0.1.0 && git push --tags`) and install with `pi install git:github.com/tinypi-extension/subagent@v0.1.0`.
- The install is written to global settings (`~/.pi/agent/settings.json`). Use `-l` to write to project settings (`.pi/settings.json`) instead; project settings can be shared with a team, and Pi auto-installs missing packages after the project is trusted.
- To try it without installing (current run only), use the temporary flag:

  ```bash
  pi -e git:github.com/tinypi-extension/subagent@main
  ```

- `pi update --extensions` / `pi update --all` reconcile an existing clone to the configured ref but do **not** move a pinned ref forward; run `pi install git:...@new-ref` to switch.
- The clone lands under `~/.pi/agent/git/<host>/<path>` (global) or `.pi/git/<host>/<path>` (project).

### Option 2 — Manual clone/link (auto-discovered extension)

Clone into the global extensions directory (auto-discovered per `docs/extensions.md`):

```bash
git clone git@github.com:tinypi-extension/subagent.git ~/.pi/agent/extensions/subagent
cd ~/.pi/agent/extensions/subagent && npm install
```

For a project-local extension, clone into `.pi/extensions/subagent/` instead. A symlink into `~/.pi/agent/extensions/` pointing at your checkout also works. After adding or changing an extension, run `/reload` in Pi to hot-load it.

Pi auto-discovers extensions from `~/.pi/agent/extensions/*/index.ts` (global) and `.pi/extensions/*/index.ts` (project-local).

## Basic usage

The tool parameter schema lives in `index.ts` (`SubagentParams`). Pass exactly **one** mode per call.

**Single:**

```json
{ "agent": "scout", "task": "Analyze the repository and return context another agent can use." }
```

**Parallel** (array of `{ agent, task }`; up to 8 tasks, 4 concurrent):

```json
{
  "tasks": [
    { "agent": "scout", "task": "Find all code related to user auth." },
    { "agent": "scout", "task": "Map the CLI entry points." }
  ]
}
```

**Other params** (per task or call): `profile` (**compulsory** — execution profile name; single mode: top-level, parallel mode: per task), `cwd` (working directory for the subprocess), `agentScope` (`both` | `user` | `project`), and `confirmProjectAgents` (default `true`).

### Agents

Agent aliases such as `scout`, `planner`, `worker`, and `reviewer` are **not** hard-coded — they come from your agent files. Define one as Markdown with YAML frontmatter in `~/.pi/agent/agents/<name>.md` (the body becomes the system prompt), for example `~/.pi/agent/agents/scout.md`:

```markdown
---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash, codegraph_*
---

You are a scout. Quickly investigate a codebase and return structured findings that
another agent can use without re-reading everything.
```

The `name` and `description` are required; `tools` restricts which tools the subagent gets; `model` (optional) sets the subagent's model.

Tool lists (`tools:` frontmatter, `deny-tools:` frontmatter, and the `tools` param on the `subagent` call) accept `*` globs, so you don't have to enumerate every exact name: `tools: read, bash, codegraph_*` allows any tool whose name starts with `codegraph_` (the `*` matches anywhere — `*_files` and `mcp_*` work too). A token is a pattern only when it contains `*`; plain names keep matching exactly. Patterns expand against the tools registered at spawn time (built-in, extension, and MCP tools). A pattern that matches nothing is passed through literally and reported as a warning in the spawn result — never silently dropped.

The `subagent` tool description advertises each agent as `name (source) — description`, so the model chooses by role rather than by name alone. The `agent` parameter hint lists the legal names only — the prose appears once, not twice. The description is otherwise not sent anywhere: it never reaches the subagent, whose system prompt is the markdown body below the closing `---`. Add agent files, then `/reload` (or restart pi) for them to appear. Keep `description:` a short one-liner: it is re-sent on every prompt turn, so the advertised copy is collapsed to one line and capped at 120 chars (`MAX_AGENT_DESC_CHARS`, `types.ts`).

An agent file whose frontmatter cannot be parsed is skipped silently, along with any file missing `name` or a string `description`; it disappears from discovery rather than being reported. If an agent seems to be missing, check its frontmatter — a colon-introduced value such as `description: [ …` starts a YAML flow sequence and must be quoted.

### Ready-made workflow prompts

Full copy-paste workflows live in `prompts/`:

- `prompts/implement.md` — scout → planner → worker.
- `prompts/implement-and-review.md` — worker → reviewer → worker.
- `prompts/scout-and-plan.md` — scout → planner (no implementation).

Use a prompt with `@` (Pass-by-Reference) to inject your task, e.g. `Prompt file… @prompts/implement.md`.

## Configuration

### Agents

- **User agents:** `~/.pi/agent/agents/<name>.md` (all projects).
- **Project agents:** `<cwd>/.pi/agents/<name>.md` (nearest project; project-local entries load only after the project is trusted).
- **`agentScope`** param selects which dirs are searched: `both` (default), `user`, or `project`. In `both` mode, project agents win name conflicts.
- **`confirmProjectAgents`** (default `true`): a hook intended to prompt before running project-local agents.

### Profiles

The extension is disabled by default. Enable it by setting `subagent.enableProfiles` to the boolean `true` in the global `~/.pi/agent/settings.json`:

```json
{
  "subagent": {
    "enableProfiles": true,
    "profiles": {
      "fast":  { "model": "oc-openai/deepseek-v4-flash", "thinking": "off" },
      "high":  { "model": "oc-openai/deepseek-v4-pro",   "thinking": "medium" }
    }
  }
}
```

The `subagent` tool is not registered when `enableProfiles` is missing, `false`, or any value other than the boolean `true`. Named **execution profiles** can be defined under `subagent.profiles` globally and optionally per-project in `.pi/settings.json` (project profiles win name conflicts, gated on project trust). Each profile sets `model` and/or `thinking`, where `thinking` is one of `off | minimal | low | medium | high | xhigh | max`.

A task selects one via its `profile` param, which is **compulsory**: single-mode calls must pass a top-level `profile`, and every entry in `tasks` must carry its own `profile`. Omitting it (or passing an empty string) is a hard error that lists the valid names.

A built-in profile **`current`** is always available (even with no custom profiles defined): it runs the subagent with the **parent session's current model and thinking level**, pinned at spawn time — it overrides the agent definition's own `model`. A user-defined profile named `current` takes precedence over the built-in.

Resolution/fallback per task (`profiles.ts` / `dispatch.ts`):

- **model** = `profile.model` (for `current`: the main agent's current model) → else agent frontmatter `model` → else the main agent's current model → else *(no `--model` flag)*.
- **thinking** = `profile.thinking` (for `current`: the main agent's current thinking) → else (if the agent has no own model) the main agent's thinking level → else *(no `--thinking` flag)*.

Passing an **unknown** profile name is a hard error that lists the valid names (always including `current`).

### Herdr mode (opt-in)

When running **inside a herdr pane** (`HERDR_ENV=1` + `HERDR_PANE_ID` + `HERDR_SOCKET_PATH`), the extension can switch to herdr-native tools: `subagent` becomes fire-and-forget (subagents launch as herdr plugin panes, spawn returns a ~1s ack, results arrive as `subagent_result`/`subagent_ping` steer messages), plus `subagent_resume`, `subagent_interrupt`, and `subagents_list`. Requires the `pi-herdr-subagents` plugin to be linked (`herdr plugin link <extension>/herdr-plugin --enabled`) and herdr ≥ 0.7.0.

This mode is **off by default**. Enable it by setting `subagent.herdr` to the boolean `true` in the global `~/.pi/agent/settings.json`:

```json
{
  "subagent": {
    "herdr": true
  }
}
```

Both conditions must hold: the herdr environment **and** `subagent.herdr === true`. Otherwise the extension falls back to the standard blocking `subagent` tool (single + parallel, one tool result). Project-level settings do not participate in this flag — only the global settings file is read.

## Limits

- Parallel: max **8** tasks, **4** concurrent.
- Per-task output in parallel results is capped (~**50KB**); full output is preserved in the tool details (`format.ts`).
- TUI rendering collapses item lists after **10** items (`types.ts`).
- Agents advertised in the tool description: max **12** listed (`MAX_LISTED_AGENTS`, `types.ts`), project agents first, the rest collapsed to `+K more`; each entry's `description` is clamped to **120** chars on one line (`MAX_AGENT_DESC_CHARS`). Snapshot taken when the extension loads, from the directory pi was launched in — new or removed agents need a `/reload`. Calling an unknown name is not fatal: it returns the full current list.

## Development / testing

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test --import tsx test/*.test.ts
```

Tests: `test/agents.test.ts` (agent name formatting and discovery), `test/dispatch.test.ts` (orchestration) and `test/profiles.test.ts` (profile resolution/validation).

## License

MIT — see [`./LICENSE`](./LICENSE). Copyright (c) 2026 tinypi-extension.
