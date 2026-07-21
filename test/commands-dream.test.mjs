import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectDreamTargets,
  hasDreamPaneBlock,
  isDreamLiveClaudePane,
  isDreamRunnableStatus,
  validateDreamPaneBlock,
  waitForDreamPaneBlock,
} from "../cli/commands.mjs";

feature("amux dream command target selection", () => {
  unit("only runnable panes are exactly idle", {
    when: ["checking statuses", () => ({
      idle: isDreamRunnableStatus("idle"),
      working: isDreamRunnableStatus("working"),
      unknown: isDreamRunnableStatus("unknown"),
      permission: isDreamRunnableStatus("permission"),
    })],
    then: ["only idle is accepted", (result) => {
      expect(result).toEqual({
        idle: true,
        working: false,
        unknown: false,
        permission: false,
      });
    }],
  });

  unit("only live claude processes are dream-sendable", {
    when: ["checking live pane commands", () => ({
      claude: isDreamLiveClaudePane({ command: "claude" }),
      bash: isDreamLiveClaudePane({ command: "bash" }),
      missing: isDreamLiveClaudePane(null),
    })],
    then: ["only live claude is accepted", (result) => {
      expect(result).toEqual({
        claude: true,
        bash: false,
        missing: false,
      });
    }],
  });

  unit("collects only recent idle live-Claude panes and reports skipped active/stale panes", {
    given: ["mixed panes with recent activity", () => {
      const agents = [
        {
          name: "claw",
          dir: "/workspace/claw",
          panes: [
            { cmd: "claude" },
            { cmd: "claude --dangerously-skip-permissions" },
            { cmd: "codex resume --last" },
            { cmd: "claude" },
            { cmd: "claude --continue" },
          ],
        },
      ];
      const mtimes = new Map([
        ["/workspace/claw/.agents/0", 2_000],
        ["/workspace/claw/.agents/1", 2_100],
        ["/workspace/claw/.agents/2", 2_200],
        ["/workspace/claw/.agents/3", 900],
        ["/workspace/claw/.agents/4", 2_300],
      ]);
      const statuses = new Map([
        ["claw:0", "idle"],
        ["claw:1", "working"],
        ["claw:3", "idle"],
        ["claw:4", "idle"],
      ]);
      const livePanes = [
        { index: 0, command: "claude" },
        { index: 1, command: "claude" },
        { index: 2, command: "node" },
        { index: 3, command: "claude" },
        { index: 4, command: "bash" },
      ];
      return { agents, mtimes, statuses, livePanes };
    }],
    when: ["collecting dream targets since t=1000", ({ agents, mtimes, statuses, livePanes }) =>
      collectDreamTargets({}, agents, 1_000, {
        getMtime: (dir) => mtimes.get(dir) || 0,
        getStatus: async (_ctx, agent, pane) => statuses.get(`${agent}:${pane}`) || "unknown",
        getLivePanes: async () => livePanes,
        getTurns: () => ({ count: 20, latest: "2026-07-21T05:00:00.000Z" }),
        getContext: () => ({ percent: 72 }),
      })],
    then: ["only the recent idle Claude pane is targeted", (result) => {
      expect(result.targets).toEqual([
        {
          agent: "claw", pane: 0, lastMs: 2_000, turns: 20,
          activityCursor: "2026-07-21T05:00:00.000Z", receiptDateKey: null,
          status: "idle", liveCommand: "claude", contextPercent: 72, compact: true,
        },
      ]);
      expect(result.skipped).toEqual([
        {
          agent: "claw", pane: 1, lastMs: 2_100, turns: 20,
          activityCursor: "2026-07-21T05:00:00.000Z", receiptDateKey: null,
          status: "working", liveCommand: "claude",
        },
        {
          agent: "claw", pane: 4, lastMs: 2_300, turns: 20,
          activityCursor: "2026-07-21T05:00:00.000Z", receiptDateKey: null,
          status: "not-live-claude", liveCommand: "bash",
        },
      ]);
      expect(result.ineligible).toEqual([]);
    }],
  });

  unit("detects a completed per-pane dream marker block", {
    given: ["daily memory content with one pane block", () => [
      "# 2026-05-13",
      "<!-- amux-dream-ai-0:2026-05-13 -->",
      "## ai:0",
      "- Summary",
      "<!-- /amux-dream-ai-0:2026-05-13 -->",
    ].join("\n")],
    when: ["checking the marker pair", (content) => ({
      complete: hasDreamPaneBlock(content, { agent: "ai", pane: 0 }, "2026-05-13"),
      missingEnd: hasDreamPaneBlock(content.replace("<!-- /amux-dream-ai-0:2026-05-13 -->", ""), { agent: "ai", pane: 0 }, "2026-05-13"),
      wrongPane: hasDreamPaneBlock(content, { agent: "ai", pane: 1 }, "2026-05-13"),
    })],
    then: ["only the complete matching block passes", (result) => {
      expect(result).toEqual({
        complete: true,
        missingEnd: false,
        wrongPane: false,
      });
    }],
  });

  unit("dream blocks over the 10-line budget are visible but remain complete", {
    given: ["a marker block with 11 non-empty body lines", () => [
      "<!-- amux-dream-ai-0:2026-05-13 -->",
      ...Array.from({ length: 11 }, (_, i) => `- line ${i}`),
      "<!-- /amux-dream-ai-0:2026-05-13 -->",
    ].join("\n")],
    when: ["validating", (content) => validateDreamPaneBlock(
      content, { agent: "ai", pane: 0 }, "2026-05-13", 10,
    )],
    then: ["validation warns with the measured line count", (result) => {
      expect(result).toMatchObject({ ok: false, lines: 11 });
      expect(result.reason).toContain("budget 10");
    }],
  });

  unit("waits briefly for a delayed dream marker block to appear", {
    when: ["polling a file that is initially empty", async () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-dream-"));
      const memPath = join(dir, "2026-05-13.md");
      writeFileSync(memPath, "# 2026-05-13\n");
      setTimeout(() => {
        writeFileSync(memPath, [
          "# 2026-05-13",
          "<!-- amux-dream-ai-0:2026-05-13 -->",
          "## ai:0",
          "- Summary",
          "<!-- /amux-dream-ai-0:2026-05-13 -->",
          "",
        ].join("\n"));
      }, 50);
      return waitForDreamPaneBlock(memPath, { agent: "ai", pane: 0 }, "2026-05-13", 500, 25);
    }],
    then: ["the delayed block is accepted", (result) => {
      expect(result).toBe(true);
    }],
  });
});
