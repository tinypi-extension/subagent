// test/context-usage.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONTEXT_USAGE_VERSION,
	contextUsagePath,
	consumeContextUsageSidecar,
	isContextUsageSnapshot,
	writeContextUsageSidecar,
} from "../src/context-usage.ts";

const usage = { tokens: 1234, contextWindow: 200000, percent: 0.617 };

test("contextUsagePath appends the .context-usage sidecar suffix", () => {
	assert.equal(contextUsagePath("/tmp/session.jsonl"), "/tmp/session.jsonl.context-usage");
});

test("isContextUsageSnapshot validates the sidecar shape", () => {
	assert.equal(isContextUsageSnapshot({ version: CONTEXT_USAGE_VERSION, subagentId: "sa1", ...usage }), true);
	// wrong version
	assert.equal(isContextUsageSnapshot({ version: 99, subagentId: "sa1", ...usage }), false);
	// missing/empty subagentId
	assert.equal(isContextUsageSnapshot({ version: CONTEXT_USAGE_VERSION, ...usage }), false);
	assert.equal(isContextUsageSnapshot({ version: CONTEXT_USAGE_VERSION, subagentId: "", ...usage }), false);
	// invalid tokens / percent
	assert.equal(isContextUsageSnapshot({ version: CONTEXT_USAGE_VERSION, subagentId: "sa1", tokens: -1, contextWindow: 100, percent: null }), false);
	assert.equal(isContextUsageSnapshot({ version: CONTEXT_USAGE_VERSION, subagentId: "sa1", tokens: null, contextWindow: 100, percent: Number.NaN }), false);
	// invalid contextWindow
	assert.equal(isContextUsageSnapshot({ version: CONTEXT_USAGE_VERSION, subagentId: "sa1", tokens: null, contextWindow: -5, percent: null }), false);
	// non-objects
	assert.equal(isContextUsageSnapshot(null), false);
	assert.equal(isContextUsageSnapshot("nope"), false);
	// null tokens/percent are allowed (unknown usage)
	assert.equal(isContextUsageSnapshot({ version: CONTEXT_USAGE_VERSION, subagentId: "sa1", tokens: null, contextWindow: 0, percent: null }), true);
});

test("writeContextUsageSidecar writes and consumeContextUsageSidecar reads the snapshot", () => {
	const dir = mkdtempSync(join(tmpdir(), "cu-test-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		assert.equal(writeContextUsageSidecar(sessionFile, "sa1", usage), true);
		const snap = consumeContextUsageSidecar(sessionFile, "sa1");
		assert.ok(snap);
		assert.equal(snap.version, CONTEXT_USAGE_VERSION);
		assert.equal(snap.subagentId, "sa1");
		assert.deepEqual({ tokens: snap.tokens, contextWindow: snap.contextWindow, percent: snap.percent }, usage);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writeContextUsageSidecar rejects invalid inputs", () => {
	const dir = mkdtempSync(join(tmpdir(), "cu-test-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		assert.equal(writeContextUsageSidecar(sessionFile, "", usage), false);
		assert.equal(writeContextUsageSidecar(sessionFile, "sa1", { tokens: -1, contextWindow: 100, percent: null }), false);
		assert.equal(existsSync(contextUsagePath(sessionFile)), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("overwrite: false never clobbers an existing sidecar", () => {
	const dir = mkdtempSync(join(tmpdir(), "cu-test-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		assert.equal(writeContextUsageSidecar(sessionFile, "first", { tokens: 1, contextWindow: 10, percent: 0.1 }), true);
		assert.equal(writeContextUsageSidecar(sessionFile, "second", { tokens: 2, contextWindow: 20, percent: 0.2 }, { overwrite: false }), false);
		const snap = consumeContextUsageSidecar(sessionFile, "first");
		assert.equal(snap?.subagentId, "first");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("consumeContextUsageSidecar enforces ownership and always consumes", () => {
	const dir = mkdtempSync(join(tmpdir(), "cu-test-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		writeContextUsageSidecar(sessionFile, "owner", usage);

		// foreign id gets null, but still consumes the sidecar
		assert.equal(consumeContextUsageSidecar(sessionFile, "foreign"), null);
		assert.equal(existsSync(contextUsagePath(sessionFile)), false);

		// malformed sidecar is consumed too
		writeFileSync(contextUsagePath(sessionFile), "{not json");
		assert.equal(consumeContextUsageSidecar(sessionFile, "owner"), null);
		assert.equal(existsSync(contextUsagePath(sessionFile)), false);

		// missing file → null, no throw
		assert.equal(consumeContextUsageSidecar(sessionFile, "owner"), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sidecar JSON on disk matches the published shape", () => {
	const dir = mkdtempSync(join(tmpdir(), "cu-test-"));
	try {
		const sessionFile = join(dir, "session.jsonl");
		writeContextUsageSidecar(sessionFile, "sa1", usage);
		const raw = JSON.parse(readFileSync(contextUsagePath(sessionFile), "utf8"));
		assert.deepEqual(raw, { version: CONTEXT_USAGE_VERSION, subagentId: "sa1", ...usage });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
