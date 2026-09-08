// test/run.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getPiInvocation } from "../src/run.ts";

const ORIGINAL_ARGV1 = process.argv[1];
const ORIGINAL_EXEC = process.execPath;

/** Temporarily override process.argv[1] for the duration of the test. */
function withArgv1<T>(argv1: string | undefined, fn: () => T): T {
	const prev = process.argv[1];
	if (argv1 === undefined) delete (process.argv as unknown as Record<number, string | undefined>)[1];
	else process.argv[1] = argv1;
	try {
		return fn();
	} finally {
		if (prev === undefined) delete (process.argv as unknown as Record<number, string | undefined>)[1];
		else process.argv[1] = prev;
	}
}

function tmpFile(name: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-invoke-"));
	const file = path.join(dir, name);
	fs.writeFileSync(file, "#!/usr/bin/env node\n", { mode: 0o755 });
	return file;
}

test("getPiInvocation reuses argv[1] only when it is the pi CLI entry", () => {
	const piBin = tmpFile("pi");
	const args = ["--mode", "json", "-p", "--no-session", "Task: hi"];

	// argv[1] is the pi binary itself -> invoke it directly.
	withArgv1(piBin, () => {
		const inv = getPiInvocation(args);
		assert.equal(inv.command, process.execPath);
		assert.deepEqual(inv.args, [piBin, ...args]);
	});

	// argv[1] is some other binary (e.g. pi-web's `next` bin inside a Next.js
	// server). Spawning it with pi args must NOT happen; fall back to `pi`.
	const nextBin = tmpFile("next");
	withArgv1(nextBin, () => {
		const inv = getPiInvocation(args);
		assert.equal(inv.command, "pi");
		assert.deepEqual(inv.args, args);
	});

	// argv[1] is a bun virtual script path.
	withArgv1("/$bunfs/root/entry.ts", () => {
		const inv = getPiInvocation(args);
		assert.equal(inv.command, "pi");
		assert.deepEqual(inv.args, args);
	});

	// argv[1] is missing entirely.
	withArgv1(undefined, () => {
		const inv = getPiInvocation(args);
		assert.equal(inv.command, "pi");
		assert.deepEqual(inv.args, args);
	});

	fs.rmSync(path.dirname(piBin), { recursive: true, force: true });
	fs.rmSync(path.dirname(nextBin), { recursive: true, force: true });
});

test("getPiInvocation recognizes pi-named entries regardless of extension", () => {
	const cases = ["pi", "pi.js", "pi.exe", "pi.cmd", "pi.ps1"];
	for (const name of cases) {
		const file = tmpFile(name);
		const inv = withArgv1(file, () => getPiInvocation([]));
		assert.equal(inv.command, process.execPath, `${name} should be (re)invoked directly`);
		assert.equal(inv.args[0], file);
		fs.rmSync(path.dirname(file), { recursive: true, force: true });
	}
});

test("getPiInvocation rejects pi-named lookalikes that are not the CLI", () => {
	for (const name of ["next", "next.js", "pi-web", "pi-web.js", "index.ts", "node"]) {
		const file = tmpFile(name);
		const inv = withArgv1(file, () => getPiInvocation([]));
		assert.equal(inv.command, "pi", `${name} should fall back to PATH pi`);
		fs.rmSync(path.dirname(file), { recursive: true, force: true });
	}
});

process.argv[1] = ORIGINAL_ARGV1 as string;