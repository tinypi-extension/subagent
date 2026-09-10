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

/**
 * Built-in profile name: run the subagent with the parent session's *current*
 * model and thinking level (pinned at spawn time, overriding the agent
 * definition's own model). Always valid, even when custom profiles are
 * disabled; a user-defined profile named "current" takes precedence over the
 * built-in.
 */
export const CURRENT_PROFILE = "current";

function isThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === "string" && VALID_THINKING.has(v);
}

export function isProfilesEnabled(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      subagent?: { enableProfiles?: unknown };
    };
    return raw?.subagent?.enableProfiles === true;
  } catch {
    return false;
  }
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
  const out = Object.create(null) as Record<string, SubagentProfile>;
  for (const [name, def] of Object.entries(profiles as Record<string, unknown>)) {
    const p = parseProfile(def);
    if (p) out[name] = p;
  }
  return out;
}

/**
 * Render the available profiles as a compact human-readable list so the LLM
 * can pick one by name without reading settings.json. The built-in "current"
 * profile is always listed first.
 *
 * e.g. "current (model+thinking = this session's current values), low (model=anthropic/claude-3.5-haiku, thinking=off), high (thinking=medium)"
 */
export function formatProfileSummary(profiles: Record<string, SubagentProfile>): string {
  const render = (n: string): string => {
    const p = profiles[n];
    const parts: string[] = [];
    if (p.model) parts.push(`model=${p.model}`);
    if (p.thinking) parts.push(`thinking=${p.thinking}`);
    return parts.length ? `${n} (${parts.join(", ")})` : n;
  };
  const builtin = `current (model+thinking = this session's current values)`;
  // A user-defined "current" replaces the built-in description line entirely.
  if (Object.hasOwn(profiles, CURRENT_PROFILE)) {
    return Object.keys(profiles).map(render).join(", ");
  }
  const custom = Object.keys(profiles).map(render).join(", ");
  return custom ? `${builtin}, ${custom}` : builtin;
}

export function loadProfiles(cwd: string, projectTrusted: boolean): Record<string, SubagentProfile> {
  const global = loadProfilesFrom(path.join(getAgentDir(), "settings.json"));
  if (!projectTrusted) return global;
  const project = loadProfilesFrom(path.join(cwd, CONFIG_DIR_NAME, "settings.json"));
  return { ...global, ...project };
}

export function loadProfilesIfEnabled(
  cwd: string,
  projectTrusted: boolean,
  enabled: boolean = isProfilesEnabled(path.join(getAgentDir(), "settings.json")),
): Record<string, SubagentProfile> {
  return enabled ? loadProfiles(cwd, projectTrusted) : {};
}

export function validateProfiles(
  requested: (string | undefined)[],
  available: Record<string, SubagentProfile>,
): string[] {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const name of requested) {
    if (name === undefined) continue;
    const key = name.trim();
    if (key === "") continue; // caught by the compulsory-profile check
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === CURRENT_PROFILE) continue; // built-in, always valid
    if (!Object.hasOwn(available, key)) invalid.push(key);
  }
  return invalid;
}

/**
 * Look up a requested profile by name. The built-in "current" profile is not
 * stored in the map; it resolves to the parent session's live model+thinking
 * (which then wins over any agent-definition model in resolveProfile). A
 * user-defined profile named "current" overrides the built-in.
 */
export function lookupProfile(
  profileName: string | undefined,
  profiles: Record<string, SubagentProfile>,
  parent: DispatchDefaults,
): SubagentProfile | undefined {
  if (profileName === undefined) return undefined;
  const key = profileName.trim();
  if (key === "") return undefined;
  if (key === CURRENT_PROFILE && !Object.hasOwn(profiles, CURRENT_PROFILE)) {
    const cur: SubagentProfile = {};
    if (parent.model !== undefined) cur.model = parent.model;
    if (parent.thinkingLevel !== undefined) cur.thinking = parent.thinkingLevel;
    return cur;
  }
  // hasOwn guard: defense-in-depth against prototype-chain names if a caller
  // ever skips validateProfiles.
  return Object.hasOwn(profiles, key) ? profiles[key] : undefined;
}

/** Every valid profile name for error/advertising text: built-in "current" first. */
export function availableProfileNames(profiles: Record<string, SubagentProfile>): string[] {
  return Object.hasOwn(profiles, CURRENT_PROFILE)
    ? Object.keys(profiles)
    : [CURRENT_PROFILE, ...Object.keys(profiles)];
}

/**
 * Error text for a missing (or empty) profile parameter. The profile param is
 * compulsory: every spawned subagent must name one explicitly.
 */
export function profileRequiredMessage(profiles: Record<string, SubagentProfile>): string {
  return (
    "The profile parameter is compulsory: every subagent must name an execution profile " +
    `(single mode: top-level "profile"; parallel mode: "profile" on each task). ` +
    `Use "${CURRENT_PROFILE}" to run with this session's current model+thinking, or pick one of: ` +
    `${availableProfileNames(profiles).join(", ")}.`
  );
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