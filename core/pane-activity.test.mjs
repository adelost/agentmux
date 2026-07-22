import { expect, feature, unit } from "bdd-vitest";
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
