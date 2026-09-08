# Intent: herdr migration

Confirmed 2026-09-08 via interview. Source of truth for the migration described in
`/Users/tinyphat/Project/pi-herdr-subagents-main/CORE_PRINCIPLE.md`.

## Outcome

The `subagent` extension becomes a hybrid of the herdr-native architecture:

- **Inside herdr** (detected via `HERDR_ENV` + `HERDR_PANE_ID` + `HERDR_SOCKET_PATH`):
  subagents run in herdr panes; the spawn tool returns an ack in ~1s; each child's
  completion/failure arrives as an async steer message (`subagent_result`) that wakes the
  mother agent into a new turn. Truthful lifecycle states — no zombie children.
- **Outside herdr**: fall back to the **current blocking subprocess behavior** — single +
  parallel fan-out returning one tool result (no steer, no watcher).

## User

The repo owner, orchestrating from inside a herdr pane (their normal environment).

## Why now

Blocking orchestration ties the mother agent up for minutes per task; fire-and-forget with
wake-on-completion plus visible live children in panes is the desired workflow.

## Success

- Spawn returns in ~1s inside herdr; steers wake the mother agent per child.
- Honest lifecycle classification (done / ping / crashed / launch-failed / pane-killed /
  gap-exit / completed-user-exit / cancelled).
- `subagent_resume`, `subagent_interrupt`, `subagents_list` work.
- `typecheck` + tests pass; fallback path stays green throughout the migration.

## Constraints

- Target contracts (`.exit` / `.exitcode` sidecar shapes, steer `customType`s) are
  load-bearing — port verbatim, do not rename.
- This is a **port, not a copy**: the target is written against `@mariozechner/*` pi v0.65;
  the runtime here provides `@earendil-works/*`, so imports/APIs are adapted and the rewrite
  happens in place in `~/.pi/agent/extensions/subagent`, keeping repo identity and tests.
- Single + parallel fan-out remain available on the fallback path; results are blocking tool
  results there.

## Kept from the current project

- Profiles (`enableProfiles` gate, global + project resolution, per-task `profile` param).
- Agent discovery (user/project dirs, `agentScope`, `confirmProjectAgents`).
- Agent-name advertising in tool descriptions.
- TUI rendering for the fallback path.

## Port surface

| In | Out |
|---|---|
| herdr pane launch (argv plugin panes, no launch race) | chain mode |
| watcher + lifecycle classification + steer messages | fork / lineage session modes |
| `subagent_resume`, `subagent_interrupt`, `subagents_list` | `/iterate` |
| session-mode `standalone` only (every child is standalone) | `/subagents-init` |
| `.exit` / `.exitcode` sidecar handshake | status widget |
| curated env handoff, direnv wrap, launch-prefix config | stall detection |

## Out of scope

Claude/codex children (pi-children-only), tmux/zellij code paths, multi-workspace pane
topology, stall detection, herdr `exit_code` feature request.

## Open implementation decisions (agent's call)

- Phase order: keep fallback green, land herdr modules one at a time with tests per phase.
- `docs/full-socket-client.md`'s all-socket client idea is not part of this migration.
