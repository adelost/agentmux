import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForDreamOwnerResult } from "../cli/dream.mjs";

const dateKey = "2026-09-08";
const runId = "4cec3221-59f7-4d3a-8496-f542346363bc";
const sourceSha256 = "a".repeat(64);
const owner = { agent: "example", pane: 4, engine: "codex" };
const expected = `DREAM_OK ${dateKey} ${runId}`;
async function verify(items, { busy = false, source = "codex-jsonl" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dream-final-receipt-"));
  const outputPath = join(root, "summary.md");
  writeFileSync(outputPath, `> Kuraterad av example:4 efter verifierad kompaktering · run \`${runId}\` · source \`${sourceSha256}\`.\n- Verified result.\n`);
  try {
    return await waitForDreamOwnerResult({ owner, dateKey, runId, sourceSha256, outputPath,
      prompt: "exact original prompt", attempts: 1,
      ctx: { agent: { isBusy: async () => busy, getResponseStreamWithRaw: async (_a, _p, prompt) => {
        expect(prompt).toBe("exact original prompt");
        return { source, items };
      } } } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("Dream exact terminal response", () => {
  it("accepts the final journal receipt after ordinary working commentary", async () => {
    expect((await verify([
      { type: "text", content: "I will read the input first." },
      { type: "tool", content: "Read input" },
      { type: "text", content: expected },
    ])).ok).toBe(true);
  });
  it("rejects quotations, extra text, a later action, wrong runs, busy panes and screen-only proof", async () => {
    for (const [items, options] of [
      [[{ type: "text", content: `The expected receipt is ${expected}` }]],
      [[{ type: "text", content: expected + " extra" }]],
      [[{ type: "text", content: expected }, { type: "tool", content: "Still acting" }]],
      [[{ type: "text", content: expected.replace(runId, "another-run") }]],
      [[{ type: "text", content: expected }], { busy: true }],
      [[{ type: "text", content: expected }], { source: "tmux" }],
    ]) expect((await verify(items, options)).ok).toBe(false);
  });
});
