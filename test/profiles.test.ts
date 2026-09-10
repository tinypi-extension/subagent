// test/profiles.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadProfilesFrom,
  loadProfilesIfEnabled,
  resolveProfile,
  validateProfiles,
  lookupProfile,
  availableProfileNames,
  profileRequiredMessage,
  formatProfileSummary,
  isProfilesEnabled,
  type SubagentProfile,
} from "../src/profiles.ts";
import type { DispatchDefaults } from "../src/types.ts";

function tmpFile(contents: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pi-profiles-"));
  const f = path.join(d, "settings.json");
  fs.writeFileSync(f, contents);
  return f;
}

const PARENT: DispatchDefaults = { model: "p/react", thinkingLevel: "medium" };

test("isProfilesEnabled requires an explicit true tag", () => {
  assert.equal(isProfilesEnabled(tmpFile(JSON.stringify({ subagent: { enableProfiles: true } }))), true);
  assert.equal(isProfilesEnabled(tmpFile(JSON.stringify({ subagent: { enableProfiles: false } }))), false);
  assert.equal(isProfilesEnabled(tmpFile(JSON.stringify({ subagent: {} }))), false);
  assert.equal(isProfilesEnabled(tmpFile(JSON.stringify({ subagent: { enableProfiles: "true" } }))), false);
  assert.equal(isProfilesEnabled(tmpFile("not json")), false);
});

test("disabled profiles produce no usable profiles", () => {
  const f = tmpFile(JSON.stringify({ subagent: { profiles: { fast: { thinking: "off" } } } }));
  assert.deepEqual(loadProfilesIfEnabled("/tmp", true, false), {});
  assert.deepEqual(loadProfilesIfEnabled(path.dirname(f), true, false), {});
});

test("loadProfilesFrom parses valid profiles and drops malformed ones", () => {
  const f = tmpFile(JSON.stringify({
    subagent: { profiles: {
      low: { model: "a/x", thinking: "off" },
      medium: { thinking: "low" },              // model missing -> ok
      bad: { thinking: "ultra" },               // invalid level -> dropped
      empty: {},                                // empty -> dropped
      notobj: 42,                               // not object -> dropped
    } },
  }));
  const p = loadProfilesFrom(f);
  assert.deepEqual(Object.keys(p).sort(), ["low", "medium"]);
  assert.deepEqual(p.low, { model: "a/x", thinking: "off" });
  assert.deepEqual(p.medium, { thinking: "low" });
});

test("loadProfilesFrom handles missing file and non-object subagent", () => {
  assert.deepEqual(loadProfilesFrom("/no/such/file.json"), {});
  const f = tmpFile(JSON.stringify({ subagent: "nope" }));
  assert.deepEqual(loadProfilesFrom(f), {});
});

test("loadProfilesFrom treats a profile named __proto__ as an own key without polluting the prototype", () => {
  const f = tmpFile(`{"subagent":{"profiles":{"__proto__":{"thinking":"off"}}}}`);
  const p = loadProfilesFrom(f);
  assert.equal(Object.hasOwn(p, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(p), null);
  assert.deepEqual(Object.keys(p), ["__proto__"]);
  assert.deepEqual(p["__proto__"], { thinking: "off" });
});

test("resolveProfile full chain: profile -> agent -> parent", () => {
  // profile present (both)
  assert.deepEqual(
    resolveProfile({ model: "pro/m", thinking: "high" }, { model: "ag/m" }, PARENT),
    { model: "pro/m", thinkingLevel: "high" },
  );
  // profile omitted, agent has model -> agent model, no inherited thinking
  assert.deepEqual(resolveProfile(undefined, { model: "ag/m" }, PARENT), { model: "ag/m" });
  // profile omitted, no agent model -> parent model + parent thinking
  assert.deepEqual(resolveProfile(undefined, undefined, PARENT), { model: "p/react", thinkingLevel: "medium" });
  // profile with model only, agent has model -> profile model wins, thinking falls to model default (neither set)
  assert.deepEqual(resolveProfile({ model: "pro/m" }, { model: "ag/m" }, PARENT), { model: "pro/m" });
  // profile with thinking only, no agent model -> parent model + profile thinking
  assert.deepEqual(resolveProfile({ thinking: "off" }, undefined, PARENT), { model: "p/react", thinkingLevel: "off" });
  // profile with thinking only, agent HAS model -> agent model + profile thinking (profile thinking wins)
  assert.deepEqual(resolveProfile({ thinking: "off" }, { model: "ag/m" }, PARENT), { model: "ag/m", thinkingLevel: "off" });
  // no model anywhere
  assert.deepEqual(resolveProfile(undefined, undefined, {}), {});
});

test("formatProfileSummary always advertises the built-in current profile", () => {
  assert.equal(formatProfileSummary({}), "current (model+thinking = this session's current values)");
  assert.equal(
    formatProfileSummary({
      low: { model: "a/x", thinking: "off" },
      high: { thinking: "medium" },
      bare: {},
    }),
    "current (model+thinking = this session's current values), low (model=a/x, thinking=off), high (thinking=medium), bare",
  );
  // A user-defined "current" replaces the built-in line.
  assert.equal(
    formatProfileSummary({ current: { model: "u/m" } }),
    "current (model=u/m)",
  );
});

test("validateProfiles returns unique invalid names", () => {
  const available: Record<string, SubagentProfile> = { low: {}, high: {} };
  assert.deepEqual(validateProfiles(["low", "high"], available), []);
  assert.deepEqual(validateProfiles([undefined, "low"], available), []);
  assert.deepEqual(validateProfiles(["low", "turbo", "turbo"], available), ["turbo"]);
});

test("validateProfiles rejects prototype-chain names that are not own keys", () => {
  assert.deepEqual(validateProfiles(["toString"], {}), ["toString"]);
  assert.deepEqual(validateProfiles(["constructor", "__proto__"], { low: {} }), ["constructor", "__proto__"]);
  // but an own key with a prototype-ish name still validates
  const available: Record<string, SubagentProfile> = { toString: {} };
  assert.deepEqual(validateProfiles(["toString"], available), []);
});

test('built-in "current" profile validates even with no profiles defined', () => {
  assert.deepEqual(validateProfiles(["current"], {}), []);
  assert.deepEqual(validateProfiles(["current"], { low: {} }), []);
});

test("lookupProfile resolves the built-in current to the parent's live model+thinking", () => {
  const parent = { model: "p/react", thinkingLevel: "medium" as const };
  assert.deepEqual(lookupProfile(undefined, {}, parent), undefined);
  assert.deepEqual(lookupProfile("current", {}, parent), { model: "p/react", thinking: "medium" });
  // built-in current beats the agent definition in resolveProfile
  assert.deepEqual(resolveProfile(lookupProfile("current", {}, parent), { model: "agent/m" }, parent), {
    model: "p/react",
    thinkingLevel: "medium",
  });
  // a user-defined "current" wins over the built-in
  const custom: Record<string, SubagentProfile> = { current: { model: "c/m", thinking: "off" } };
  assert.deepEqual(lookupProfile("current", custom, parent), { model: "c/m", thinking: "off" });
});

test("availableProfileNames and profileRequiredMessage include the built-in current", () => {
  assert.deepEqual(availableProfileNames({}), ["current"]);
  assert.deepEqual(availableProfileNames({ low: {}, high: {} }), ["current", "low", "high"]);
  assert.deepEqual(availableProfileNames({ current: {}, low: {} }), ["current", "low"]);
  const msg = profileRequiredMessage({ low: {} });
  assert.ok(msg.includes("compulsory"));
  assert.ok(msg.includes('"current"'));
  assert.ok(msg.includes("low"));
});

test("profile names are trimmed before validation and lookup", () => {
  const available: Record<string, SubagentProfile> = { low: { model: "p/low", thinking: "off" } };
  assert.deepEqual(validateProfiles([" low ", " current "], available), [], "padded names are valid");
  assert.deepEqual(validateProfiles(["   "], available), [], "blank names defer to the compulsory check");
  assert.deepEqual(validateProfiles([" bogus "], available), ["bogus"], "error text reports the trimmed name");
  assert.deepEqual(lookupProfile(" low ", available, {}), { model: "p/low", thinking: "off" });
  assert.deepEqual(lookupProfile("current  ", available, { model: "p/react", thinkingLevel: "high" }), { model: "p/react", thinking: "high" });
  assert.equal(lookupProfile("  ", available, {}), undefined);
  // defense-in-depth: prototype-chain names never resolve even if validation is skipped
  assert.equal(lookupProfile("constructor", available, {}), undefined);
  assert.equal(lookupProfile("toString", available, {}), undefined);
});