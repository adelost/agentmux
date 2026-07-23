import { feature, unit, expect } from "bdd-vitest";
import {
  askAnchorKey,
  attachAskLineAnchors,
  buildAskEntries,
  classifyAskTurn,
  filterAskEntries,
  joinAskLedgerEntries,
  summarizeAskEntries,
} from "./ask-history.mjs";

const turn = (overrides = {}) => ({
  timestamp: "2026-05-31T07:00:00.000Z",
  userPrompt: "fix the bridge",
  items: [],
  isComplete: false,
  ...overrides,
});

const text = (content) => ({ type: "text", content });
const tool = (content) => ({ type: "tool", content });

feature("ask-history: classifyAskTurn", () => {
  unit("user prompt without assistant content stays open", {
    when: ["classifying a no-reply turn", () => classifyAskTurn(turn())],
    then: ["it is open", (status) => expect(status).toBe("open")],
  });

  unit("latest incomplete turn in a working pane is working", {
    when: ["classifying a live incomplete turn", () =>
      classifyAskTurn(turn({ items: [text("halfway")] }), { isLatest: true, paneStatus: "working" })],
    then: ["it is working", (status) => expect(status).toBe("working")],
  });

  unit("assistant question is needs-you", {
    when: ["classifying a reply that asks for confirmation", () =>
      classifyAskTurn(turn({
        items: [text("Vill du att jag mergar detta?")],
        isComplete: true,
      }))],
    then: ["it is needs-you", (status) => expect(status).toBe("needs-you")],
  });

  unit("a question answering an inter-agent envelope is answered, not needs-you (SRC-0053 A)", {
    when: ["classifying a broker-thread reply that asks a generic question", () =>
      classifyAskTurn(turn({
        userPrompt: "[from lsrc:2]\n\nreview-kön åldras — disponera PR #24/#27",
        items: [text("Båda är rebasade. Vill du att jag mergar direkt?")],
        isComplete: true,
      }))],
    then: ["it is answered (the ball is lsrc:2's, not the human's)", (status) =>
      expect(status).toBe("answered")],
  });

  unit("complete done-like reply is done", {
    when: ["classifying a complete done reply", () =>
      classifyAskTurn(turn({
        items: [tool("Bash npm test"), text("Fixat och pushat. Klart.")],
        isComplete: true,
      }))],
    then: ["it is done", (status) => expect(status).toBe("done")],
  });

  unit("complete done-like reply wins over optional follow-up question", {
    when: ["classifying a done reply with a trailing optional question", () =>
      classifyAskTurn(turn({
        items: [text("Klart, planen är skriven och pushad. Vill du att jag går vidare med nästa?")],
        isComplete: true,
      }))],
    then: ["it is done, not needs-you", (status) => expect(status).toBe("done")],
  });

  unit("done-like reply is done even when stop_reason is missing", {
    when: ["classifying an old incomplete jsonl turn whose text says it is done", () =>
      classifyAskTurn(turn({
        items: [text("Alla milestones är klara och pushade.")],
        isComplete: false,
      }), { isLatest: false, paneStatus: "idle" })],
    then: ["it is done", (status) => expect(status).toBe("done")],
  });

  unit("done-like first block wins over a trailing optional question block", {
    when: ["classifying split assistant text", () =>
      classifyAskTurn(turn({
        items: [
          text("Ja, alla milestones är klara och pushade."),
          text("Vill du att jag tar nästa polish också?"),
        ],
        isComplete: true,
      }))],
    then: ["it is done", (status) => expect(status).toBe("done")],
  });
});

feature("ask-history: build and filter entries", () => {
  unit("entries carry pane, jsonl, preview, reply, and open flag", {
    given: ["two turns from one pane", () => ({
      turns: [
        turn({ userPrompt: "first task", items: [text("done")], isComplete: true }),
        turn({ timestamp: "2026-05-31T07:10:00.000Z", userPrompt: "second task", items: [] }),
      ],
    })],
    when: ["building ask entries", ({ turns }) => buildAskEntries({
      agent: "claw",
      pane: 2,
      turns,
      jsonlFile: "/tmp/session.jsonl",
      nowMs: Date.parse("2026-05-31T07:15:00.000Z"),
    })],
    then: ["the newest no-reply entry is marked open with jsonl location", (entries) => {
      expect(entries).toHaveLength(2);
      expect(entries[1]).toMatchObject({
        key: "claw:2",
        prompt: "second task",
        status: "open",
        open: true,
        jsonlFile: "/tmp/session.jsonl",
      });
    }],
  });

  unit("system-noise prompts never become ask entries (SRC-0053)", {
    given: ["a real ask surrounded by machine plumbing", () => ({
      turns: [
        turn({ userPrompt: "<command-name>/compact</command-name>", items: [] }),
        turn({ userPrompt: "This session is being continued from a previous conversation that ran out of context.", items: [] }),
        turn({ timestamp: "2026-07-15T08:10:00.000Z", userPrompt: "granska PR #22", items: [] }),
      ],
    })],
    when: ["building ask entries", ({ turns }) => buildAskEntries({
      agent: "lsrc", pane: 2, turns,
      nowMs: Date.parse("2026-07-15T08:15:00.000Z"),
    })],
    then: ["only the human ask survives", (entries) => {
      expect(entries).toHaveLength(1);
      expect(entries[0].prompt).toBe("granska PR #22");
    }],
  });

  unit("filterAskEntries supports openOnly, grep, since, and limit", {
    given: ["mixed entries", () => [
      { prompt: "alpha", reply: "", open: true, tsMs: 10 },
      { prompt: "beta", reply: "done", open: false, tsMs: 20 },
      { prompt: "gamma deploy", reply: "", open: true, tsMs: 30 },
    ]],
    when: ["filtering", (entries) => filterAskEntries(entries, {
      openOnly: true,
      grep: /deploy/,
      sinceMs: 15,
      limit: 1,
    })],
    then: ["only the matching open entry remains", (entries) => {
      expect(entries.map((e) => e.prompt)).toEqual(["gamma deploy"]);
    }],
  });

  unit("humanOnly removes inter-agent directives without hiding operator asks", {
    given: ["one human ask and one agent brief", () => [
      { prompt: "fixa NPC:erna", origin: "human", open: true, tsMs: 20 },
      { prompt: "[from skydive:2] deploya", origin: "agent", open: true, tsMs: 10 },
    ]],
    when: ["filtering the default human view", (entries) =>
      filterAskEntries(entries, { humanOnly: true, openOnly: true })],
    then: ["only the user's ask remains", (entries) =>
      expect(entries.map((entry) => entry.prompt)).toEqual(["fixa NPC:erna"])],
  });

  unit("attachAskLineAnchors adds jsonl line numbers by timestamp + prompt", {
    given: ["one ask entry and a line map", () => {
      const entry = {
        timestamp: "2026-05-31T07:10:00.000Z",
        prompt: "second task",
      };
      const anchors = new Map([[askAnchorKey(entry.timestamp, entry.prompt), 42]]);
      return { entry, anchors };
    }],
    when: ["attaching anchors", ({ entry, anchors }) => attachAskLineAnchors([entry], anchors)],
    then: ["the entry gets its jsonl line", (entries) => {
      expect(entries[0].jsonlLine).toBe(42);
    }],
  });
});

feature("ask-history: durable ledger join", () => {
  unit("live provider history enriches the durable ask instead of duplicating it", {
    given: ["one ledger row and its answered live turn", () => ({
      ledgerEntries: [{
        id: "ask-1", ts: "2026-07-22T10:00:00.000Z",
        agent: "skyvw", pane: 4, verbatim: "granska arkitekturen",
        sessionFile: "/sessions/live.jsonl", repo: "skydive-altimeter",
        ledgerPath: "/home/u/.agentmux/ask-ledger.jsonl",
      }],
      liveEntries: [{
        agent: "skyvw", pane: 4, prompt: "granska arkitekturen",
        timestamp: "2026-07-22T10:00:03.000Z", tsMs: Date.parse("2026-07-22T10:00:03Z"),
        reply: "Klart.", replyPreview: "Klart.", status: "done", open: false,
        jsonlFile: "/sessions/live.jsonl",
      }],
    })],
    when: ["joining ledger identity with live status", (input) => joinAskLedgerEntries({
      ...input, nowMs: Date.parse("2026-07-22T10:05:00Z"),
    })],
    then: ["one durable row carries the live result", (rows) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ledgerId: "ask-1", status: "done", reply: "Klart.",
        repo: "skydive-altimeter", jsonlFile: "/sessions/live.jsonl",
      });
    }],
  });

  unit("a missing provider session is shown honestly as unverified and unresolved", {
    when: ["joining an orphaned durable row", () => joinAskLedgerEntries({
      ledgerEntries: [{
        id: "ask-dead", ts: "2026-07-21T10:00:00.000Z",
        agent: "skyvw", pane: 0, verbatim: "flytta in klockan i soluret",
        sessionFile: "/deleted/session.jsonl", source: "pane-hook",
      }],
      liveEntries: [], nowMs: Date.parse("2026-07-22T10:00:00Z"),
    })],
    then: ["the ask remains in --open candidates with its dead pointer", (rows) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "unverified", open: true,
        sessionFile: "/deleted/session.jsonl", jsonlFile: null,
        prompt: "flytta in klockan i soluret",
        origin: "human",
      });
    }],
  });

  unit("legacy live-only asks survive migration and summaries group every repo", {
    given: ["one unverified ledger ask plus one old live-only ask", () => joinAskLedgerEntries({
      ledgerEntries: [{
        id: "a", ts: "2026-07-22T09:00:00Z", agent: "lsrc", pane: 3,
        verbatim: "arkiverad", repo: "agentmux",
      }],
      liveEntries: [{
        agent: "skyvw", pane: 4, prompt: "pågående", status: "working", open: true,
        tsMs: Date.parse("2026-07-22T10:00:00Z"), timestamp: "2026-07-22T10:00:00Z",
      }],
    })],
    when: ["summarizing all repositories", (rows) => summarizeAskEntries(rows)],
    then: ["both repos and their honest states are counted", (summary) => {
      expect(summary).toEqual([
        expect.objectContaining({ repo: "skyvw", total: 1, open: 1, unverified: 0 }),
        expect.objectContaining({ repo: "agentmux", total: 1, open: 1, unverified: 1 }),
      ]);
    }],
  });
});
