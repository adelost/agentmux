import { feature, unit, expect } from "bdd-vitest";
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

feature("bounded fleet dream input", () => {
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

  unit("native backend aliases never duplicate legacy filesystem journals", {
    when: ["collecting a native-configured alias", () => collectDreamSources(
      [{ name: "sky-native", backend: "native", dir: "/work", panes: [{ cmd: "claude" }] }],
      Date.parse("2026-07-21T08:00:00Z"),
      { readHistory: () => { throw new Error("must not read legacy aliases"); } },
    )],
    then: ["it is skipped explicitly until the runtime adapter contributes history", (result) => {
      expect(result.sources).toEqual([]);
      expect(result.unreadable).toEqual([]);
      expect(result.skipped).toEqual([{
        agent: "sky-native", pane: 0, reason: "native-history-adapter-required",
      }]);
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
      expect(Buffer.byteLength(batch.sourceText)).toBeLessThanOrEqual(96 * 1024);
      expect(batch.payload.panes).toHaveLength(1);
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

feature("Dream receipts never pass work the digest did not show", () => {
  const pane = [{ name: "skyvw", dir: "/work", panes: [{ cmd: "codex" }] }];
  const sinceMs = Date.parse("2026-09-15T02:00:00Z");
  const complete = (timestamp, userPrompt) => ({ ...turn(timestamp, userPrompt), isComplete: true });
  const minutes = (count) => count * 60_000;

  unit("a failed night's work reaches the next digest", {
    given: ["a receipt from before the failed night and work on both days", () => ({
      receipts: { schemaVersion: 1, panes: {
        "skyvw:0": { activityCursor: "2026-09-14T01:00:00Z", dreamedAt: "2026-09-14T02:00:00Z" },
      } },
      history: [
        complete("2026-09-14T10:00:00Z", "work during the failed night"),
        complete("2026-09-15T10:00:00Z", "work after it"),
      ],
    })],
    when: ["collecting the night after the failure", ({ receipts, history }) => {
      const asked = [];
      const result = collectDreamSources(pane, sinceMs, {
        receipts, now: Date.parse("2026-09-16T04:10:00Z"),
        readHistory: (_engine, _dir, options) => { asked.push(options.since.toISOString()); return { turns: history }; },
      });
      return { result, asked };
    }],
    then: ["the window starts at the receipt, not 24 hours back", ({ result, asked }) => {
      expect(asked).toEqual(["2026-09-14T01:00:00.000Z"]);
      expect(result.sources[0].entries.map((item) => item.userPrompt))
        .toEqual(["work during the failed night", "work after it"]);
    }],
  });

  unit("a busy pane shows its decisions and reports and counts the rest", {
    given: ["thirty finished turns, mostly background-task notifications", () => Array.from({ length: 30 }, (_, index) => {
      const at = new Date(sinceMs + minutes(10 * (index + 1))).toISOString();
      if (index === 2) return complete(at, "skyvw 0 ska ta över som orkestrerare");
      const notification = { ...complete(at, `<task-notification>\ntask ${index} finished`) };
      const report = index === 9 ? "SUMMARY: row 47 released in v0.5.1351" : `checked task ${index}`;
      return { ...notification, items: [{ type: "text", content: report }] };
    })],
    when: ["collecting", (history) => collectDreamSources(pane, sinceMs, {
      now: Date.parse("2026-09-16T04:10:00Z"), readHistory: () => ({ turns: history }),
    })],
    then: ["the human decision and the report stay, the oldest chatter is counted, the receipt passes all", ({ sources }) => {
      const [source] = sources;
      const shown = source.entries.map((item) => item.userPrompt);
      expect(shown).toHaveLength(24);
      expect(shown[0]).toBe("skyvw 0 ska ta över som orkestrerare");
      expect(shown).toContain("<task-notification>\ntask 9 finished");
      expect(shown).not.toContain("<task-notification>\ntask 0 finished");
      expect(source.omittedTurns).toBe(6);
      expect(source.activityCursor).toBe(new Date(sinceMs + minutes(300)).toISOString());
    }],
  });

  unit("a turn still running is left for the next night", {
    given: ["a finished turn and an open one", () => [
      complete("2026-09-16T03:00:00Z", "finished order"),
      turn("2026-09-16T04:05:54Z", "order just sent", ""),
    ]],
    when: ["collecting while the journal is fresh, and after it went quiet", (history) => {
      const now = Date.parse("2026-09-16T04:10:00Z");
      const collect = (lastWriteMs) => collectDreamSources(pane, sinceMs, {
        now, readHistory: () => ({ turns: history, lastWriteMs }),
      }).sources[0];
      return { fresh: collect(now - minutes(2)), quiet: collect(now - minutes(30)) };
    }],
    then: ["only a quiet journal lets the open turn be receipted", ({ fresh, quiet }) => {
      expect(fresh.entries.map((item) => item.userPrompt)).toEqual(["finished order"]);
      expect(fresh.activityCursor).toBe("2026-09-16T03:00:00Z");
      expect(fresh.deferredTurns).toBe(1);
      expect(quiet.entries).toHaveLength(2);
    }],
  });

  unit("a busy pane's outcomes stay readable within the fleet budget", {
    given: ["twenty-four turns with long final reports", () => {
      const entries = Array.from({ length: 24 }, (_, index) => turn(
        new Date(sinceMs + minutes(index + 1)).toISOString(), `[from skyvw:0] row ${index}`,
        `SUMMARY: row ${index} released. ${"evidence ".repeat(300)}`));
      return [{ ...source("skyvw", 5, sinceMs + minutes(24)), turns: 24, entries }];
    }],
    when: ["building the batch", (sources) => buildDreamBatch(sources, "2026-09-16")],
    then: ["each report keeps a useful share and the pane stays bounded", (batch) => {
      const [pane] = batch.payload.panes;
      expect(pane.turns).toHaveLength(24);
      for (const item of pane.turns) expect(Buffer.byteLength(item.assistant)).toBeGreaterThanOrEqual(300);
      expect(Buffer.byteLength(JSON.stringify(pane))).toBeLessThanOrEqual(16 * 1024);
      expect(Buffer.byteLength(batch.sourceText)).toBeLessThanOrEqual(96 * 1024);
    }],
  });
});
