import { feature, unit, expect } from "bdd-vitest";
import { blockedHandoffSender, deliveryBlockerDetail } from "./delivery-handoff.mjs";
import { reportStalledHead, stallWatcherOf } from "./queue-stall-watch.mjs";

// 2026-10-20 18:12Z: the quota floor held api:0's note to api:6 (Codex A's 5 h window spent), and the sender's stop
// notice said the pane's process could not be started, with advice to hand the work to another owner.
feature("the reason the sender of a held handoff reads", () => {
  unit("an evidence hold that clears quickly does not trigger a failed-start alarm", {
    when: ["two attempts at 50 seconds and a genuinely stalled hold at ten minutes", () => {
      const job = { agentName: "skyvw", pane: 0, source: "cli", kind: "prompt", status: "pending", attempts: 2,
        firstAttemptAt: 1_000, lastReason: "wake-refused:held-for-evidence:context-cost:unknown-evidence",
        metadata: { sender: "lsrc:7" } };
      return [blockedHandoffSender(job, 51_000), blockedHandoffSender(job, 601_000)];
    }],
    then: ["no premature alert, but a sustained hold reports to the sender", values => {
      expect(values[0]).toBeNull();
      expect(values[1]).toMatchObject({ key: "lsrc:7" });
    }],
  });
  unit("unknown context evidence does not claim the live pane failed to start", {
    when: ["an unsubmitted message is held for missing context evidence", () => deliveryBlockerDetail({
      lastReason: "wake-refused:held-for-evidence:context-cost:unknown-evidence",
    })],
    then: ["the actual evidence hold is explained", detail => expect(detail).toBe(
      "uppgifter om panelens kontext saknas; leveransen hålls tills de kan kontrolleras")],
  });
  unit("a quota hold names the account's state and says the job waits; a failed start reads as before", {
    when: ["the floor held a note to a Codex A pane, and a pane did not start", () => [
      deliveryBlockerDetail({ lastReason: "wake-refused:quota-floor: Codex A has spent its 5h window until 2026-10-20T22:15:37.000Z;"
        + " a turn now draws paid credits" }),
      deliveryBlockerDetail({ lastReason: "wake-refused:target CLI did not start" }),
    ]],
    then: ["the quota and the wait, then the start failure", details => expect(details).toEqual([
      "mottagarens kvot håller jobbet (Codex A has spent its 5h window until 2026-10-20T22:15:37.000Z; a turn now draws paid"
        + " credits); det levereras av sig självt när kontot har plats",
      "den adresserade agentprocessen kunde inte startas",
    ])],
  });
});

// sandman:0 for Mattias 12 Nov 2026: sandman:0's inbox stood still 07:58-09:36Z behind ce875ebc, a drafted head no sender alarm covered.
feature("a stalled queue head is told to the pane that watches it", () => {
  const fakeQueue = (jobs) => {
    const sent = [];
    return { sent, list: () => jobs, enqueue: (job) => { sent.push(job); return { id: `n${sent.length}` }; },
      update: (job, patch) => Object.assign(job, { metadata: { ...job.metadata, ...patch.metadata } }) };
  };
  const drafted = (createdAt) => ({ id: "ce875ebc434174e7", agentName: "sandman", pane: "0", status: "drafted", createdAt,
    lastReason: "awaiting exact JSONL receipt", metadata: {} });
  const watcherOf = (target) => (target === "sandman:0" ? { session: "deep", pane: 0, key: "deep:0" } : null);
  unit("after 10 min the watcher hears it once, the stalled pane never", {
    when: ["a drafted head at 9 and 11 min, and again a minute later", () => {
      const T0 = Date.parse("2026-11-12T07:58:23Z");
      const queue = fakeQueue([drafted(T0), { id: "b", status: "pending", metadata: {} }]);
      const at = (ms) => reportStalledHead({ agentName: "sandman", pane: "0", queue, now: () => T0 + ms, log: () => {}, watcherOf });
      return { results: [at(9 * 60_000), at(11 * 60_000), at(12 * 60_000)], queue };
    }],
    then: ["one notice to deep:0 naming the head, its state and the waiting count", ({ results, queue }) => {
      expect(results.map(Boolean)).toEqual([false, true, false]);
      expect(queue.sent).toHaveLength(1);
      expect(queue.sent[0]).toMatchObject({ agentName: "deep", pane: 0 });
      expect(queue.sent[0].text).toMatch(/sandman:0: 2 meddelanden väntar, huvudet ce875ebc har stått 11 min som drafted/u);
    }],
  });
  unit("a submitted turn the pane is working on is no stall", {
    when: ["the head was submitted 30 min ago", () => {
      const queue = fakeQueue([{ id: "s", status: "submitted", createdAt: 1_000, metadata: {} }]);
      return { result: reportStalledHead({ agentName: "sandman", pane: "0", queue, now: () => 1_000 + 30 * 60_000, log: () => {}, watcherOf }), queue };
    }],
    then: ["nobody is told", ({ result, queue }) => { expect(result).toBeNull(); expect(queue.sent).toEqual([]); }],
  });
  unit("a watcher is never the stalled pane itself", {
    when: ["the config names sandman:0 for sandman:0", () => stallWatcherOf("sandman:0", { read: () => ({ "sandman:0": "sandman:0", default: "deep:0" }) })],
    then: ["no watcher", (watcher) => { expect(watcher).toBeNull(); }],
  });
});
