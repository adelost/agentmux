import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCompactedCodexSession } from "./codex-compacted-session.mjs";
describe("native compact-only migration evidence", () => {
  it("reuses a compact-only session but refuses evidence after any new work", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-compact-proof-")), path = join(root, "rollout.jsonl"), sessionId = "exact";
    const events = [{ type: "session_meta", payload: { id: sessionId } }, { type: "event_msg", payload: { type: "task_started" } }, { type: "compacted" }, { type: "event_msg", payload: { type: "task_complete" } }];
    try {
      writeFileSync(path, events.map(JSON.stringify).join("\n") + "\n");
      expect(isCompactedCodexSession({ path, sessionId })).toBe(true);
      events.push({ type: "event_msg", payload: { type: "user_message", message: "new work" } });
      writeFileSync(path, events.map(JSON.stringify).join("\n") + "\n");
      expect(isCompactedCodexSession({ path, sessionId })).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
