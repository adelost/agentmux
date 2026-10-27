import { component, expect, feature, unit } from "bdd-vitest";
import { createSpentWindows, overlaySpentWindows } from "./codex-spent-windows.mjs";

// The account snapshot is read at most every 15 minutes; a running turn's own journal shows a spent window with the next
// model call. The floor and the credit hold must see that reading at once (claw:5, 27 Oct 2026, 07:56:59Z).
const NOW = Date.parse("2026-10-27T08:10:00Z");
const RESETS = Date.parse("2026-10-27T12:30:00Z");
const facts = (key = "codex:1") => ({ account: { name: "Codex A", key, provider: "codex" }, observedAt: NOW - 600_000,
  windows: [{ kind: "session", usedPercent: 97, resetsAt: new Date(RESETS).toISOString() }, { kind: "week", usedPercent: 72, resetsAt: "2026-11-02T10:00:00.000Z" }] });
const spent = () => { const store = createSpentWindows(); store.record("claw:5", { accountKey: "codex:1", window: "session", resetsAt: RESETS }); return store; };

feature("a spent window seen in a turn's journal overrides an older account snapshot", () => {
  component("the 5 h window reads 100 % on the account the pane still runs on", {
    given: ["a snapshot at 97 % and a recorded spent session on codex:1", () => ({ base: facts(), store: spent() })],
    when: ["overlaying", ({ base, store }) => overlaySpentWindows(base, store.forPane("claw:5"), NOW)],
    then: ["session 100 % with the same reset, week untouched", merged => {
      expect(merged.windows).toEqual([{ kind: "session", usedPercent: 100, resetsAt: new Date(RESETS).toISOString() },
        { kind: "week", usedPercent: 72, resetsAt: "2026-11-02T10:00:00.000Z" }]);
    }],
  });
  unit("a pane that now runs on another account is judged by that account", {
    given: ["the record is for codex:1, the pane now reads codex:2", () => ({ base: facts("codex:2"), store: spent() })],
    when: ["overlaying", ({ base, store }) => overlaySpentWindows(base, store.forPane("claw:5"), NOW)],
    then: ["the snapshot is unchanged", (merged, { base }) => expect(merged).toEqual(base)],
  });
  unit("a record whose reset has passed is dropped", {
    given: ["the same record read after the reset", () => ({ base: facts(), store: spent() })],
    when: ["overlaying at 12:31Z", ({ base, store }) => overlaySpentWindows(base, store.forPane("claw:5"), RESETS + 60_000)],
    then: ["the snapshot is unchanged", (merged, { base }) => expect(merged).toEqual(base)],
  });
  unit("an unavailable or missing reading stays as it was", {
    given: ["no facts", () => spent()],
    when: ["overlaying", store => [overlaySpentWindows(null, store.forPane("claw:5"), NOW), overlaySpentWindows({ unavailable: true }, store.forPane("claw:5"), NOW)]],
    then: ["both unchanged", merged => expect(merged).toEqual([null, { unavailable: true }])],
  });
  unit("recording the same window again keeps one record", {
    given: ["two records of the same stop", () => { const store = spent(); store.record("claw:5", { accountKey: "codex:1", window: "session", resetsAt: RESETS }); return store; }],
    when: ["listing the pane's records", store => store.forPane("claw:5")],
    then: ["one", records => expect(records).toHaveLength(1)],
  });
});
