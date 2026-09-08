// Session summary extraction (trimmed port of pi-herdr-subagents src/session.ts,
// MIT, HazAT — pi-interactive-subagents battle-tested parsers).
//
// Only the three helpers needed by the herdr watcher/messages paths are ported:
//   getNewEntries, findLastAssistantMessage, getSessionId.
// Fork/lineage seeding (seedSubagentSessionFile/getForkContentLines/getLeafId)
// and branch-merge helpers are NOT ported — this migration is standalone-only.
//
// Entry shape (verified against this runtime's session .jsonl in Phase 0):
// version-3 session files with `{"type":"session","version":3,...}` header lines
// and `{"type":"message","id","parentId","timestamp","message":{role,content}}`
// entries — exactly what these parsers expect. Summary extraction is crash-safe
// because the child session file is written incrementally.
import { readFileSync } from "node:fs";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  };
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Return the canonical pi session UUID from the session file's header line.
 *
 * The filename's id segment is not always the session UUID (it may be a hash),
 * so the header is the reliable source. Used to offer a short, copy-pasteable
 * `pi --session <uuid>` instead of a ~135-char absolute path that hard-wraps in
 * the result widget. Best-effort: returns null for a missing/empty/mangled file.
 */
export function getSessionId(sessionFile: string): string | null {
  try {
    const raw = readFileSync(sessionFile, "utf8");
    const firstLine = raw.split("\n").find((line) => line.trim());
    if (!firstLine) return null;
    const id = (JSON.parse(firstLine) as { id?: unknown }).id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");
  }
  return null;
}
