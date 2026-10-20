import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { readCodexDreamEvents } from "./codex-dream-history.mjs";
import { answeredShare, conversationPaneTurns } from "./dream-conversation.mjs";
import { buildDreamBatch, collectDreamSources } from "./dream-summarizer.mjs";
import { dreamShadow } from "./dream-shadow.mjs";
import { appendAskLedger, appendPost } from "./ask-ledger.mjs";

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
  unit("new posted work whose input predates the cursor never needs a raw journal", {
    given: ["a genuine prior input and an actual answer after the cursor", () => ({ coverageStartMs: SINCE - 3600000,
      asks: [ask("old-input", 0, at(1), "mitt äldre uppdrag")], posts: [post(0, at(3), "reply", "SUMMARY: arbetet fortsatte efter markören")],
    })],
    when: ["collecting the new window with raw access forbidden", data => collectDreamSources(agents.slice(0, 1).map(agent => ({ ...agent, panes: [agent.panes[0]] })), Date.parse(at(2)), {
      now: NOW, conversation: { log: data }, readHistory: () => { throw Error("raw journal must not be needed"); },
    })],
    then: ["the actual post supplies work, with the prior input explicitly quoted for context", result => {
      expect(result.unreadable).toEqual([]); expect(result.sources).toHaveLength(1);
      expect(result.sources[0].source).toBe("conversation-log");
      expect(result.sources[0].entries[0].userPrompt).toContain("[amux posted continuation");
      expect(result.sources[0].entries[0].userPrompt).toContain("mitt äldre uppdrag");
      expect(result.sources[0].entries[0].timestamp).toBe(at(3));
    }],
  });
  component("nightly coverage uses the requested day, not the catch-up history", {
    given: ["an older input plus one answered input in this day", () => {
      const root = mkdtempSync(join(tmpdir(), "dream-shadow-day-")), path = join(root, "ledger.jsonl");
      const options = { path, now: () => NOW };
      appendPost({ ts: SINCE - 86400_000, agent: "lsrc", pane: 0, channelId: "c", via: "bridge", kind: "notice", payload: "started" }, options);
      appendAskLedger({ agent: "lsrc", pane: 0, source: "discord", ts: SINCE - 3_600_000, verbatim: "old input" }, options);
      appendAskLedger({ agent: "lsrc", pane: 0, source: "discord", ts: at(1), verbatim: "today input" }, options);
      appendPost({ agent: "lsrc", pane: 0, channelId: "c", via: "bridge", kind: "reply", ts: at(2), payload: "today reply" }, options);
      return { root, path };
    }],
    when: ["building the actual shadow report", fx => dreamShadow({ agents: [], sinceMs: SINCE, receipts: { panes: {} },
      readHistory: () => ({ turns: [] }), current: { batch: { sourceText: "", included: [], omitted: [] }, observed: { unreadable: [] } },
      dateKey: "2026-10-12", nowMs: NOW, logPath: fx.path })],
    then: ["only this day's human input enters the switch metric", report => expect(report.answered).toMatchObject({ asked: 1, answered: 1, share: 1 })],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  unit("a real task notification does not count as a human ask or separate the human from its answer", {
    given: ["a human input followed by a machine notification before its answer", () => ({ coverageStartMs: SINCE,
      asks: [ask("human", 0, at(1), "fixa det"), ask("notification", 0, at(1, 1), "<task-notification>\n<task-id>a1ca86742c4b24f37</task-id>\n<status>completed</status>\n</task-notification>", "pane-hook")],
      posts: [post(0, at(1, 2), "reply", "fixat")],
    })],
    when: ["measuring the actual input/output coverage", data => answeredShare(data, { nowMs: NOW })],
    then: ["the single human input has the posted answer", result => expect(result).toMatchObject({ asked: 1, answered: 1, share: 1 })],
  });
  unit("an engine-wrapped agent brief is not human, and a genuinely unanswered human remains counted", {
    given: ["a wrapped relay and one unanswered human", () => ({ coverageStartMs: SINCE,
      asks: [ask("relay", 0, at(1), '<pasted_content id="c93f">\n[from lsrc:0]\nSUMMARY: granska paret\n</pasted_content id="c93f">', "pane-hook"),
        ask("human", 0, at(2), "har du ett svar?")], posts: [],
    })],
    when: ["counting settled human input", data => answeredShare(data, { nowMs: NOW })],
    then: ["only the genuine human input is still unanswered", result => expect(result).toEqual({ asked: 1, answered: 0, share: 0, unanswered: { "lsrc:0": 1 } })],
  });
  unit("several human messages before one answer stay distinct inputs in one logical turn", {
    given: ["two exact human inputs that the pane answers together", () => ({ coverageStartMs: SINCE,
      asks: [ask("first", 0, at(1), "kolla loggen"), ask("addition", 0, at(1, 1), "och behåll reträtten")],
      posts: [post(0, at(1, 2), "reply", "logg och reträtt klara")],
    })],
    when: ["building turns and counting coverage", data => ({ turns: conversationPaneTurns(data.asks, data.posts), coverage: answeredShare(data, { nowMs: NOW }) })],
    then: ["both original asks are retained and one posted answer is not duplicated", ({ turns, coverage }) => {
      expect(coverage).toMatchObject({ asked: 2, answered: 2, share: 1 });
      expect(turns).toHaveLength(1);
      expect(turns[0].logIds).toEqual(["first", "addition"]);
      expect(turns[0].userPrompt).toBe("kolla loggen\n\noch behåll reträtten");
      expect(turns[0].items).toEqual([{ type: "text", content: "logg och reträtt klara" }]);
    }],
  });
  unit("a later agent reply cannot cover an earlier unanswered human request", {
    when: ["measuring distinct authors with an intervening relay", () => answeredShare({ coverageStartMs: SINCE,
      asks: [ask("human", 0, at(1), "min fråga"), ask("relay", 0, at(2), "[from skyvw:0] separat brief", "cli")],
      posts: [post(0, at(3), "reply", "briefen klar")],
    }, { nowMs: NOW })],
    then: ["the human gap remains visible instead of inflating coverage", result => expect(result).toMatchObject({ asked: 1, answered: 0 })],
  });
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

  unit("a log that started mid-window neither drops a pane nor its answers", {
    given: ["logging began at 04:00; lsrc:0 was asked at 03:00 and answered at 04:30, lsrc:1 answered with no ask in the log", () => ({
      coverageStartMs: Date.parse(at(2)),
      asks: [ask("e-1", 0, at(1), "Mattias: bygg paret")],
      posts: [post(0, at(2, 30), "reply", "SUMMARY: paret byggt"), post(1, at(3), "reply", "SUMMARY: utan fråga i loggen")],
    })],
    when: ["collecting the shadow with partial windows", (partial) => collectDreamSources(agents, SINCE, {
      receipts: { panes: {} }, now: NOW, conversation: { log: partial, partialWindow: true },
      readHistory: (_engine, dir) => ({ turns: [{ timestamp: at(2), userPrompt: `journal work in ${dir}`, isComplete: true,
        items: [{ type: "text", content: "done" }] }] }),
    })],
    then: ["both panes retain their actual posts; the missing input is explicit, not invented", ({ sources }) => {
      const byPane = Object.fromEntries(sources.map((item) => [`${item.agent}:${item.pane}`, item]));
      expect(byPane["lsrc:0"].source).toBe("conversation-log");
      expect(byPane["lsrc:0"].entries[0].items[0].content).toBe("SUMMARY: paret byggt");
      expect(byPane["lsrc:0"].historyComplete).toBe(false);
      expect(byPane["lsrc:1"].source).toBe("conversation-log");
      expect(byPane["lsrc:1"].entries[0].userPrompt).toContain("outside this log window");
      expect(byPane["lsrc:1"].entries[0].items[0].content).toBe("SUMMARY: utan fråga i loggen");
    }],
  });

  unit("answeredShare counts no amux notice or repeated prompt as his", {
    given: ["one answered ask of his, an amux notice typed into its pane, a 63-character prompt typed three times in a second pane, and one typed twice in a third", () => {
      const LOOP = "Fortsätt med nästa uppgift i kön och rapportera när den är klar";
      return { coverageStartMs: SINCE,
        asks: [
          ask("human", 0, at(1), "kolla loggen och rapportera"),
          ask("notice", 0, at(2), "[stall-watch] 1 mänskliga meddelanden till lsrc:1 saknar verifierat kvitto, äldsta 7 min.", "pane-hook"),
          ask("loop-1", 1, at(3), LOOP, "pane-hook"), ask("loop-2", 1, at(4), LOOP, "pane-hook"), ask("loop-3", 1, at(5), LOOP, "pane-hook"),
          ask("twice-1", 2, at(6), "Ta nästa punkt i listan och skriv klart.", "pane-hook"), ask("twice-2", 2, at(7), "Ta nästa punkt i listan och skriv klart.", "pane-hook"),
        ],
        posts: [post(0, at(1, 5), "reply", "loggen är läst")],
      };
    }],
    when: ["measuring the settled asks", (data) => answeredShare(data, { nowMs: NOW })],
    then: ["the notice and the three copies are not asks of his; the prompt typed twice is, and stays unanswered", (result) => {
      expect(result).toEqual({ asked: 3, answered: 1, share: 1 / 3, unanswered: { "lsrc:2": 2 } });
    }],
  });

  unit("answeredShare counts no pane-hook copy of an amux delivery as his", {
    given: ["one answered ask of his, and a self-compact delivery on a second pane with the pane's copy of it 4 seconds later", () => {
      const text = "Fortsätt där du slutade och dokumentera gränsen för autocompact";
      const copyAt = new Date(Date.parse(at(2)) + 4000).toISOString();
      return { coverageStartMs: SINCE,
        asks: [
          ask("human", 0, at(1), "kolla loggen och rapportera"),
          ask("compact", 1, at(2), text, "self-compact"), ask("compact-copy", 1, copyAt, text, "pane-hook"),
        ],
        posts: [post(0, at(1, 5), "reply", "loggen är läst")],
      };
    }],
    when: ["measuring the settled asks", (data) => answeredShare(data, { nowMs: NOW })],
    then: ["the copy is the delivery's: the only ask of his is the answered one", (result) => {
      expect(result).toEqual({ asked: 1, answered: 1, share: 1, unanswered: {} });
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
