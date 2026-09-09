import { expect, feature, unit } from "bdd-vitest";
import { it, vi } from "vitest";
import { latestConversationActivityMs } from "./pane-activity.mjs";

feature("pane conversation activity", () => {
  unit("an older real turn wins over a fresh housekeeping mtime", {
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
