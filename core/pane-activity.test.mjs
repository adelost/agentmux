import { expect, feature, unit } from "bdd-vitest";
import { it, vi } from "vitest";
import { latestConversationActivityMs } from "./pane-activity.mjs";

feature("pane conversation activity", () => {
  unit("idle time starts at the last reply", {
    when: ["a two-hour job has just finished", () => latestConversationActivityMs("/pane", "codex", {
      readers: { codex: () => ({ jsonlFile: "/session.jsonl", turns: [{
        timestamp: "2026-09-20T10:00:00Z", endTimestamp: "2026-09-20T12:00:00Z", isComplete: true,
      }] }) },
      stat: () => ({ size: 100, mtimeMs: Date.parse("2026-09-20T12:00:01Z") }),
    })],
    then: ["the end of the work starts the idle clock", value => expect(value).toBe(Date.parse("2026-09-20T12:00:00Z"))],
  });
  unit("housekeeping does not reset idle time", {
    given: ["one real turn and a freshly touched journal", () => ({
      readers: { claude: () => ({
        turns: [{ timestamp: "2026-07-20T10:00:00.000Z" }],
        jsonlFile: "/session.jsonl",
      }) },
      stat: () => ({ size: 100, mtimeMs: Date.parse("2026-07-22T10:00:00.000Z") }),
    })],
    when: ["reading activity", ({ readers, stat }) =>
      latestConversationActivityMs("/pane", "claude", { readers, stat })],
    then: ["the conversational timestamp is returned", (value) => {
      expect(value).toBe(Date.parse("2026-07-20T10:00:00.000Z"));
    }],
  });

  unit("a partial tail without a turn stays unknown", {
    given: ["a large journal whose bounded tails contain no turn", () => ({
      readers: { codex: () => ({ turns: [], jsonlFile: "/session.jsonl" }) },
      stat: () => ({ size: 20 * 1024 * 1024, mtimeMs: Date.now() }),
    })],
    when: ["reading activity", ({ readers, stat }) =>
      latestConversationActivityMs("/pane", "codex", { readers, stat })],
    then: ["mtime is not fabricated as activity", (value) => expect(value).toBeNull()],
  });
});

feature("claude activity inside one long turn", () => {
  // skydive:1 on 2026-09-26: a 240 MB journal whose last 1 MiB is one turn's
  // tool results, housekeeping records written later without timestamps.
  const tail = [
    { type: "user", timestamp: "2026-09-25T23:06:10.000Z", message: { content: [{ type: "tool_result" }] } },
    { type: "assistant", timestamp: "2026-09-25T23:07:28.000Z" },
    { type: "ai-title" }, { type: "mode" }, { type: "pr-link", timestamp: "2026-09-26T04:00:00.000Z" },
  ].map((record) => JSON.stringify(record)).join("\n");
  const options = {
    readers: { claude: () => ({ turns: [], jsonlFile: "/session.jsonl" }) },
    stat: () => ({ size: 240 * 1024 * 1024, mtimeMs: Date.parse("2026-09-26T04:00:00.000Z") }),
    readTail: () => ({ text: tail, reachedStart: false }),
  };

  unit("the last reply starts the idle clock when the turn's prompt is out of reach", {
    when: ["reading activity", () => latestConversationActivityMs("/pane", "claude", options)],
    then: ["the assistant record's time, not the housekeeping pr-link", (value) => {
      expect(value).toBe(Date.parse("2026-09-25T23:07:28.000Z"));
    }],
  });

  unit("a tail with only housekeeping stays unknown", {
    when: ["reading activity", () => latestConversationActivityMs("/pane", "claude", {
      ...options, readTail: () => ({ text: '{"type":"pr-link","timestamp":"2026-09-26T04:00:00.000Z"}', reachedStart: false }),
    })],
    then: ["no activity is fabricated", (value) => expect(value).toBeNull()],
  });
});

feature("cold nightly activity recovery", () => {
  function fixture() {
    const jsonlFile = "/session.jsonl";
    const stamp = { size: 20 * 1024 * 1024, mtimeMs: 99, ino: 1, dev: 1 };
    const reader = vi.fn((_pane, options) => ({ jsonlFile,
      turns: options.dreamHistory ? [{ timestamp: "2026-09-09T13:32:04.079Z" }] : [] }));
    return { readers: { codex: reader }, stat: vi.fn(() => stamp), reader, stamp };
  }

  it("recovers a real turn hidden behind compact records only on the explicit cold path", () => {
    const f = fixture();
    expect(latestConversationActivityMs("/pane", "codex", f)).toBeNull();
    expect(f.reader.mock.calls.some(([, options]) => options.dreamHistory)).toBe(false);
    expect(latestConversationActivityMs("/pane", "codex", { ...f, recoverCodexHistory: true }))
      .toBe(Date.parse("2026-09-09T13:32:04.079Z"));
    expect(f.reader.mock.calls.filter(([, options]) => options.dreamHistory)).toHaveLength(1);
  });

  it.each(["unreadable", "different-session", "changed-journal", "no-turn", "invalid-time"])
    ("keeps %s cold history unknown", (failure) => {
      const f = fixture();
      f.reader.mockImplementation((_pane, options) => {
        if (!options.dreamHistory) return { jsonlFile: "/session.jsonl", turns: [] };
        if (failure === "unreadable") throw new Error("dream-history-content-exhausted");
        if (failure === "changed-journal") f.stamp.size++;
        return { jsonlFile: failure === "different-session" ? "/new.jsonl" : "/session.jsonl",
          turns: failure === "no-turn" ? [] : [{ timestamp: failure === "invalid-time" ? "bad" : "2026-09-09T13:32:04.079Z" }] };
      });
      expect(latestConversationActivityMs("/pane", "codex", { ...f, recoverCodexHistory: true })).toBeNull();
    });

  it("keeps a recent recovered human turn recent instead of using the old receipt", () => {
    const f = fixture();
    f.reader.mockImplementation((_pane, options) => ({ jsonlFile: "/session.jsonl",
      turns: options.dreamHistory ? [{ timestamp: "2026-09-09T18:08:07.083Z" }] : [] }));
    expect(latestConversationActivityMs("/pane", "codex", { ...f, recoverCodexHistory: true }))
      .toBe(Date.parse("2026-09-09T18:08:07.083Z"));
  });
});
