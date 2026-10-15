import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexDreamEvents } from "../core/codex-dream-history.mjs";
import { readSearchRecords } from "../core/search-jsonl.mjs";
import { codexUserPrompt } from "../core/codex-user-events.mjs";

function withJournal(events, test) {
  const root = mkdtempSync(join(tmpdir(), "codex-dream-stream-"));
  const file = join(root, "events.jsonl");
  writeFileSync(file, events.map(JSON.stringify).join("\n") + "\n");
  try { test(file); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("bounded cold-path Dream history", () => {
  it.each(["legacy", "modern"])("preserves the exact %s origin of a long turn outside the byte window", dialect => {
    const prompt = "Bevara min ursprungliga fråga med åäö, utan påhitt eller avkortning. ".repeat(20);
    const events = [
      { type: "event_msg", payload: { type: "task_started", turn_id: "same-task" } },
      ...(dialect === "modern" ? [{ type: "turn_context", payload: { turn_id: "same-task" } }] : []),
      dialect === "legacy" ? { type: "event_msg", payload: { type: "user_message", message: prompt } }
        : { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }],
          internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } },
      { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(4096) } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "SUMMARY: Klart" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "same-task" } },
    ];
    withJournal(events, file => {
      const tailBytes = Buffer.byteLength(events.slice(-2).map(JSON.stringify).join("\n") + "\n") + 10;
      const recovered = readCodexDreamEvents(file, { maxBytes: tailBytes });
      expect(recovered.map(codexUserPrompt).filter(text => text !== null)).toEqual([prompt]);
      if (dialect === "legacy") expect(recovered[0].payload).toMatchObject({ type: "task_started", turn_id: "same-task" });
      expect(recovered.at(-1).payload.type).toBe("task_complete");
    });
  });

  it("never attributes another task's output to a completed prompt", () => {
    withJournal([
      { type: "event_msg", payload: { type: "task_started", turn_id: "old" } },
      { type: "event_msg", payload: { type: "user_message", message: "Finished old task" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "old" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "other" } },
      { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(4096) } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Unattributed output" }] } },
    ], file => expect(readCodexDreamEvents(file, { maxBytes: 400 }).map(codexUserPrompt).filter(text => text !== null)).toEqual([]));
  });

  it("refuses an oversized origin instead of clipping the user's text", () => {
    withJournal([
      { type: "event_msg", payload: { type: "user_message", message: "x".repeat(4 * 1024 * 1024) } },
      { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(4096) } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "An answer" }] } },
    ], file => expect(() => readCodexDreamEvents(file, { maxBytes: 400 })).toThrow("dream-history-origin-record-exhausted"));
  });

  it("skips a new oversized image event while retaining the following human prompt", () => {
    withJournal([
      { timestamp: "2026-10-14T15:55:59.217Z", type: "event_msg",
        payload: { type: "image_generation_end", result: "x".repeat(4 * 1024 * 1024) } },
      { type: "event_msg", payload: { type: "user_message", message: "Behåll mitt uppdrag åäö" } },
    ], file => expect(readCodexDreamEvents(file).map(event => event.payload.message))
      .toEqual(["Behåll mitt uppdrag åäö"]));
  });

  it("refuses oversized authored text even when it quotes an ignorable type", () => {
    withJournal([{ type: "event_msg", payload: { type: "user_message",
      message: '{"type":"compacted",' + "x".repeat(4 * 1024 * 1024) } }], (file) => {
      expect(() => readCodexDreamEvents(file)).toThrow("dream-history-record-exhausted");
    });
  });

  // skyvw:3, Dream 2026-10-11: Codex now writes an ordinal before the type, and a
  // 5.7 MB tool output at byte 30433308 stopped the night's whole digest.
  it("skips an oversized tool output written with Codex's ordinal field", () => {
    withJournal([
      { timestamp: "2026-09-25T08:50:28.860Z", ordinal: 51960, type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "x".repeat(4 * 1024 * 1024) }] } },
      { timestamp: "2026-09-25T08:51:00.000Z", ordinal: 51961, type: "event_msg", payload: { type: "user_message", message: "Kör nästa steg" } },
    ], (file) => {
      expect(readCodexDreamEvents(file).map(e => e.payload.message)).toEqual(["Kör nästa steg"]);
    });
  });

  it("still refuses oversized authored text that follows an ordinal", () => {
    withJournal([{ timestamp: "2026-09-25T08:50:28.860Z", ordinal: 7, type: "event_msg",
      payload: { type: "user_message", message: '{"type":"compacted",' + "x".repeat(4 * 1024 * 1024) } }], (file) => {
      expect(() => readCodexDreamEvents(file)).toThrow("dream-history-record-exhausted");
    });
  });

  it.each([
    { type: "turn_context", payload: { turn_id: "t1" } },
    ...["task_started", "task_complete", "turn_aborted"].map(type => ({ type: "event_msg", payload: { type } })),
    ...["message", "function_call", "custom_tool_call"].map(type => ({ type: "response_item", payload: { type, role: "user" } })),
  ])("refuses an oversized consumed record: $type/$payload.type", event => {
    withJournal([{ ...event, padding: "x".repeat(4 * 1024 * 1024) }], file => {
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
      expect(readCodexDreamEvents(file, { endByteOffset: firstEnd }).map(codexUserPrompt)).toEqual(["before"]);
      const events = readCodexDreamEvents(file, { maxBytes: Buffer.byteLength(JSON.stringify(b) + "\n") + 5 });
      expect(events.map(e => e.payload.message)).toEqual(["after"]);
    });
  });
});
