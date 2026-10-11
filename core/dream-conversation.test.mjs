import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { readCodexDreamEvents } from "./codex-dream-history.mjs";
import { answeredShare } from "./dream-conversation.mjs";
import { buildDreamBatch, collectDreamSources } from "./dream-summarizer.mjs";

const SINCE = Date.parse("2026-10-11T02:00:00Z");
const NOW = Date.parse("2026-10-12T02:00:00Z");
const at = (hours, minutes = 0) => new Date(SINCE + hours * 3_600_000 + minutes * 60_000).toISOString();
const ask = (id, pane, ts, verbatim, source = "discord") => ({ id, event: "ask", agent: "lsrc", pane, ts, verbatim, source });
const post = (pane, ts, kind, text, files = []) => ({ event: "post", agent: "lsrc", pane, ts, kind, text, files });
const REPORT = `SUMMARY: G4 släppt i v0.5.1400. ${"bevis ".repeat(80)}`.trim();
const agents = [{ name: "lsrc", dir: "/work", panes: [{ cmd: "codex" }, { cmd: "claude" }] }];

// lsrc:0 posts its answers to Discord; lsrc:1 has no channel posts.
const log = {
  coverageStartMs: SINCE - 3_600_000,
  asks: [
    ask("a-1", 0, at(1), "Mattias: släpp G4 idag"),
    ask("a-2", 0, at(3), "[dream] sammanfatta natten", "dream"),
    ask("a-3", 0, at(5), "[from skyvw:0] granska paret", "cli"),
  ],
  posts: [
    post(0, at(1, 30), "reply", REPORT),
    post(0, at(1, 31), "file", "", ["/tmp/g4.png"]),
    post(0, at(1, 32), "notice", "_context: 40%_"),
    post(0, at(3, 5), "reply", "DREAM_OK 2026-10-11 run"),
    post(0, at(5), "mirror", "[from skyvw:0] granska paret"),
    post(0, at(5, 20), "reply", "SUMMARY: paret granskat, 2 fynd"),
  ],
};

feature("Dream reads the conversation log before any journal", () => {
  unit("a pane that posted is built from the log without opening its journal", {
    given: ["lsrc:0 posted its answers, lsrc:1 only has a journal", () => ({
      readHistory: vi.fn((_engine, dir) => {
        if (dir.endsWith("/.agents/0")) throw new Error("journal opened for a pane that posted");
        return { turns: [{ timestamp: at(2), userPrompt: "lsrc 1 journal work", isComplete: true,
          items: [{ type: "text", content: "done from the journal" }] }] };
      }),
    })],
    when: ["collecting and packing", ({ readHistory }) => {
      const observed = collectDreamSources(agents, SINCE, { receipts: { panes: {} }, readHistory, now: NOW, conversation: { log } });
      return { observed, batch: buildDreamBatch(observed.sources, "2026-10-12"), readHistory };
    }],
    then: ["lsrc:0 comes from the log with its answers, lsrc:1 from its journal, Dream's own run is left out", ({ observed, batch, readHistory }) => {
      expect(readHistory.mock.calls.map(([, dir]) => dir)).toEqual(["/work/.agents/1"]);
      expect(observed.unreadable).toEqual([]);
      const bySource = Object.fromEntries(observed.sources.map((item) => [`${item.agent}:${item.pane}`, item.source]));
      expect(bySource).toEqual({ "lsrc:0": "conversation-log", "lsrc:1": "journal" });
      const pane = batch.payload.panes.find((item) => item.pane === "lsrc:0");
      expect(pane.turns.map((turn) => turn.user)).toEqual(["Mattias: släpp G4 idag", "[from skyvw:0] granska paret"]);
      expect(pane.turns[0].assistant).toBe(`${REPORT}\n[file: /tmp/g4.png]`);
      expect(pane.turns[1].assistant).toBe("SUMMARY: paret granskat, 2 fynd");
      expect(batch.sourceText).not.toMatch(/DREAM_OK|_context: 40%_/u);
    }],
  });

  component("a 6 MB tool output in a journal cannot touch Dream when the pane posted", {
    given: ["lsrc:0's Codex journal holds one 6 MB command output", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-conversation-"));
      const journal = join(root, "rollout.jsonl");
      writeFileSync(journal, [
        JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: "s-1", cwd: "/work/.agents/0" } }),
        JSON.stringify({ timestamp: at(1, 10), type: "event_msg", payload: { type: "exec_command_end", aggregated_output: "x".repeat(6 * 1024 * 1024) } }),
      ].join("\n") + "\n");
      const readHistory = (_engine, dir) => {
        if (dir.endsWith("/.agents/0")) readCodexDreamEvents(journal);
        return { turns: [] };
      };
      return { root, readHistory };
    }],
    when: ["collecting and packing", ({ readHistory }) => {
      const observed = collectDreamSources(agents, SINCE, { receipts: { panes: {} }, readHistory, now: NOW, conversation: { log } });
      return { observed, batch: buildDreamBatch(observed.sources, "2026-10-12") };
    }],
    then: ["the pane is summarized from its posts and the packet stays small", ({ observed, batch }, { root }) => {
      try {
        expect(observed.unreadable).toEqual([]);
        expect(batch.included.map((item) => `${item.agent}:${item.pane}`)).toEqual(["lsrc:0"]);
        expect(Buffer.byteLength(batch.sourceText)).toBeLessThan(8 * 1024);
        expect(batch.sourceText).not.toContain("xxxxxxxx");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });

  unit("the shadow counts settled human asks that got an answer posted", {
    given: ["three discord asks on lsrc:1, one answered, one too recent, plus an unanswered cli brief", () => ({
      coverageStartMs: SINCE,
      asks: [
        ask("h-1", 1, at(1), "fixa felet"),
        ask("h-2", 1, at(2), "och nästa", "pane-hook"),
        ask("b-1", 1, at(3), "[from skyvw:0] brief", "cli"),
        ask("h-3", 1, at(23, 55), "en till"),
      ],
      posts: [post(1, at(1, 10), "reply", "SUMMARY: fixat"), post(1, at(2, 1), "notice", "levererat")],
    })],
    when: ["measuring at 02:00", (shadowLog) => answeredShare(shadowLog, { nowMs: NOW })],
    then: ["one of the two settled human asks is answered", (share) => {
      expect(share).toEqual({ asked: 2, answered: 1, share: 0.5, unanswered: { "lsrc:1": 1 } });
    }],
  });
});
