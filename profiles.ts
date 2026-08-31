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
 * can pick one by name without reading settings.json.
 *
 * e.g. "low (model=anthropic/claude-3.5-haiku, thinking=off), high (thinking=medium)"
 * or "no profiles defined" when the map is empty.
 */
export function formatProfileSummary(profiles: Record<string, SubagentProfile>): string {
  const names = Object.keys(profiles);
  if (names.length === 0) return "no profiles defined";
  return names
    .map((n) => {
      const p = profiles[n];
      const parts: string[] = [];
      if (p.model) parts.push(`model=${p.model}`);
      if (p.thinking) parts.push(`thinking=${p.thinking}`);
      return parts.length ? `${n} (${parts.join(", ")})` : n;
    })
    .join(", ");
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
    if (seen.has(name)) continue;
    seen.add(name);
    if (!Object.hasOwn(available, name)) invalid.push(name);
  }
  return invalid;
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