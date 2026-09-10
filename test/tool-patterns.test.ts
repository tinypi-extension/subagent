// test/tool-patterns.test.ts — `*` globs in every tool-list surface.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
	expandToolPatterns,
	getToolNames,
	isToolPattern,
	parseToolEntries,
	setToolNameSource,
	toolPatternMatches,
	unmatchedToolPatterns,
} from "../src/tool-patterns.ts";

afterEach(() => setToolNameSource(null));

describe("tool pattern matching", () => {
	it("plain names are exact matches, never patterns", () => {
		assert.equal(isToolPattern("read"), false);
		assert.equal(toolPatternMatches("read", "read"), true);
		assert.equal(toolPatternMatches("bash", "read"), false);
		// a plain name must not act as a prefix
		assert.equal(toolPatternMatches("codegraph_codegraph_files", "codegraph"), false);
	});

	it("`*` matches anywhere in the token", () => {
		assert.equal(toolPatternMatches("codegraph_codegraph_files", "codegraph_*"), true);
		assert.equal(toolPatternMatches("mcp__codegraph__files", "*_files"), true);
		assert.equal(toolPatternMatches("mcp__codegraph__files", "*codegraph*"), true);
		assert.equal(toolPatternMatches("read", "*"), true);
		assert.equal(toolPatternMatches("codegraphXy", "codegraph_*"), false);
	});

	it("regex metacharacters in the literal parts stay literal", () => {
		assert.equal(toolPatternMatches("a.b_c", "a.b_*"), true);
		assert.equal(toolPatternMatches("axb_c", "a.b_*"), false);
	});

	it("matching is case-sensitive", () => {
		assert.equal(toolPatternMatches("Codegraph_files", "codegraph_*"), false);
	});
});

describe("expandToolPatterns", () => {
	const available = [
		"read",
		"bash",
		"codegraph_codegraph_files",
		"codegraph_codegraph_callers",
		"mcp__search",
	];

	it("expands patterns to matching names, keeping plain names and order", () => {
		const { expanded, unmatched } = expandToolPatterns(["read", "codegraph_*"], available);
		assert.deepEqual(expanded, ["read", "codegraph_codegraph_files", "codegraph_codegraph_callers"]);
		assert.deepEqual(unmatched, []);
	});

	it("dedupes overlap between plain names and patterns", () => {
		const { expanded } = expandToolPatterns(["read", "re*", "read"], available);
		assert.deepEqual(expanded, ["read"]);
	});

	it("a pattern that matches nothing stays literal and is reported", () => {
		const { expanded, unmatched } = expandToolPatterns(["read", "foo_*"], available);
		assert.deepEqual(expanded, ["read", "foo_*"]);
		assert.deepEqual(unmatched, ["foo_*"]);
	});

	it("leading wildcard expands across servers", () => {
		const { expanded } = expandToolPatterns(["mcp__*"], available);
		assert.deepEqual(expanded, ["mcp__search"]);
	});

	it("unmatchedToolPatterns ignores plain entries and matched patterns", () => {
		assert.deepEqual(unmatchedToolPatterns(["read", "codegraph_*", "foo_*"], available), ["foo_*"]);
	});
});

describe("parseToolEntries", () => {
	it("splits, trims, and drops empties", () => {
		assert.deepEqual(parseToolEntries(" read , bash ,, codegraph_* "), ["read", "bash", "codegraph_*"]);
		assert.deepEqual(parseToolEntries(undefined), []);
	});
});

describe("tool-name source", () => {
	it("defaults to [] with no source; never throws out of a failing source", () => {
		assert.deepEqual(getToolNames(), []);
		setToolNameSource(() => {
			throw new Error("registry not ready");
		});
		assert.deepEqual(getToolNames(), []);
		setToolNameSource(() => ["read", "codegraph_a"]);
		assert.deepEqual(getToolNames(), ["read", "codegraph_a"]);
	});
});
