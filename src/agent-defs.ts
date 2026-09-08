// Agent-definition parsing and launch-behavior resolution for the herdr path.
//
// Adapted from pi-herdr-subagents (src/agents.ts), which itself ports the
// frontmatter compatibility contract from pi-interactive-subagents (MIT,
// HazAT): both generations read the same ~/.pi/agent/agents/*.md files during
// the transition period, so field semantics must match. Read-only consumption
// of agent definitions — this module never writes to the def directories.
//
// Adaptations vs pi-herdr-subagents:
// - Frontmatter is parsed with `parseFrontmatter` from
//   @earendil-works/pi-coding-agent (real YAML parser) instead of the regex
//   line parser — same policy as this repo's kept agents.ts discovery, and
//   more robust for multi-line/quoted values.
// - Agent-definition directories are INJECTABLE: the herdr path reuses the
//   kept discovery in agents.ts (`discoverAgents`, honoring AgentScope), so
//   nothing here re-scans directories by default unless asked.
// - No fork/lineage: `session-mode: lineage-only|fork` values are parsed but
//   IGNORED (treated as standalone); `resolveLaunchBehavior` is replaced by
//   `resolveLaunchBehaviorStandalone`, which always yields artifact delivery.
// - Params typed as a plain interface instead of the extension's typebox schema.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Session modes accepted by the frontmatter contract. Only standalone
 * sessions exist in this migration: lineage/fork values are still PARSED
 * (so the field is recognized) but treated as standalone everywhere.
 */
export type SubagentSessionMode = "standalone";

/** The subset of `subagent` tool params that agent-def resolution consults. */
export interface SubagentSpawnParams {
  name: string;
  task: string;
  agent?: string;
  cwd?: string;
  interactive?: boolean;
}

export interface AgentDefaults {
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export type AgentSource = "global" | "project";

export interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

export interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools that are gated by `spawning: false` */
export const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
export function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

/**
 * Resolve the global agent config directory.
 *
 * Delegates to the runtime's `getAgentDir()`, which already honors
 * PI_CODING_AGENT_DIR (with tilde expansion) — the same variable the
 * reference implementation read directly — so the two can never diverge.
 */
export function getAgentConfigDir(): string {
  return getAgentDir();
}

type AgentFrontmatter = Record<string, unknown>;

/** Frontmatter string field; non-string YAML scalars (numbers, bools) are ignored. */
function fmString(fm: AgentFrontmatter, key: string): string | undefined {
  const v = fm[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Frontmatter boolean field. `parseFrontmatter` runs a real YAML parser, so
 * `spawning: true` arrives as boolean `true`; the unquoted strings "true"/
 * "false" (the reference contract's spelling) are accepted for compatibility.
 */
function fmBoolean(fm: AgentFrontmatter, key: string): boolean | undefined {
  const v = fm[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

/**
 * Parse a `session-mode` frontmatter value. lineage-only/fork are recognized
 * but IGNORED: this migration has no fork/lineage, so every valid value
 * resolves to standalone (i.e. plain artifact-backed launches).
 */
function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return "standalone";
  }
  return undefined;
}

/**
 * Parse one agent-definition markdown file.
 *
 * Returns null when the content has no frontmatter block or malformed YAML —
 * callers (discovery loops) skip the file rather than fail the directory.
 * `fallbackName` is used when no `name:` field is present (the file name).
 */
export function parseAgentDefinition(
  content: string,
  fallbackName: string,
): AgentDefinition | null {
  // No frontmatter block at all → not an agent definition. parseFrontmatter
  // would happily return empty frontmatter + the whole content as body.
  if (!content.startsWith("---")) return null;

  let frontmatter: AgentFrontmatter;
  let body: string;
  try {
    ({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
  } catch {
    // Malformed YAML: skip the file (see parseAgentDefinition doc comment).
    return null;
  }

  const systemPromptMode = fmString(frontmatter, "system-prompt");
  const disableModelInvocation = fmBoolean(frontmatter, "disable-model-invocation");

  return {
    name: fmString(frontmatter, "name") ?? fallbackName,
    description: fmString(frontmatter, "description"),
    model: fmString(frontmatter, "model"),
    tools: fmString(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: fmString(frontmatter, "skill") ?? fmString(frontmatter, "skills"),
    thinking: fmString(frontmatter, "thinking"),
    denyTools: fmString(frontmatter, "deny-tools"),
    spawning: fmBoolean(frontmatter, "spawning"),
    autoExit: fmBoolean(frontmatter, "auto-exit"),
    interactive: fmBoolean(frontmatter, "interactive"),
    sessionMode: parseSessionMode(fmString(frontmatter, "session-mode")),
    cwd: fmString(frontmatter, "cwd"),
    cli: fmString(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation: disableModelInvocation === true,
  };
}

/**
 * Default agent-def directories, first match wins: the project dir beats the
 * user dir, matching the kept discovery's precedence (project over user).
 *
 * The list is injectable everywhere it is consumed so tests (and the herdr
 * path, which reuses agents.ts discovery) can point it at arbitrary dirs.
 */
export function defaultAgentDefDirs(cwd: string = process.cwd()): string[] {
  return [join(cwd, CONFIG_DIR_NAME, "agents"), join(getAgentDir(), "agents")];
}

/**
 * Load one agent's defaults by name from a list of def directories.
 * Directories are injectable (see defaultAgentDefDirs for the default);
 * the first directory containing `<name>.md` wins. Never writes.
 */
export function loadAgentDefaults(
  agentName: string,
  dirs: readonly string[] = defaultAgentDefDirs(),
): AgentDefaults | null {
  for (const dir of dirs) {
    const p = join(dir, `${agentName}.md`);
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }
  return null;
}

export function resolveSubagentPaths(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

export function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    // Ported side effect (the one write in launch planning): the child session
    // directory must exist before the child pi starts writing its session file.
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

/**
 * Launch behavior for this migration: standalone only.
 *
 * fork/lineage are gone — every launch writes the task to an artifact file and
 * hands it to the child as `@<taskfile>`, so `taskDelivery` is always
 * "artifact" regardless of params or agent defs. `session-mode` frontmatter is
 * still parsed (see parseSessionMode) but non-standalone values are ignored.
 */
export function resolveLaunchBehaviorStandalone(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): { taskDelivery: "artifact" } {
  void params;
  void agentDefs;
  return { taskDelivery: "artifact" };
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` tool parameter wins.
 *   2. Explicit `interactive` frontmatter field on the agent.
 *   3. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, worker, reviewer) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane and stall pings are noise.
 *
 * When no agent defs exist at all (bare `subagent({ name, task })` call),
 * `autoExit` is undefined and the subagent is treated as interactive.
 */
export function resolveEffectiveInteractive(
  params: SubagentSpawnParams,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}
