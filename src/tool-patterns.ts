// Glob-style tool-name patterns for every tool list this extension handles:
// agent-frontmatter `tools:` / `deny-tools:`, the `subagent` tool's `tools`
// parameter, and the child-side PI_DENY_TOOLS filter.
//
// Contract (confirmed with the user):
// - A token is a pattern only when it contains `*`; plain names stay exact
//   matches, so existing agent files behave identically.
// - `*` matches anywhere in the token (`codegraph_*`, `*_files`, `mcp_*`) and
//   stands for any run of characters. No `?`, no character classes, no regex,
//   case-sensitive.
// - Allowlist patterns are expanded against the parent's configured tool
//   names before the child's `--tools` argv is built (pi core's allowlist is
//   exact-name only). A pattern that matches nothing is kept literal and
//   surfaced as a warning: silently dropping it would hide typos and
//   MCP-registration surprises, and hard-failing one bad token is too harsh.
// - Deny patterns are matched at the point of use (the child compares each
//   candidate tool name against the entries), so they need no name source.

/** True when an entry contains a glob `*` and must be treated as a pattern. */
export function isToolPattern(entry: string): boolean {
	return entry.includes("*");
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `name` satisfies a tool-list entry (exact match, or glob when the entry contains `*`). */
export function toolPatternMatches(name: string, entry: string): boolean {
	if (!isToolPattern(entry)) return name === entry;
	const source = entry.split("*").map(escapeRegExp).join("[\\s\\S]*");
	return new RegExp(`^${source}$`).test(name);
}

/** Split a comma-separated tool-list string into trimmed, non-empty entries. */
export function parseToolEntries(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Expand pattern entries to concrete tool names.
 *
 * Plain entries pass through unchanged; patterns are replaced by the
 * available names they match (available-list order, deduplicated). A pattern
 * matching nothing is kept literal and reported in `unmatched`.
 */
export function expandToolPatterns(
	entries: string[],
	available: string[],
): { expanded: string[]; unmatched: string[] } {
	const expanded: string[] = [];
	const unmatched: string[] = [];
	const seen = new Set<string>();
	const push = (name: string) => {
		if (!seen.has(name)) {
			seen.add(name);
			expanded.push(name);
		}
	};
	for (const entry of entries) {
		if (!isToolPattern(entry)) {
			push(entry);
			continue;
		}
		const matches = available.filter((name) => toolPatternMatches(name, entry));
		if (matches.length === 0) {
			unmatched.push(entry);
			push(entry);
		} else {
			for (const m of matches) push(m);
		}
	}
	return { expanded, unmatched };
}

/** Pattern entries that match none of `available` (plain names are never reported). */
export function unmatchedToolPatterns(entries: string[], available: string[]): string[] {
	return entries.filter(
		(entry) => isToolPattern(entry) && !available.some((name) => toolPatternMatches(name, entry)),
	);
}

export function unmatchedWarningText(pattern: string): string {
	return `warning: tool pattern "${pattern}" matched no available tools; passed through literally`;
}

// ── parent-side tool-name source ────────────────────────────────────────────
// Set once at extension load to `() => pi.getAllTools().map(t => t.name)`.
// Lazy on purpose: frontmatter is parsed at load time (before all extensions
// have registered their tools), but expansion happens at spawn time, when the
// registry is complete. Unset (tests, odd load orders) yields an empty list,
// which degrades every pattern to literal-plus-warning — never to a crash.

let toolNameSource: (() => string[]) | null = null;

export function setToolNameSource(fn: (() => string[]) | null): void {
	toolNameSource = fn;
}

/** Current configured tool names, or [] when no source is wired. */
export function getToolNames(): string[] {
	try {
		return toolNameSource ? toolNameSource() : [];
	} catch {
		return [];
	}
}
