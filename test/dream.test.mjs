import { feature, unit, expect } from "bdd-vitest";
import {
  buildDreamSection,
  defaultDailyContent,
  upsertDreamSection,
} from "../core/dream.mjs";

const NOW = new Date("2026-05-10T02:00:00.000Z");
const SINCE = Date.parse("2026-05-09T02:00:00.000Z");

feature("amux dream digest", () => {
  unit("skips when activity is below the threshold", {
    given: ["one user row and minTurns=2", () => ({
      rows: [
        { timestamp: "2026-05-09T12:00:00.000Z", agent: "claw", pane: 0, role: "user", type: "text", content: "ping" },
      ],
    })],
    when: ["building the section", ({ rows }) => buildDreamSection({
      dateKey: "2026-05-10",
      rows,
      commits: [],
      sinceMs: SINCE,
      now: NOW,
      minTurns: 2,
    })],
    then: ["no section is produced", (result) => {
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain("threshold 2");
    }],
  });

  unit("builds a pane and commit summary", {
    given: ["two panes and one commit", () => ({
      rows: [
        { timestamp: "2026-05-09T12:00:00.000Z", agent: "claw", pane: 0, role: "user", type: "text", content: "fix dream" },
        { timestamp: "2026-05-09T12:01:00.000Z", agent: "claw", pane: 0, role: "assistant", type: "text", content: "done" },
        { timestamp: "2026-05-09T13:00:00.000Z", agent: "ai", pane: 4, role: "user", type: "text", content: "status" },
        { timestamp: "2026-05-09T13:01:00.000Z", agent: "ai", pane: 4, role: "assistant", type: "text", content: "ready" },
      ],
      commits: [{ label: "agentmux", hash: "abcdef123456", subject: "feat: add dream" }],
    })],
    when: ["building with minTurns=2", ({ rows, commits }) => buildDreamSection({
      dateKey: "2026-05-10",
      rows,
      commits,
      sinceMs: SINCE,
      now: NOW,
      minTurns: 2,
    })],
    then: ["the section contains both panes and the commit", (result) => {
      expect(result.skipped).toBe(false);
      expect(result.section).toContain("<!-- amux-dream:2026-05-10 -->");
      expect(result.section).toContain("`ai:4`");
      expect(result.section).toContain("`claw:0`");
      expect(result.section).toContain("abcdef1");
    }],
  });

  unit("replaces an existing daily dream section", {
    given: ["a daily file with an old dream section", () => {
      const oldSection = [
        "<!-- amux-dream:2026-05-10 -->",
        "old",
        "<!-- /amux-dream:2026-05-10 -->",
      ].join("\n");
      return `${defaultDailyContent("2026-05-10")}\n${oldSection}\n`;
    }],
    when: ["upserting a new section", (content) => upsertDreamSection(
      content,
      "2026-05-10",
      "<!-- amux-dream:2026-05-10 -->\nnew\n<!-- /amux-dream:2026-05-10 -->\n",
    )],
    then: ["old content is gone and new content is present", (result) => {
      expect(result).not.toContain("\nold\n");
      expect(result).toContain("\nnew\n");
      expect(result.match(/amux-dream:2026-05-10/g)).toHaveLength(2);
    }],
  });

  unit("creates lint-compliant daily file header", {
    when: ["creating default daily content", () => defaultDailyContent("2026-05-10")],
    then: ["template and summary header are present", (result) => {
      expect(result).toContain("<!-- template: daily -->");
      expect(result).toContain("> summary: Daily notes for 2026-05-10, auto-created by amux dream.");
      expect(result).toContain("> why: Session continuity and nightly agent activity digest.");
    }],
  });
});
