/**
 * Phase 7 E2E: socket-level smoke test (NOT part of the test suite).
 * Opens a herdr pane via the ported client (hybrid: CLI paneStart + socket events),
 * waits for its exit event, and verifies the run-id-stamped exitcode sidecar
 * contract that src/launch.ts generates.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHerdrClient } from "../../src/herdr/client.ts";
import { createHerdrEventStream } from "../../src/herdr/events.ts";

const socketPath = process.env.HERDR_SOCKET_PATH;
const orchestratorPane = process.env.HERDR_PANE_ID;
if (!socketPath || !orchestratorPane) {
	console.error("must run inside a herdr pane");
	process.exit(1);
}

const runId = `e2e-${Date.now()}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-e2e-"));
const sessionFile = path.join(tmpDir, "fake-session.jsonl");
const launchScript = path.join(tmpDir, "launch.sh");
const sidecar = `${sessionFile}.exitcode`;

// Minimal stand-in for the real wrapper: ~2s observable lifetime, then write the
// run-id-stamped exitcode sidecar (same contract the real wrapper uses), exit 0.
fs.writeFileSync(
	launchScript,
	`#!/bin/bash
trap '' TSTP
sleep 2
echo "0 ${runId}" > ${JSON.stringify(sidecar)}
`,
);
fs.chmodSync(launchScript, 0o755);

const client = createHerdrClient();
const ping = await client.ping();
console.log("ping ok:", JSON.stringify(ping));

const controller = new AbortController();
const stream = createHerdrEventStream({ socketPath, signal: controller.signal });

const started = await client.paneStart({
	name: `e2e-${runId}`,
	cwd: tmpDir,
	targetPaneId: orchestratorPane,
	direction: "right",
	env: { PI_HERDR_LAUNCH_SCRIPT: launchScript },
	launchScriptFile: launchScript,
});
console.log("pane started:", started.paneId);

const outcome = await new Promise<string>((resolve, reject) => {
	const timeout = setTimeout(() => reject(new Error("timed out waiting for pane exit")), 30000);
	const unwatch = stream.watch(started.paneId, (ev) => {
		clearTimeout(timeout);
		unwatch();
		resolve(ev.event);
	});
});
await new Promise((r) => setTimeout(r, 500)); // grace: sidecar is written just before exit

console.log("pane event:", outcome);
const sidecarContent = fs.existsSync(sidecar) ? fs.readFileSync(sidecar, "utf8").trim() : "<missing>";
console.log("sidecar:", JSON.stringify(sidecarContent));
stream.close();
controller.abort();
const pass = sidecarContent === `0 ${runId}`;
console.log(pass ? "E2E PASS: pane launched via plugin, exit event observed, sidecar contract verified" : "E2E FAIL: sidecar mismatch");
process.exit(pass ? 0 : 1);
