// test/agents.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents, formatAgentNames, type AgentConfig } from "../agents.ts";

function agent(name: string, source: "user" | "project"): AgentConfig {
  return { name, source, description: `${name} does things`, systemPrompt: "", filePath: `/agents/${name}.md` };
}

test("formatAgentNames lists project agents before user agents, alphabetical within each group", () => {
  const r = formatAgentNames(
    [agent("worker", "user"), agent("zulu", "project"), agent("planner", "user"), agent("alpha", "project")],
    12,
  );
  assert.equal(r.text, "alpha (project), zulu (project), planner (user), worker (user)");
  assert.equal(r.remaining, 0);
});

test("formatAgentNames does not depend on input order", () => {
  // discoverAgents returns Map insertion order (user first), not sorted output.
  const r = formatAgentNames([agent("zeta", "user"), agent("beta", "project")], 12);
  assert.equal(r.text, "beta (project), zeta (user)");
});

test("formatAgentNames does not mutate the input array", () => {
  const input = [agent("worker", "user"), agent("foo", "project")];
  formatAgentNames(input, 12);
  assert.deepEqual(input.map((a) => a.name), ["worker", "foo"]);
});

test("formatAgentNames caps at maxItems and reports the dropped count", () => {
  const input = ["a", "b", "c", "d", "e"].map((n) => agent(n, "user"));
  const r = formatAgentNames(input, 3);
  assert.equal(r.text, "a (user), b (user), c (user)");
  assert.equal(r.remaining, 2);
});

test("truncation drops user-level names before any project agent", () => {
  const r = formatAgentNames(
    [agent("zulu", "project"), agent("alpha", "user"), agent("bravo", "user"), agent("charlie", "user"), agent("delta", "user")],
    2,
  );
  assert.equal(r.text, "zulu (project), alpha (user)");
  assert.equal(r.remaining, 3);
});

test("formatAgentNames with maxItems 0 lists nothing but still counts the rest", () => {
  const r = formatAgentNames([agent("planner", "user"), agent("scout", "user")], 0);
  assert.equal(r.text, "");
  assert.equal(r.remaining, 2);
});

test("formatAgentNames returns empty text for no agents", () => {
  assert.deepEqual(formatAgentNames([], 12), { text: "", remaining: 0 });
});

test("a malformed frontmatter file is skipped without taking down its siblings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-"));
  try {
    const agentsDir = path.join(root, ".pi", "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "foo.md"), "---\nname: foo\ndescription: project agent\n---\nbody\n");
    fs.writeFileSync(path.join(agentsDir, "bad.md"), "---\nname: bad\ndescription: [\n---\nbody\n");
    const result = discoverAgents(root, "project");
    assert.deepEqual(result.agents.map((a) => a.name), ["foo"]);
    assert.equal(formatAgentNames(result.agents, 12).text, "foo (project)");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
