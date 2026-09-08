// agent-defs tests — frontmatter parsing, deny/interactive resolution, injectable dirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SPAWNING_TOOLS,
  defaultAgentDefDirs,
  getAgentConfigDir,
  loadAgentDefaults,
  parseAgentDefinition,
  resolveDenyTools,
  resolveEffectiveInteractive,
  resolveLaunchBehaviorStandalone,
  resolveSubagentPaths,
  getDefaultSessionDirFor,
} from "../src/agent-defs.ts";

function tmpDir(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const FM = (fields: string, body = ""): string =>
  fields ? `---\n${fields}\n---\n${body}` : body;

test("parseAgentDefinition reads every frontmatter field", () => {
  const def = parseAgentDefinition(
    FM(
      [
        "name: Scout",
        "description: Explores the codebase",
        "model: anthropic/claude-x",
        "tools: read,bash,write",
        "skill: review",
        "thinking: high",
        "deny-tools: web_search, exec",
        "spawning: false",
        "auto-exit: true",
        "interactive: false",
        "session-mode: standalone",
        "cwd: packages/app",
        "cli: pi",
        "system-prompt: append",
        "disable-model-invocation: true",
      ].join("\n"),
      "You are a scout.",
    ),
    "fallback",
  );
  assert.ok(def);
  assert.equal(def.name, "Scout");
  assert.equal(def.description, "Explores the codebase");
  assert.equal(def.model, "anthropic/claude-x");
  assert.equal(def.tools, "read,bash,write");
  assert.equal(def.skills, "review");
  assert.equal(def.thinking, "high");
  assert.equal(def.denyTools, "web_search, exec");
  assert.equal(def.spawning, false);
  assert.equal(def.autoExit, true);
  assert.equal(def.interactive, false);
  assert.equal(def.sessionMode, "standalone");
  assert.equal(def.cwd, "packages/app");
  assert.equal(def.cli, "pi");
  assert.equal(def.systemPromptMode, "append");
  assert.equal(def.disableModelInvocation, true);
  assert.equal(def.body, "You are a scout.");
});

test("parseAgentDefinition accepts skills alias and unquoted YAML booleans", () => {
  const def = parseAgentDefinition(FM("skills: lint\ndisabled: no\nspawning: true\nauto-exit: false"), "");
  assert.ok(def);
  assert.equal(def.skills, "lint");
  assert.equal(def.spawning, true);
  assert.equal(def.autoExit, false);
});

test("parseAgentDefinition falls back to the file name when name is missing", () => {
  const def = parseAgentDefinition(FM("description: x"), "worker");
  assert.ok(def);
  assert.equal(def.name, "worker");
  assert.equal(def.disableModelInvocation, false);
  // empty body → undefined, not ""
  assert.equal(def.body, undefined);
});

test("session-mode lineage/fork values are parsed but treated as standalone", () => {
  for (const value of ["lineage-only", "fork"]) {
    const def = parseAgentDefinition(FM(`session-mode: ${value}`), "x");
    assert.ok(def);
    assert.equal(def.sessionMode, "standalone", `session-mode: ${value} must resolve to standalone`);
  }
  const unknown = parseAgentDefinition(FM("session-mode: bogus"), "x");
  assert.ok(unknown);
  assert.equal(unknown.sessionMode, undefined);
});

test("parseAgentDefinition returns null without a frontmatter block", () => {
  assert.equal(parseAgentDefinition("just some text", "x"), null);
});

test("parseAgentDefinition returns null on malformed frontmatter", () => {
  assert.equal(parseAgentDefinition(FM("tools: [unclosed"), "x"), null);
  assert.equal(parseAgentDefinition(FM("a: b\n  bad: indent: nesting"), "x"), null);
});

test("resolveDenyTools expands spawning:false and adds deny-tools", () => {
  assert.equal(resolveDenyTools(null).size, 0);
  assert.equal(resolveDenyTools({}).size, 0);

  const spawningOff = resolveDenyTools({ spawning: false });
  for (const t of SPAWNING_TOOLS) assert.ok(spawningOff.has(t), `expected ${t} denied`);

  const explicit = resolveDenyTools({ denyTools: "read, bash ,," });
  assert.deepEqual([...explicit].sort(), ["bash", "read"]);

  const both = resolveDenyTools({ spawning: false, denyTools: "exec" });
  assert.ok(both.has("subagent"));
  assert.ok(both.has("exec"));
});

test("resolveEffectiveInteractive: param > frontmatter > inverse auto-exit", () => {
  assert.equal(resolveEffectiveInteractive({ name: "n", task: "t", interactive: true }, { interactive: false }), true);
  assert.equal(resolveEffectiveInteractive({ name: "n", task: "t", interactive: false }, { interactive: true }), false);
  assert.equal(resolveEffectiveInteractive({ name: "n", task: "t" }, { interactive: true }), true);
  assert.equal(resolveEffectiveInteractive({ name: "n", task: "t" }, { autoExit: true }), false);
  assert.equal(resolveEffectiveInteractive({ name: "n", task: "t" }, { autoExit: false }), true);
  // no defs at all → interactive
  assert.equal(resolveEffectiveInteractive({ name: "n", task: "t" }, null), true);
});

test("resolveSubagentPaths resolves relative cwd against process.cwd()", () => {
  const { effectiveCwd } = resolveSubagentPaths({ name: "n", task: "t", cwd: "sub/dir" }, null);
  assert.equal(effectiveCwd, join(process.cwd(), "sub/dir"));
});

test("resolveSubagentPaths keeps absolute cwd and picks up a local .pi/agent", () => {
  const { root, cleanup } = tmpDir("agent-defs-paths-");
  try {
    const localAgentDir = join(root, "work", ".pi", "agent");
    mkdirSync(localAgentDir, { recursive: true });
    const r = resolveSubagentPaths({ name: "n", task: "t", cwd: join(root, "work") }, null);
    assert.equal(r.effectiveCwd, join(root, "work"));
    assert.equal(r.localAgentDir, localAgentDir);
    assert.equal(r.effectiveAgentDir, localAgentDir);

    // no local .pi/agent → falls back to the global config dir
    const r2 = resolveSubagentPaths({ name: "n", task: "t", cwd: root }, null);
    assert.equal(r2.effectiveAgentDir, getAgentConfigDir());
  } finally {
    cleanup();
  }
});

test("getDefaultSessionDirFor encodes the cwd and creates the directory", () => {
  const { root, cleanup } = tmpDir("agent-defs-sessions-");
  try {
    const agentDir = join(root, "agent");
    const dir = getDefaultSessionDirFor("/tmp/work dir", agentDir);
    assert.equal(dir, join(agentDir, "sessions", "--tmp-work dir--"));
    assert.ok(existsSync(dir));
  } finally {
    cleanup();
  }
});

test("loadAgentDefaults honors injectable directories, project dir wins", () => {
  const { root, cleanup } = tmpDir("agent-defs-dirs-");
  try {
    const projectDir = join(root, "project-agents");
    const userDir = join(root, "user-agents");
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });

    writeFileSync(join(projectDir, "worker.md"), "---\nmodel: project/model\n---\n");
    writeFileSync(join(userDir, "worker.md"), "---\nmodel: user/model\nthinking: low\n---\n");
    writeFileSync(join(userDir, "scout.md"), "---\nmodel: user/scout\n---\n");

    // project dir listed first → first match wins
    const worker = loadAgentDefaults("worker", [projectDir, userDir]);
    assert.ok(worker);
    assert.equal(worker.model, "project/model");
    assert.equal(worker.thinking, undefined, "user dir must not leak into the project match");

    const scout = loadAgentDefaults("scout", [projectDir, userDir]);
    assert.equal(scout?.model, "user/scout");

    assert.equal(loadAgentDefaults("missing", [projectDir, userDir]), null);
    // empty injectable list → null
    assert.equal(loadAgentDefaults("worker", []), null);
  } finally {
    cleanup();
  }
});

test("defaultAgentDefDirs puts the project dir before the user dir", () => {
  const dirs = defaultAgentDefDirs("/repo");
  assert.equal(dirs.length, 2);
  assert.equal(dirs[0], join("/repo", ".pi", "agents"));
  assert.equal(dirs[1], join(getAgentConfigDir(), "agents"));
});

test("getAgentConfigDir respects PI_CODING_AGENT_DIR", () => {
  const { root, cleanup } = tmpDir("agent-defs-configdir-");
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    assert.equal(getAgentConfigDir(), root);
  } finally {
    if (saved == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    cleanup();
  }
});

test("resolveLaunchBehaviorStandalone always returns artifact delivery", () => {
  assert.deepEqual(resolveLaunchBehaviorStandalone({ name: "n", task: "t" }, null), {
    taskDelivery: "artifact",
  });
  assert.deepEqual(
    resolveLaunchBehaviorStandalone({ name: "n", task: "t" }, { sessionMode: "standalone" }),
    { taskDelivery: "artifact" },
  );
});
