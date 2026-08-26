# Subagent

A [Pi](https://pi.dev) coding-agent extension that spawns isolated `pi` subprocesses — one per delegated task — so each subagent runs in a **fully isolated context window**. It registers a single tool named `subagent`.

Rather than cramming parallel work, research, and implementation into the main agent's context, you hand each task to a specialized agent (`scout`, `planner`, `worker`, `reviewer`, …). The results stream back into the main conversation as TUI-rendered output.

## What it does

- **Isolated subprocesses.** Each delegated task is a separate `pi --mode json --no-session` process (`run.ts`), so subagents never share or pollute the main agent's context window.
- **Three orchestration modes:**
  - **single** — one `{ agent, task }`.
  - **parallel** — an array of `tasks`, run concurrently up to **4** at once (max **8** tasks total, `types.ts`).
  - **chain** — an array of steps run strictly in sequence; the `{previous}` placeholder in a later task is replaced with the previous step's output; the chain **stops on the first failed step**.
- **Agent discovery.** Agents are loaded from your user agent directory and the project's agent directory (see [Configuration](#configuration)).
- **Execution profiles.** Each task can name a profile that controls the subagent's model and thinking level (see [Configuration](#configuration)).
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

**Chain** (sequential; `{previous}` is replaced with the prior step's output; stops on failure):

```json
{
  "chain": [
    { "agent": "scout", "task": "Gather context about the login flow." },
    { "agent": "planner", "task": "Plan a refactor of the login flow. Context: {previous}" },
    { "agent": "worker", "task": "Implement the plan. {previous}" }
  ]
}
```

**Other optional params** (per task or call): `cwd` (working directory for the subprocess), `profile` (execution profile name), `agentScope` (`both` | `user` | `project`), and `confirmProjectAgents` (default `true`).

### Agents

Agent aliases such as `scout`, `planner`, `worker`, and `reviewer` are **not** hard-coded — they come from your agent files. Define one as Markdown with YAML frontmatter in `~/.pi/agent/agents/<name>.md` (the body becomes the system prompt), for example `~/.pi/agent/agents/scout.md`:

```markdown
---
name: scout
description: Fast codebase recon that returns compressed context for handoff to other agents
tools: read, grep, find, ls, bash, codegraph_codegraph_explore
---

You are a scout. Quickly investigate a codebase and return structured findings that
another agent can use without re-reading everything.
```

The `name` and `description` are required; `tools` restricts which tools the subagent gets; `model` (optional) sets the subagent's model.

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

Define named **execution profiles** in `settings.json` under the `subagent.profiles` key — globally in `~/.pi/agent/settings.json` and optionally per-project in `.pi/settings.json` (project wins a name conflict, gated on project trust). Each profile sets `model` and/or `thinking`, where `thinking` is one of `off | minimal | low | medium | high | xhigh | max`.

```json
{
  "subagent": {
    "profiles": {
      "fast":  { "model": "oc-openai/deepseek-v4-flash", "thinking": "off" },
      "high":  { "model": "oc-openai/deepseek-v4-pro",   "thinking": "medium" }
    }
  }
}
```

A task selects one via its `profile` param. Resolution/fallback per task (`profiles.ts` / `dispatch.ts`):

- **model** = `profile.model` → else agent frontmatter `model` → else the main agent's current model → else *(no `--model` flag)*.
- **thinking** = `profile.thinking` → else (if the agent has no own model) the main agent's thinking level → else *(no `--thinking` flag)*.

Passing an **unknown** profile name is a hard error that lists the valid names; omitting `profile` never errors and just falls back.

## Limits

- Parallel: max **8** tasks, **4** concurrent.
- Chain: runs sequentially; stops on the **first failed step**.
- Per-task output in parallel results is capped (~**50KB**); full output is preserved in the tool details (`format.ts`).
- TUI rendering collapses item lists after **10** items (`types.ts`).

## Development / testing

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test --import tsx test/*.test.ts
```

Tests: `test/dispatch.test.ts` (orchestration) and `test/profiles.test.ts` (profile resolution/validation).

## License

MIT — see [`./LICENSE`](./LICENSE). Copyright (c) 2026 tinypi-extension.