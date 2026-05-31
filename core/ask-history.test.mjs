import { feature, unit, expect } from "bdd-vitest";
import {
  buildAskEntries,
  classifyAskTurn,
  filterAskEntries,
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

  unit("complete done-like reply is done", {
    when: ["classifying a complete done reply", () =>
      classifyAskTurn(turn({
        items: [tool("Bash npm test"), text("Fixat och pushat. Klart.")],
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
});
