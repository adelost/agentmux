import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

const HOUSEKEEPING = new Set([
  "attachment", "last-prompt", "ai-title", "mode", "permission-mode",
  "atis-latch", "pr-link", "history-suppression", "bridge-session",
  "file-history-snapshot",
]);
const localCommand = content => typeof content === "string" && /^\s*<(?:local-command|command-)/u.test(content);
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeMs === right.mtimeMs;

/** WHAT: Reads an exact Claude session for work since its last compact. WHY: Separates an empty epoch from unknown used context when token usage is absent. */
export async function hasEmptyClaudeEpoch(identity) {
  if (!identity?.path || !identity.sessionId) return false;
  let before;
  try { before = statSync(identity.path); } catch { return false; }
  if (!before.isFile() || before.size === 0) return false;

  let boundary = false;
  let empty = false;
  try {
    const lines = createInterface({ input: createReadStream(identity.path), crlfDelay: Infinity });
    for await (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { if (boundary) empty = false; continue; }
      if (entry?.type === "system" && entry.subtype === "compact_boundary") {
        boundary = entry.sessionId === identity.sessionId && !entry.isSidechain
          && Number.isFinite(Date.parse(entry.timestamp));
        empty = boundary;
        continue;
      }
      if (!boundary) continue;
      const content = entry?.message?.content;
      const harmless = HOUSEKEEPING.has(entry?.type)
        || (entry?.type === "user" && (entry.isCompactSummary === true || localCommand(content)));
      if (!harmless || entry.isSidechain || (entry.sessionId && entry.sessionId !== identity.sessionId)
          || entry?.message?.usage) empty = false;
    }
    return boundary && empty && sameFile(before, statSync(identity.path));
  } catch { return false; }
}
