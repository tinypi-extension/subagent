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
  const out: Record<string, SubagentProfile> = {};
  for (const [name, def] of Object.entries(profiles as Record<string, unknown>)) {
    const p = parseProfile(def);
    if (p) out[name] = p;
  }
  return out;
}

export function loadProfiles(cwd: string, projectTrusted: boolean): Record<string, SubagentProfile> {
  const global = loadProfilesFrom(path.join(getAgentDir(), "settings.json"));
  if (!projectTrusted) return global;
  const project = loadProfilesFrom(path.join(cwd, CONFIG_DIR_NAME, "settings.json"));
  return { ...global, ...project };
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
    if (!(name in available)) invalid.push(name);
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