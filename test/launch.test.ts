// launch plan tests — adapted from pi-herdr-subagents test/launch.test.ts for
// this migration: no fork/lineage seeding (artifact delivery only), two-flag
// thinking (--model X --thinking Y), and $(cat …) system-prompt substitution.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildLaunchPlan,
  buildPiPromptArgs,
  buildResumeLaunchPlan,
  buildSubagentToolAllowlist,
  getArtifactDir,
  resolveResumeLaunchBehavior,
  shellEscape,
  type LaunchPlan,
  type LaunchPlanContext,
  type SubagentLaunchParams,
} from "../src/launch.ts";
import type { AgentDefaults } from "../src/agent-defs.ts";

interface Fixture {
  root: string;
  cwd: string;
  piBin: string;
  agentDir: string;
  env: Record<string, string | undefined>;
}

const cleanups: Array<() => void> = [];
const savedAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  if (savedAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "herdr-launch-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });

  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const piBin = join(binDir, "pi");
  writeFileSync(piBin, "#!/bin/bash\nexit 0\n");
  chmodSync(piBin, 0o755);

  const agentDir = join(root, "agent-config");
  mkdirSync(agentDir, { recursive: true });
  // agent-defs helpers (resolveSubagentPaths / getDefaultSessionDirFor) read
  // PI_CODING_AGENT_DIR via getAgentDir(); keep it in sync with ctx.env.
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const env: Record<string, string | undefined> = {
    PATH: `${binDir}:/usr/bin:/bin`,
    PI_CODING_AGENT_DIR: agentDir,
    HERDR_PANE_ID: "w1:p1",
  };

  return { root, cwd, piBin, agentDir, env };
}

function makeCtx(fx: Fixture, overrides?: Partial<LaunchPlanContext>): LaunchPlanContext {
  return {
    sessionDir: join(fx.root, "orch-sessions"),
    sessionId: "orch-session-id",
    parentCwd: fx.cwd,
    env: fx.env,
    id: "abcd1234",
    now: new Date("2026-07-06T12:00:00.000Z"),
    ...overrides,
  };
}

function baseParams(overrides?: Partial<SubagentLaunchParams>): SubagentLaunchParams {
  return { name: "Worker", task: "Do the thing", ...overrides };
}

function plan(
  fx: Fixture,
  params?: Partial<SubagentLaunchParams>,
  agentDefs: AgentDefaults | null = null,
  ctxOverrides?: Partial<LaunchPlanContext>,
): LaunchPlan {
  return buildLaunchPlan(baseParams(params), agentDefs, makeCtx(fx, ctxOverrides));
}

function scriptOf(p: LaunchPlan): string {
  const file = p.files.find((f) => f.path === p.launchScriptFile);
  assert.ok(file, "launch script must be in plan.files");
  return file.content;
}

describe("launch plan: env wrapping (direnv / prefix overrides)", () => {
  it("wraps with direnv exec when cwd has .envrc", () => {
    const fx = makeFixture();
    writeFileSync(join(fx.cwd, ".envrc"), "use devenv\n");
    const script = scriptOf(plan(fx, { cwd: fx.cwd }));
    assert.ok(
      script.includes(`direnv exec ${shellEscape(fx.cwd)} ${shellEscape(fx.piBin)}`),
      `expected direnv wrap in:\n${script}`,
    );
  });

  it("wraps with direnv exec when an ancestor dir has .envrc", () => {
    const fx = makeFixture();
    writeFileSync(join(fx.root, ".envrc"), "use devenv\n");
    const nested = join(fx.cwd, "sub", "dir");
    mkdirSync(nested, { recursive: true });
    const script = scriptOf(plan(fx, { cwd: nested }));
    assert.ok(script.includes(`direnv exec ${shellEscape(nested)} ${shellEscape(fx.piBin)}`));
  });

  it("does not wrap without .envrc", () => {
    const fx = makeFixture();
    const script = scriptOf(plan(fx, { cwd: fx.cwd }));
    assert.ok(!script.includes("direnv"), `unexpected direnv in:\n${script}`);
  });

  it("PI_HERDR_DIRENV=0 disables autodetect", () => {
    const fx = makeFixture();
    writeFileSync(join(fx.cwd, ".envrc"), "use devenv\n");
    fx.env.PI_HERDR_DIRENV = "0";
    const script = scriptOf(plan(fx, { cwd: fx.cwd }));
    assert.ok(!script.includes("direnv"));
  });

  it("PI_HERDR_LAUNCH_PREFIX overrides autodetect (plain prefix)", () => {
    const fx = makeFixture();
    writeFileSync(join(fx.cwd, ".envrc"), "use devenv\n");
    fx.env.PI_HERDR_LAUNCH_PREFIX = "mise exec --";
    const script = scriptOf(plan(fx, { cwd: fx.cwd }));
    assert.ok(script.includes(`mise exec -- ${shellEscape(fx.piBin)}`));
    assert.ok(!script.includes("direnv"));
  });

  it("PI_HERDR_LAUNCH_PREFIX interpolates {cwd}", () => {
    const fx = makeFixture();
    fx.env.PI_HERDR_LAUNCH_PREFIX = "nix develop {cwd} -c";
    const script = scriptOf(plan(fx, { cwd: fx.cwd }));
    assert.ok(script.includes(`nix develop ${shellEscape(fx.cwd)} -c ${shellEscape(fx.piBin)}`));
  });

  it("empty PI_HERDR_LAUNCH_PREFIX disables wrapping even with .envrc", () => {
    const fx = makeFixture();
    writeFileSync(join(fx.cwd, ".envrc"), "use devenv\n");
    fx.env.PI_HERDR_LAUNCH_PREFIX = "";
    const script = scriptOf(plan(fx, { cwd: fx.cwd }));
    assert.ok(!script.includes("direnv"));
    assert.ok(script.includes(`\n${shellEscape(fx.piBin)} `), "pi invoked unwrapped");
  });
});

describe("launch plan: pi binary resolution", () => {
  it("resolves an absolute pi from PATH by default (never bare `pi`)", () => {
    const fx = makeFixture();
    const p = plan(fx);
    assert.equal(p.piArgv[0], fx.piBin);
    assert.ok(p.piArgv[0].startsWith("/"), "pi binary must be absolute");
    const script = scriptOf(p);
    assert.ok(!/(^|[^/'\w])pi\s/.test(script.split("\n").find((l) => l.includes("--session")) ?? ""));
  });

  it("PI_HERDR_PI_BIN overrides the binary", () => {
    const fx = makeFixture();
    fx.env.PI_HERDR_PI_BIN = "/opt/custom/pi";
    const p = plan(fx);
    assert.equal(p.piArgv[0], "/opt/custom/pi");
    assert.ok(scriptOf(p).includes(shellEscape("/opt/custom/pi")));
  });

  it("throws a clear error when pi is not on PATH", () => {
    const fx = makeFixture();
    fx.env.PATH = "/nonexistent-dir-xyz";
    assert.throws(() => plan(fx), /pi.*PATH/i);
  });
});

describe("launch plan: curated env exports", () => {
  it("exports orchestrator PATH and PI_SUBAGENT_* vars, never a full env dump", () => {
    const fx = makeFixture();
    fx.env.SECRET_XYZ = "leak-me-not";
    fx.env.PI_SUBAGENT_ID = "parents-own-id"; // orchestrator is itself a subagent
    const agentDefs: AgentDefaults = { autoExit: true, denyTools: "subagent" };
    const p = plan(fx, { agent: "worker" }, agentDefs);
    const script = scriptOf(p);

    assert.ok(script.includes(`export PATH=${shellEscape(fx.env.PATH!)}`));
    assert.ok(script.includes(`export PI_SUBAGENT_NAME=${shellEscape("Worker")}`));
    assert.ok(script.includes(`export PI_SUBAGENT_ID=${shellEscape("abcd1234")}`));
    assert.ok(script.includes(`export PI_SUBAGENT_SESSION=${shellEscape(p.sessionFile)}`));
    assert.ok(script.includes(`export PI_SUBAGENT_AGENT=${shellEscape("worker")}`));
    assert.ok(script.includes("export PI_SUBAGENT_AUTO_EXIT=1"));
    assert.ok(script.includes(`export PI_DENY_TOOLS=${shellEscape("subagent")}`));
    // pane id is only known inside the pane; forwarded from herdr's own env
    assert.ok(script.includes('export PI_SUBAGENT_PANE="${HERDR_PANE_ID:-}"'));

    assert.ok(!script.includes("SECRET_XYZ"), "full env vars must not leak");
    assert.ok(!script.includes("parents-own-id"), "orchestrator's own PI_SUBAGENT_ID must not leak");
  });

  it("omits PI_SUBAGENT_AUTO_EXIT and PI_SUBAGENT_AGENT without agent defs", () => {
    const fx = makeFixture();
    const script = scriptOf(plan(fx));
    assert.ok(!script.includes("PI_SUBAGENT_AUTO_EXIT"));
    assert.ok(!script.includes("PI_SUBAGENT_AGENT="));
  });

  it("local .pi/agent wins for PI_CODING_AGENT_DIR", () => {
    const fx = makeFixture();
    const localAgentDir = join(fx.cwd, ".pi", "agent");
    mkdirSync(localAgentDir, { recursive: true });
    const script = scriptOf(plan(fx, { cwd: fx.cwd }));
    assert.ok(script.includes(`export PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`));
  });

  it("inherits env PI_CODING_AGENT_DIR when no local .pi/agent", () => {
    const fx = makeFixture();
    const script = scriptOf(plan(fx, { cwd: fx.cwd }));
    assert.ok(script.includes(`export PI_CODING_AGENT_DIR=${shellEscape(fx.agentDir)}`));
  });
});

describe("launch plan: exitcode sidecar and hold-open", () => {
  it("writes the run-id-stamped exitcode sidecar and holds open only in the startup window", () => {
    const fx = makeFixture();
    const p = plan(fx);
    const script = scriptOf(p);
    assert.ok(
      script.includes(`echo "$code $PI_SUBAGENT_ID" > ${shellEscape(`${p.sessionFile}.exitcode`)}`),
    );
    assert.ok(script.includes(`[ "$code" -ne 0 ] && [ "$SECONDS" -lt 15 ]`));
    assert.ok(script.includes("read -r"));
    assert.equal(p.holdOpenSecs, 15);
  });

  it("PI_HERDR_HOLD_OPEN_SECS overrides the window", () => {
    const fx = makeFixture();
    fx.env.PI_HERDR_HOLD_OPEN_SECS = "30";
    const p = plan(fx);
    assert.ok(scriptOf(p).includes(`[ "$SECONDS" -lt 30 ]`));
    assert.equal(p.holdOpenSecs, 30);
  });

  it("PI_HERDR_HOLD_OPEN_SECS=0 removes hold-open entirely", () => {
    const fx = makeFixture();
    fx.env.PI_HERDR_HOLD_OPEN_SECS = "0";
    const p = plan(fx);
    const script = scriptOf(p);
    assert.ok(!script.includes("read -r"));
    assert.ok(!script.includes("-lt"));
    assert.equal(p.holdOpenSecs, 0);
    // sidecar write must survive hold-open removal
    assert.ok(script.includes(`echo "$code $PI_SUBAGENT_ID" > ${shellEscape(`${p.sessionFile}.exitcode`)}`));
  });
});

describe("launch plan: pi argv", () => {
  it("passes --session, -e subagent-done, and the @task artifact in every launch", () => {
    const fx = makeFixture();
    const donePath = join(fx.root, "subagent-done.ts");
    const p = plan(fx, {}, null, { subagentDonePath: donePath });
    const argv = p.piArgv;
    assert.equal(argv[argv.indexOf("--session") + 1], p.sessionFile);
    assert.equal(argv[argv.indexOf("-e") + 1], donePath);
    assert.ok(donePath.startsWith("/"));
    // artifact delivery is the only mode — every launch gets an @file arg
    assert.ok(p.taskArtifactFile, "task artifact expected for every launch");
    assert.equal(argv[argv.length - 1], `@${p.taskArtifactFile}`);
    assert.match(p.taskArtifactFile!, /context\/worker-.*\.md$/);
  });

  it("emits --model and --thinking as two separate argv entries", () => {
    const fx = makeFixture();
    const p = plan(fx, {}, { model: "anthropic/claude-x", thinking: "high" });
    const argv = p.piArgv;
    const i = argv.indexOf("--model");
    assert.equal(argv[i + 1], "anthropic/claude-x");
    assert.equal(argv[i + 2], "--thinking");
    assert.equal(argv[i + 3], "high");
    // no model:thinking colon syntax anywhere
    assert.ok(!argv.some((a) => a.includes("claude-x:high")));
  });

  it("emits --thinking alone when only thinking is set", () => {
    const fx = makeFixture();
    const p = plan(fx, { thinking: "low" });
    const argv = p.piArgv;
    assert.ok(!argv.includes("--model"));
    assert.equal(argv[argv.indexOf("--thinking") + 1], "low");
  });

  it("param model/thinking override agent-def model/thinking", () => {
    const fx = makeFixture();
    const p = plan(
      fx,
      { model: "openai/gpt-x", thinking: "low" },
      { model: "anthropic/claude-x", thinking: "high" },
    );
    const argv = p.piArgv;
    assert.equal(argv[argv.indexOf("--model") + 1], "openai/gpt-x");
    assert.equal(argv[argv.indexOf("--thinking") + 1], "low");
  });

  it("omits --model/--thinking when neither param nor agent def provides them", () => {
    const fx = makeFixture();
    const p = plan(fx);
    assert.ok(!p.piArgv.includes("--model"));
    assert.ok(!p.piArgv.includes("--thinking"));
  });

  it("system prompt replace mode emits --system-prompt with an escaped $(cat …) of the sysprompt file", () => {
    const fx = makeFixture();
    const p = plan(fx, {}, { body: "You are a worker.", systemPromptMode: "replace" });
    const argv = p.piArgv;
    assert.ok(p.syspromptFile, "sysprompt artifact expected");
    const i = argv.indexOf("--system-prompt");
    assert.ok(i !== -1);
    assert.ok(!argv.includes("--append-system-prompt"));
    // raw-text-only flag → content injected via double-quoted $(cat <escaped-path>)
    assert.equal(argv[i + 1], `$(cat ${shellEscape(p.syspromptFile)})`);
    const file = p.files.find((f) => f.path === p.syspromptFile);
    assert.equal(file?.content, "You are a worker.");
    // identity moved to system prompt — not duplicated in the task
    const task = p.files.find((f) => f.path === p.taskArtifactFile);
    assert.ok(!task?.content.includes("You are a worker."));
  });

  it("system prompt append mode emits --append-system-prompt with the $(cat …) substitution", () => {
    const fx = makeFixture();
    const p = plan(fx, {}, { body: "Append me.", systemPromptMode: "append" });
    const argv = p.piArgv;
    assert.ok(p.syspromptFile);
    const i = argv.indexOf("--append-system-prompt");
    assert.ok(i !== -1);
    assert.ok(!argv.includes("--system-prompt"));
    assert.equal(argv[i + 1], `$(cat ${shellEscape(p.syspromptFile!)})`);
  });

  it("embeds agent body in the task when no system-prompt mode", () => {
    const fx = makeFixture();
    const p = plan(fx, {}, { body: "You are a worker." });
    assert.equal(p.syspromptFile, null);
    assert.ok(!p.piArgv.includes("--system-prompt"));
    const task = p.files.find((f) => f.path === p.taskArtifactFile);
    assert.ok(task?.content.includes("You are a worker."));
  });

  it("--tools allowlist always includes caller_ping and subagent_done", () => {
    const fx = makeFixture();
    const p = plan(fx, {}, { tools: "read,bash" });
    const argv = p.piArgv;
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,bash,caller_ping,subagent_done");
  });

  it("omits --tools without an explicit restriction", () => {
    const fx = makeFixture();
    assert.ok(!plan(fx).piArgv.includes("--tools"));
  });

  it("passes skill prompts with the empty-separator trick for artifact delivery", () => {
    const fx = makeFixture();
    const p = plan(fx, {}, { skills: "review,lint" });
    const argv = p.piArgv;
    const tail = argv.slice(-4);
    assert.deepEqual(tail, ["", "/skill:review", "/skill:lint", `@${p.taskArtifactFile}`]);
  });
});

describe("launch plan: task delivery (artifact only)", () => {
  it("writes the task artifact with wrapper instructions in every launch", () => {
    const fx = makeFixture();
    const p = plan(fx, { task: "Fix the bug" }, { autoExit: true });
    const task = p.files.find((f) => f.path === p.taskArtifactFile);
    assert.ok(task);
    assert.ok(task.content.includes("Fix the bug"));
    assert.ok(task.content.includes("Complete your task autonomously."));
    assert.ok(task.content.includes("Your FINAL assistant message"));
  });

  it("non-auto-exit agents get the subagent_done wrapper instructions", () => {
    const fx = makeFixture();
    const p = plan(fx, {}, { autoExit: false });
    const task = p.files.find((f) => f.path === p.taskArtifactFile);
    assert.ok(task?.content.includes("call the subagent_done tool"));
  });

  it("session-mode frontmatter values cannot switch delivery away from artifact", () => {
    const fx = makeFixture();
    const p = plan(fx, {}, { sessionMode: "standalone" });
    assert.ok(p.taskArtifactFile);
    assert.equal(p.piArgv[p.piArgv.length - 1], `@${p.taskArtifactFile}`);
  });
});

describe("launch plan: structure", () => {
  it("pane start carries the launch script path beside the caller pane", () => {
    const fx = makeFixture();
    const p = plan(fx, { cwd: fx.cwd });
    assert.equal(p.paneStart.launchScriptFile, p.launchScriptFile);
    assert.equal(p.paneStart.cwd, fx.cwd);
    assert.equal(p.paneStart.name, "Worker");
    assert.equal(p.paneStart.targetPaneId, "w1:p1");
    assert.equal(p.paneStart.direction, "right");
    assert.match(p.launchScriptFile, /subagent-scripts\/worker-abcd1234\.sh$/);
    assert.ok(p.launchScriptFile.includes(join("artifacts", "orch-session-id")));
  });

  it("defaults cwd to the orchestrator cwd", () => {
    const fx = makeFixture();
    const p = plan(fx);
    assert.equal(p.paneStart.cwd, fx.cwd);
    assert.ok(scriptOf(p).includes(`cd ${shellEscape(fx.cwd)}`));
  });

  it("session file lives under the per-cwd session dir and carries the id", () => {
    const fx = makeFixture();
    const p = plan(fx);
    assert.ok(p.sessionFile.endsWith(".jsonl"));
    assert.ok(p.sessionFile.includes("abcd1234"));
    assert.ok(p.sessionFile.includes(join(fx.agentDir, "sessions")));
  });

  it("rejects cli: claude with a clear unsupported error", () => {
    const fx = makeFixture();
    assert.throws(
      () => plan(fx, { agent: "cc" }, { cli: "claude" }),
      /not supported by pi-herdr-subagents/,
    );
  });

  it("generated script passes bash -n (system-prompt $(cat) included)", () => {
    const fx = makeFixture();
    writeFileSync(join(fx.cwd, ".envrc"), "use devenv\n");
    const p = plan(fx, { cwd: fx.cwd, agent: "worker" }, {
      autoExit: true,
      tools: "read,bash",
      skills: "commit",
      model: "anthropic/claude-x",
      thinking: "high",
      body: "You are a worker.",
      systemPromptMode: "append",
      denyTools: "web_search",
    });
    const scriptPath = join(fx.root, "check.sh");
    writeFileSync(scriptPath, scriptOf(p));
    execFileSync("bash", ["-n", scriptPath]); // throws on syntax error
  });

  it("generated script actually passes the system-prompt content as one argument", () => {
    const fx = makeFixture();
    const p = plan(fx, {}, { body: "You are a worker.\nLine two.", systemPromptMode: "replace" });
    // execute the script's pi invocation against a stub that prints its argv
    const stub = join(fx.root, "bin", "pi");
    writeFileSync(
      stub,
      '#!/bin/bash\nfor a in "$@"; do printf \'"%s"\\n\' "$a"; done\n',
    );
    chmodSync(stub, 0o755);
    const dir = mkdtempSync(join(tmpdir(), "herdr-launch-exec-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // write plan files so the $(cat) source exists, then run the script
    for (const f of p.files) {
      mkdirSync(join(f.path, ".."), { recursive: true });
      writeFileSync(f.path, f.content);
    }
    const scriptPath = join(fx.root, "run.sh");
    writeFileSync(scriptPath, scriptOf(p));
    const out = execFileSync("bash", [scriptPath], { encoding: "utf8" });
    assert.ok(out.includes('"--system-prompt"'), `argv dump:\n${out}`);
    assert.ok(out.includes('"You are a worker.\nLine two."'), `content must arrive as ONE raw-text arg:\n${out}`);
  });
});

describe("resume launch plan", () => {
  it("resumes the existing session with subagent-done and an @resume-message artifact", () => {
    const fx = makeFixture();
    const donePath = join(fx.root, "subagent-done.ts");
    const sessionPath = join(fx.agentDir, "sessions", "child.jsonl");
    const p = buildResumeLaunchPlan(
      { sessionPath, name: "Worker", message: "continue with phase 2" },
      makeCtx(fx, { subagentDonePath: donePath }),
    );

    assert.equal(p.sessionFile, sessionPath);
    assert.equal(p.id, "abcd1234");
    assert.equal(p.name, "Worker");
    assert.equal(p.autoExit, true);
    assert.equal(p.interactive, false);
    assert.match(p.launchScriptFile, /subagent-scripts\/worker-resume-abcd1234\.sh$/);

    const argv = p.piArgv;
    assert.equal(argv[0], fx.piBin);
    assert.equal(argv[argv.indexOf("--session") + 1], sessionPath);
    assert.equal(argv[argv.indexOf("-e") + 1], donePath);
    assert.ok(p.resumeMessageFile);
    assert.match(p.resumeMessageFile!, /subagent-resume\/worker-.*\.md$/);
    assert.equal(argv[argv.length - 1], `@${p.resumeMessageFile}`);
    const msg = p.files.find((f) => f.path === p.resumeMessageFile);
    assert.equal(msg?.content, "continue with phase 2");

    const script = p.files.find((f) => f.path === p.launchScriptFile)!.content;
    assert.ok(script.includes(`export PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`));
    assert.ok(script.includes("export PI_SUBAGENT_AUTO_EXIT=1"));
    assert.ok(script.includes(`echo "$code $PI_SUBAGENT_ID" > ${shellEscape(`${sessionPath}.exitcode`)}`));
    assert.ok(script.includes(`cd ${shellEscape(fx.cwd)}`));
  });

  it("omits the resume message artifact when no message is given", () => {
    const fx = makeFixture();
    const p = buildResumeLaunchPlan(
      { sessionPath: join(fx.agentDir, "s.jsonl") },
      makeCtx(fx),
    );
    assert.equal(p.resumeMessageFile, null);
    assert.equal(p.files.filter((f) => f.path.endsWith(".md")).length, 0);
  });

  it("autoExit: false yields an interactive resume", () => {
    const fx = makeFixture();
    const p = buildResumeLaunchPlan(
      { sessionPath: join(fx.agentDir, "s.jsonl"), autoExit: false },
      makeCtx(fx),
    );
    assert.equal(p.autoExit, false);
    assert.equal(p.interactive, true);
    assert.ok(!p.files.find((f) => f.path === p.launchScriptFile)!.content.includes("PI_SUBAGENT_AUTO_EXIT"));
  });

  it("resolveResumeLaunchBehavior defaults to auto-exit / non-interactive", () => {
    assert.deepEqual(resolveResumeLaunchBehavior({}), { autoExit: true, interactive: false });
    assert.deepEqual(resolveResumeLaunchBehavior({ autoExit: true }), { autoExit: true, interactive: false });
    assert.deepEqual(resolveResumeLaunchBehavior({ autoExit: false }), { autoExit: false, interactive: true });
  });
});

describe("ported helpers", () => {
  it("shellEscape single-quotes and escapes embedded quotes", () => {
    assert.equal(shellEscape("plain"), "'plain'");
    assert.equal(shellEscape("it's"), "'it'\\''s'");
    assert.equal(shellEscape(""), "''");
  });

  it("buildSubagentToolAllowlist preserves requested tools and force-adds child control tools", () => {
    assert.equal(
      buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,caller_ping,subagent_done",
    );
    // force-added even when explicitly requested list omits them
    assert.equal(buildSubagentToolAllowlist("read"), "read,caller_ping,subagent_done");
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(buildSubagentToolAllowlist(undefined), null);
    assert.equal(buildSubagentToolAllowlist(""), null);
    assert.equal(buildSubagentToolAllowlist(" , "), null);
  });

  it("buildPiPromptArgs emits the system prompt as --system-prompt + $(cat …) substitution", () => {
    const file = "/tmp/some dir/sp.md";
    assert.deepEqual(
      buildPiPromptArgs({
        taskArg: "@task.md",
        systemPrompt: { file, mode: "replace" },
      }),
      ["--system-prompt", `$(cat ${shellEscape(file)})`, "@task.md"],
    );
    assert.deepEqual(
      buildPiPromptArgs({
        taskArg: "@task.md",
        systemPrompt: { file, mode: "append" },
      }),
      ["--append-system-prompt", `$(cat ${shellEscape(file)})`, "@task.md"],
    );
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      buildPiPromptArgs({ effectiveSkills: "review,lint", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      buildPiPromptArgs({ effectiveSkills: undefined, taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("getArtifactDir follows the <sessionDir>/artifacts/<session-id> convention", () => {
    assert.equal(getArtifactDir("/s", "id1"), join("/s", "artifacts", "id1"));
  });
});
