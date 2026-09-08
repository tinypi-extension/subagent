// test/runtime-state.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	clearActiveSubagents,
	getActiveSubagentCount,
	markSubagentActive,
	markSubagentInactive,
} from "../src/runtime-state.ts";

test("active subagent count tracks mark/unmark as a set", () => {
	clearActiveSubagents();
	assert.equal(getActiveSubagentCount(), 0);

	markSubagentActive("a");
	markSubagentActive("b");
	assert.equal(getActiveSubagentCount(), 2);

	// Set semantics: marking the same id twice does not double-count
	markSubagentActive("a");
	assert.equal(getActiveSubagentCount(), 2);

	markSubagentInactive("a");
	assert.equal(getActiveSubagentCount(), 1);

	// removing an unknown id is a no-op
	markSubagentInactive("ghost");
	assert.equal(getActiveSubagentCount(), 1);

	clearActiveSubagents();
	assert.equal(getActiveSubagentCount(), 0);
});

test("state is process-global via Symbol.for (shared across module instances)", () => {
	clearActiveSubagents();
	markSubagentActive("shared");

	const key = Symbol.for("pi-herdr-subagents/active-subagent-ids");
	const ids = (globalThis as any)[key] as Set<string>;
	assert.ok(ids instanceof Set);
	assert.ok(ids.has("shared"));

	// a second import of the module sees the same Set
	// (simulated by clearing via the same global; counts round-trip)
	clearActiveSubagents();
	assert.equal(((globalThis as any)[key] as Set<string>).size, 0);
});
