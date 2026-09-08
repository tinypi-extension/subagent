/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let frontmatter: AgentFrontmatter;
		let body: string;
		try {
			({ frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content));
		} catch {
			// Frontmatter is real YAML and throws on malformed input. Skipping the file is
			// the only safe response: this loop runs at extension-load time as well as per
			// call (index.ts discovers agents on module load to advertise their names), and
			// loader.js turns any throw during load into a null extension — one bad file
			// would silently remove the whole subagent tool. Same policy as parseToolList
			// above: a single bad file shortens the list, it never takes down the directory.
			continue;
		}

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

/**
 * Rank used to order names in prompt text: project agents first, then user agents.
 * The advertised list is capped by `MAX_LISTED_AGENTS` and truncated from the tail, so
 * the repo-specific names are the ones guaranteed a slot.
 */
const SOURCE_RANK: Record<AgentConfig["source"], number> = { project: 0, user: 1 };

/**
 * Render agent names for the tool description and the top-level `agent` param hint.
 *
 * Deliberately names only. An agent's `description` is long prose, and repeating one per
 * name on every prompt turn buys routing quality this feature does not claim — its goal
 * is giving the model legal values to copy. See
 * docs/superpowers/specs/2026-08-31-subagent-agent-names-in-description-design.md.
 *
 * `text` holds up to `maxItems` entries as `name (source)`, project-first and
 * alphabetical within each source; `remaining` is how many were dropped, so the caller
 * can append `+K more`. A dropped name still self-corrects: `run.ts` answers an unknown
 * agent with the full current list.
 *
 * Pure and total: returns `""` (not `"none"`) when there is nothing to list, so the
 * caller picks the empty-case wording, and never mutates `agents`.
 */
export function formatAgentNames(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	const sorted = [...agents].sort((a, b) => {
		const bySource = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
		return bySource !== 0 ? bySource : a.name.localeCompare(b.name);
	});
	const listed = sorted.slice(0, Math.max(0, maxItems));
	return {
		text: listed.map((a) => `${a.name} (${a.source})`).join(", "),
		remaining: sorted.length - listed.length,
	};
}
