import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDreamSources, buildDreamBatch } from "../core/dream-summarizer.mjs";

describe("Dream activity behind large Codex compaction records", () => {
  it.each([700_000, 3_000_000, 9_000_000])("classifies a %i-byte compact tail without losing work silently", (size) => {
    const root = mkdtempSync(join(tmpdir(), "dream-compact-history-"));
    const oldHome = process.env.HOME;
    process.env.HOME = root;
    try {
      const cwd = join(root, "repo/.agents/0");
      const dir = join(root, ".codex/sessions/2026/09/06");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "rollout.jsonl"), [
        { type: "session_meta", payload: { cwd, id: "fixture", source: "cli", originator: "codex-tui" } },
        { type: "event_msg", timestamp: "2026-09-06T03:30:00Z", payload: { type: "user_message", message: "Finish launch" } },
        { type: "response_item", timestamp: "2026-09-06T03:31:00Z", payload: { type: "message", role: "assistant",
          content: [{ type: "output_text", text: "Merged S4. Public launch remains blocked." }] } },
        { type: "event_msg", timestamp: "2026-09-06T03:32:00Z", payload: { type: "task_complete" } },
        { type: "compacted", timestamp: "2026-09-06T03:39:00Z", replacement_history: "x".repeat(size) },
      ].map(JSON.stringify).join("\n") + "\n");
      const result = collectDreamSources([{ name: "ai", dir: join(root, "repo"), panes: [{ engine: "codex" }] }],
        Date.parse("2026-09-05T04:00:00Z"));
      if (size < 8 * 1024 * 1024) {
        expect(result.unreadable).toEqual([]);
        expect(result.sources).toHaveLength(1);
        expect(result.sources[0]).toMatchObject({ agent: "ai", pane: 0, turns: 1, activityCursor: "2026-09-06T03:30:00Z" });
        const batch = buildDreamBatch(result.sources, "2026-09-06");
        expect(batch.payload.panes[0].turns[0].assistant).toContain("Public launch remains blocked");
        expect(Buffer.byteLength(batch.sourceText)).toBeLessThan(5120);
      } else {
        expect(result.sources).toEqual([]);
        expect(result.unreadable).toEqual([{ agent: "ai", pane: 0, engine: "codex",
          reason: "dream-history-window-exhausted: no attributable work in 8MiB tail" }]);
      }
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
