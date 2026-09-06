import { describe, it, expect } from "vitest";
import { buildDreamBatch, DREAM_SOURCE_BYTES, DREAM_PROMPT_BYTES } from "../core/dream-summarizer.mjs";

function fixture(items) {
  const at = "2026-09-06T03:30:00Z";
  return { agent: "skyvw", pane: 3, engine: "codex", turns: 1, filesOmitted: 0,
    latestMs: Date.parse(at), activityCursor: at,
    entries: [{ timestamp: at, userPrompt: "Verify the final public image", items }] };
}

describe("Dream gives the latest assistant text priority within its existing budget", () => {
  it("keeps the terminal result instead of an over-budget rejected intermediate image", () => {
    const final = "Slutlig bild godkänd: RECORDING, ÅÄÖ och ikoner synliga. Tidigare bild avvisad.";
    const source = fixture([
      { type: "text", id: "early", content: "Jag kan inte godkänna bilden ännu. " + "Mellanresultat. ".repeat(600) },
      { type: "tool", id: "tool", content: "Not an assistant result" },
      { type: "text", id: "final", content: final },
      { type: "text", id: "blank", content: "  " },
    ]);
    const original = structuredClone(source);
    const batch = buildDreamBatch([source], "2026-09-06");
    const pane = batch.payload.panes[0];
    expect(pane.turns[0]).toMatchObject({ at: source.activityCursor, user: source.entries[0].userPrompt });
    expect(pane.turns[0].assistant).toContain(final);
    expect(pane.turns[0].assistant).toContain("Earlier assistant text omitted");
    expect(pane.turns[0].assistant).not.toContain("Jag kan inte godkänna");
    expect(Buffer.byteLength(JSON.stringify(pane))).toBeLessThanOrEqual(DREAM_SOURCE_BYTES);
    expect(Buffer.byteLength(batch.sourceText)).toBeLessThanOrEqual(DREAM_PROMPT_BYTES);
    expect(source).toEqual(original);
  });

  it("keeps chronological text unchanged when it fits", () => {
    const batch = buildDreamBatch([fixture([
      { type: "text", content: "First observation" }, { type: "text", content: "Final conclusion" },
    ])], "2026-09-06");
    expect(batch.payload.panes[0].turns[0].assistant).toBe("First observation\nFinal conclusion");
  });

  it("marks truncation even when the latest answer alone exceeds the budget", () => {
    const batch = buildDreamBatch([fixture([{ type: "text", content: "Terminal result " + "x".repeat(9_000) }])], "2026-09-06");
    expect(batch.payload.panes[0].turns[0].assistant).toContain("Terminal result");
    expect(batch.payload.panes[0].turns[0].assistant).toContain("truncated");
    expect(Buffer.byteLength(JSON.stringify(batch.payload.panes[0]))).toBeLessThanOrEqual(DREAM_SOURCE_BYTES);
  });
});
