// Load-time tool advertising context (profiles + agent roster).
//
// The values are baked once at load time so the model can see them in tool
// descriptions and parameter hints. Agents are discovered ONCE here and both
// branch-specific wordings are derived from that single list, so the two
// activation branches can never advertise different agents or roles.
//
// Per-call discovery (discoverAgents(ctx.cwd, agentScope) inside each execute)
// remains authoritative; an unknown name is answered with the current list.

import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverAgents, formatAgentNames, formatAgentRoster } from "./agents.ts";
import {
	formatProfileSummary,
	isProfilesEnabled,
	loadProfilesFrom,
} from "./profiles.ts";
import { MAX_AGENT_DESC_CHARS, MAX_LISTED_AGENTS } from "./types.ts";

export interface ToolAdvert {
	registeredProfileNames: string[];
	registeredProfileSummary: string;
	profileHint: string;
	/** Blocking-branch wording: roster with descriptions, notes the list is a startup snapshot. */
	availableAgentsSentence: string;
	/** herdr-branch wording: same roster, terser sentence. */
	herdrAgentsSentence: string;
	agentParamHint: string;
}

export function buildAdvertContext(): ToolAdvert {
	// Bake the actually-defined subagent profiles into the tool's description and
	// parameter hints at load time, so the model knows what profiles exist without
	// having to read settings.json. Global config is stable here; project-level
	// profiles (loaded per-session in dispatch.ts) may add or override these, which
	// the description notes so the model doesn't assume this list is exhaustive.
	const globalSettingsPath = path.join(getAgentDir(), "settings.json");
	const profilesEnabled = isProfilesEnabled(globalSettingsPath);
	const registeredGlobalProfiles = profilesEnabled ? loadProfilesFrom(globalSettingsPath) : {};
	const registeredProfileNames = Object.keys(registeredGlobalProfiles);
	// formatProfileSummary always leads with the built-in "current" profile, so the
	// advertised list is never empty even with no custom profiles defined.
	const registeredProfileSummary = formatProfileSummary(registeredGlobalProfiles);
	const profileHint =
		registeredProfileNames.length === 0
			? `Compulsory. The built-in "current" (this session's current model+thinking) is the only profile defined so far; project-level .pi/settings.json may add more.`
			: `Compulsory. Currently available profile(s): ${registeredProfileSummary}. Pick one by name; also check project-level .pi/settings.json for any additional/overriding profiles.`;

	// Bake the agents that exist at load time into the tool description and the top-level
	// `agent` hint, so the model has legal names to copy instead of inventing them and can
	// route by role instead of by name. Scope "both" and the launch directory: extensions
	// load once per process, so this is the best available guess at the project set.
	//
	// Two renderings of the one discovery:
	//   - the roster (name + description) goes in the tool description, where routing happens;
	//   - names alone go in the `agent` param hint, which only has to offer legal values to
	//     copy — repeating the prose there would be a second copy of the same tokens.
	// Both come from the same list, so the two surfaces can never advertise different
	// agents, and both keep the same project-first truncation order.
	//
	// Three ways this load-time list can be wrong, all self-healing in one round-trip: a
	// name is missing (agents created after startup), a name is stale (a removed agent is
	// still advertised), or the list is empty (launching from a parent directory finds no
	// project agents at all). The authoritative set is always the per-call
	// discoverAgents(ctx.cwd, agentScope) in execute(), and run.ts answers an unknown
	// name with the full current list.
	const advertAgents = discoverAgents(process.cwd(), "both").agents;
	const rosterAdvert = formatAgentRoster(advertAgents, MAX_LISTED_AGENTS, MAX_AGENT_DESC_CHARS);
	const namesAdvert = formatAgentNames(advertAgents, MAX_LISTED_AGENTS);
	// `+K more` is appended per surface from its own `remaining`; the counts match
	// because the cap and ordering are shared.
	const agentRosterText =
		rosterAdvert.remaining > 0 ? `${rosterAdvert.text} +${rosterAdvert.remaining} more` : rosterAdvert.text;
	const agentNamesText =
		namesAdvert.remaining > 0 ? `${namesAdvert.text} +${namesAdvert.remaining} more` : namesAdvert.text;
	const hasAgentNames = namesAdvert.text.length > 0;
	const availableAgentsSentence = hasAgentNames
		? `Available agents, with what each is for: ${agentRosterText}. Captured at startup from the launch directory, so project-local agents added since then are missing. Passing an unknown name returns the full current list.`
		: `Available agents: none found at startup; project-local agents in ${CONFIG_DIR_NAME}/agents may still exist. Passing an unknown name returns the full current list.`;
	const agentParamHint = hasAgentNames
		? `Name of the agent to invoke (for single mode; the same names apply to items in tasks). Valid: ${agentNamesText}. Passing an unknown name returns the current list.`
		: `Name of the agent to invoke (for single mode; the same names apply to items in tasks). No agents were found at startup; passing any name returns the current list.`;
	// Same roster, herdr wording: it drops the "captured at startup" clause because
	// the fire-and-forget description is already long. Both sentences are derived from
	// the same discovery above, so they always list the same agents.
	const herdrAgentsSentence = agentRosterText
		? `Available agents, with what each is for: ${agentRosterText}. Passing an unknown name returns the full current list.`
		: `No agents found at startup; project-local agents in ${CONFIG_DIR_NAME}/agents may still exist. Passing any name returns the current list.`;

	return {
		registeredProfileNames,
		registeredProfileSummary,
		profileHint,
		availableAgentsSentence,
		herdrAgentsSentence,
		agentParamHint,
	};
}
