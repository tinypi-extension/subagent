// Session summary extraction tests — trimmed port of pi-herdr-subagents
// test/session.test.ts to the three helpers kept in this migration
// (getNewEntries, findLastAssistantMessage, getSessionId). Fork/lineage
// seeding and merge helpers are not ported and thus not tested.
//
// Fixtures are real-shaped version-3 session .jsonl entries written to tmp
// dirs: `{"type":"session","version":3,...}` headers and `{"type":"message",
// "id","parentId","timestamp","message":{role,content}}` entries, as produced
// by this runtime's session manager (verified in Phase 0).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getNewEntries, getSessionId, findLastAssistantMessage } from "../src/session.ts";

describe("getSessionId", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-session-id-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the canonical uuid from the header line", () => {
    const file = join(dir, "ok.jsonl");
    writeFileSync(
      file,
      `{"id":"01a05eb1-ab3c-7e90-98ba-0ad1e767a2f0","type":"session","version":3,"cwd":"/tmp"}\n` +
        `{"id":"x","type":"message","parentId":null,"timestamp":"2025-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n`,
    );
    assert.equal(getSessionId(file), "01a05eb1-ab3c-7e90-98ba-0ad1e767a2f0");
  });

  it("returns null for missing, empty, or unparsable files instead of throwing", () => {
    assert.equal(getSessionId(join(dir, "nope.jsonl")), null);

    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    assert.equal(getSessionId(empty), null);

    const garbage = join(dir, "garbage.jsonl");
    writeFileSync(garbage, "not json at all\n");
    assert.equal(getSessionId(garbage), null);

    const noId = join(dir, "no-id.jsonl");
    writeFileSync(noId, `{"type":"session","version":3}\n`);
    assert.equal(getSessionId(noId), null);
  });
});

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "herdr-session-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3, cwd: "/tmp/proj" };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  timestamp: "2025-01-01T00:00:01.000Z",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  timestamp: "2025-01-01T00:00:02.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  timestamp: "2025-01-01T00:00:03.000Z",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  timestamp: "2025-01-01T00:00:04.000Z",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });

    it("throws for a missing file (callers guard)", () => {
      assert.throws(() => getNewEntries(join(dir, "missing.jsonl"), 0));
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        id: "asst-003",
        parentId: "user-001",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        id: "asst-004",
        parentId: "asst-003",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("joins multiple non-empty text blocks with newline and skips empty ones", () => {
      const multiBlock = {
        type: "message",
        id: "asst-005",
        parentId: "user-001",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First block." },
            { type: "text", text: "   " },
            { type: "text", text: "Second block." },
          ],
        },
      };
      assert.equal(findLastAssistantMessage([multiBlock]), "First block.\nSecond block.");
    });
  });
});
