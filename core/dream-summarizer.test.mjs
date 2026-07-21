import { feature, component, unit, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readRecentTurnsAcrossClaudeSessions } from "./jsonl-reader.mjs";
import {
  buildDreamBatch, collectDreamSources, dreamPaneEngine, upsertDreamSummary,
  validateDreamSummary,
} from "./dream-summarizer.mjs";

const turn = (timestamp, userPrompt, assistant = "done") => ({
  timestamp, userPrompt, items: [{ type: "text", content: assistant }],
});

const source = (agent, pane, latestMs, text = "work") => ({
  agent, pane, engine: "claude", turns: 1,
  activityCursor: new Date(latestMs).toISOString(), latestMs, filesOmitted: 0,
  entries: [turn(new Date(latestMs).toISOString(), text)],
});

feature("stateless fleet dream input", () => {
  unit("recognizes all supported coding engines", {
    when: ["classifying configured panes", () => [
      dreamPaneEngine({ cmd: "claude --continue" }),
      dreamPaneEngine({ cmd: "codex --yolo" }),
      dreamPaneEngine({ engine: "kimi", cmd: "custom" }),
      dreamPaneEngine({ cmd: "bash" }),
    ]],
    then: ["only coding journals are selected", (engines) => {
      expect(engines).toEqual(["claude", "codex", "kimi", null]);
    }],
  });

  unit("collects every engine without consulting pane liveness", {
    given: ["three panes, an old receipt, and one maintenance turn", () => ({
      agents: [{ name: "fleet", dir: "/work", panes: [
        { cmd: "claude" }, { cmd: "codex" }, { cmd: "kimi-code" },
      ] }],
      receipts: { schemaVersion: 1, panes: {
        "fleet:0": { activityCursor: "2026-07-21T09:00:00Z", dreamedAt: "2026-07-21T09:01:00Z" },
      } },
    })],
    when: ["reading journals directly", ({ agents, receipts }) => collectDreamSources(
      agents, Date.parse("2026-07-21T08:00:00Z"), {
        receipts,
        readHistory: (engine) => ({ turns: [
          turn("2026-07-21T08:30:00Z", "old"),
          turn("2026-07-21T10:00:00Z", engine === "codex" ? "/compact" : `${engine} work`),
          turn("2026-07-21T11:00:00Z", `${engine} latest`),
        ] }),
      },
    )],
    then: ["receipt cutoffs and noise filtering apply per pane", (result) => {
      expect(result.unreadable).toEqual([]);
      expect(result.sources.map(({ engine, turns }) => ({ engine, turns }))).toEqual([
        { engine: "claude", turns: 2 },
        { engine: "codex", turns: 2 },
        { engine: "kimi", turns: 3 },
      ]);
      expect(result.sources[0].activityCursor).toBe("2026-07-21T11:00:00Z");
    }],
  });

  component("reads work before and after a Claude compact rotation", {
    given: ["two recently modified session files for one pane", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-rotated-"));
      const previousHome = process.env.HOME;
      process.env.HOME = root;
      const paneDir = "/workspace/ai/.agents/0";
      const project = join(root, ".claude", "projects", paneDir.replace(/[\/.]/g, "-"));
      mkdirSync(project, { recursive: true });
      const before = join(project, "before-compact.jsonl");
      const after = join(project, "after-compact.jsonl");
      writeFileSync(before, `${JSON.stringify({
        type: "user", timestamp: "2026-07-21T10:00:00Z",
        message: { role: "user", content: "important work before compact" },
      })}\n`);
      writeFileSync(after, `${JSON.stringify({
        type: "user", timestamp: "2026-07-21T11:00:00Z",
        message: { role: "user", content: "follow-up after compact" },
      })}\n`);
      utimesSync(before, new Date("2026-07-21T10:01:00Z"), new Date("2026-07-21T10:01:00Z"));
      utimesSync(after, new Date("2026-07-21T11:01:00Z"), new Date("2026-07-21T11:01:00Z"));
      return { root, previousHome, paneDir };
    }],
    when: ["reading the bounded multi-session window", ({ paneDir }) =>
      readRecentTurnsAcrossClaudeSessions(paneDir, {
        since: new Date("2026-07-21T09:00:00Z"), limit: 8, maxFiles: 6,
      })],
    then: ["both sides of compact are present", (result, fx) => {
      expect(result.turns.map((item) => item.userPrompt)).toEqual([
        "important work before compact", "follow-up after compact",
      ]);
      expect(result.filesRead).toBe(2);
      process.env.HOME = fx.previousHome;
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("fixed limits omit explicitly and never advance data silently", {
    given: ["three active sources", () => [
      source("ai", 0, 3_000), source("lsrc", 2, 2_000), source("sky", 1, 1_000),
    ]],
    when: ["building a one-pane batch", (sources) => buildDreamBatch(sources, "2026-07-21", { maxPanes: 1 })],
    then: ["newest is included and every omission has a cause", (batch) => {
      expect(batch.included.map((item) => `${item.agent}:${item.pane}`)).toEqual(["ai:0"]);
      expect(batch.omitted.map((item) => item.omitReason)).toEqual(["pane-limit", "pane-limit"]);
      expect(Buffer.byteLength(batch.prompt)).toBeLessThanOrEqual(96 * 1024);
    }],
  });

  unit("invalid model products cannot enter memory", {
    when: ["checking output boundaries", () => ({
      valid: validateDreamSummary("- beslut\n- nästa steg"),
      empty: validateDreamSummary(""),
      tooMany: validateDreamSummary("x\ny\nz", { maxLines: 2 }),
      marker: validateDreamSummary("<!-- amux-dream-summary:bad -->"),
    })],
    then: ["only bounded ordinary Markdown passes", (result) => {
      expect(result.valid.ok).toBe(true);
      expect(result.empty.reason).toBe("empty-summary");
      expect(result.tooMany.reason).toBe("summary-line-limit");
      expect(result.marker.reason).toBe("reserved-marker");
    }],
  });

  unit("the one daily block is replaced idempotently", {
    when: ["upserting twice", () => {
      const first = upsertDreamSummary("# 2026-07-21\n", "2026-07-21",
        "<!-- amux-dream-summary:2026-07-21 -->\nold\n<!-- /amux-dream-summary:2026-07-21 -->");
      return upsertDreamSummary(first, "2026-07-21",
        "<!-- amux-dream-summary:2026-07-21 -->\nnew\n<!-- /amux-dream-summary:2026-07-21 -->");
    }],
    then: ["only the new block remains", (memory) => {
      expect(memory).toContain("\nnew\n");
      expect(memory).not.toContain("\nold\n");
      expect(memory.match(/amux-dream-summary:2026-07-21/g)).toHaveLength(2);
    }],
  });
});
