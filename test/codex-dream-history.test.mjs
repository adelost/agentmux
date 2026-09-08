import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexDreamEvents } from "../core/codex-dream-history.mjs";
import { readSearchRecords } from "../core/search-jsonl.mjs";

function withJournal(events, test) {
  const root = mkdtempSync(join(tmpdir(), "codex-dream-stream-"));
  const file = join(root, "events.jsonl");
  writeFileSync(file, events.map(JSON.stringify).join("\n") + "\n");
  try { test(file); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("bounded cold-path Dream history", () => {
  it("refuses oversized authored text even when it quotes an ignorable type", () => {
    withJournal([{ type: "event_msg", payload: { type: "user_message",
      message: '{"type":"compacted",' + "x".repeat(4 * 1024 * 1024) } }], (file) => {
      expect(() => readCodexDreamEvents(file)).toThrow("dream-history-record-exhausted");
    });
  });

  it("bounds retained authored bytes rather than silently losing them", () => {
    withJournal([{ type: "event_msg", payload: { type: "user_message", message: "Preserve this" } }], (file) => {
      expect(() => readCodexDreamEvents(file, { maxKeptBytes: 10 })).toThrow("dream-history-content-exhausted");
    });
  });

  it("uses the caller's byte boundary and drops only a partial leading record", () => {
    const a = { type: "event_msg", payload: { type: "user_message", message: "before" } };
    const b = { type: "event_msg", payload: { type: "user_message", message: "after" } };
    withJournal([a, b], (file) => {
      const firstEnd = Buffer.byteLength(JSON.stringify(a) + "\n");
      expect([...readSearchRecords(file, { endByteOffset: firstEnd })].map(r => JSON.parse(r.raw))).toEqual([a]);
      const events = readCodexDreamEvents(file, { maxBytes: Buffer.byteLength(JSON.stringify(b) + "\n") + 5 });
      expect(events.map(e => e.payload.message)).toEqual(["after"]);
    });
  });
});
