import { feature, unit, expect } from "bdd-vitest";
import { blockedHandoffSender, deliveryBlockerDetail } from "./delivery-handoff.mjs";
import { reportStalledHead, stallWatcherOf } from "./queue-stall-watch.mjs";
import { pushWaitVerdict, pollPushWaitOnce } from "./push-wait-watch.mjs";

feature("push wait watch", () => {
  const t = Date.parse("2026-11-15T15:00:00Z");
  const commits = (late, total = 9) => Array.from({ length: total }, (_, i) => ({ sha: `${i}`, subject: `code ${i}`,
    authorMs: t - (i < late ? 40 : 10) * 60_000, committerMs: t, files: ["src/main.js"] }));
  unit("counts only code and requires both thresholds", {
    when: ["four, two, and a docs-only late commit", () => [
      pushWaitVerdict([...commits(4), { ...commits(1, 1)[0], files: ["docs/TASKS.md", "README.md"] }], t),
      pushWaitVerdict(commits(2), t), pushWaitVerdict(commits(2, 2), t),
    ]],
    then: ["only four of nine raises an alarm", ([yes, no, small]) => {
      expect(yes).toMatchObject({ on: true, landed: 9 }); expect(yes.late).toHaveLength(4);
      expect(no.on).toBe(false); expect(small.on).toBe(false);
    }],
  });
  unit("alarms once, repeats only to the pane, and opens a new episode after 30 quiet minutes", {
    when: ["polling an episode and its recovery", async () => {
      let state = {}, clock = t, rows = commits(4); const sent = [], notified = [];
      const poll = () => pollPushWaitOnce({ repos: ["cut"], readCommits: async () => rows,
        readState: () => state, writeState: value => { state = structuredClone(value); },
        send: async (...args) => { sent.push(args); return { sent: true }; },
        notify: async (...args) => { notified.push(args); return { sent: true }; }, now: () => clock });
      await poll(); clock += 10 * 60_000; await poll(); clock += 50 * 60_000; await poll();
      rows = []; clock += 10 * 60_000; await poll(); clock += 30 * 60_000; await poll();
      rows = commits(4).map(c => ({ ...c, committerMs: clock, authorMs: clock - 40 * 60_000 }));
      clock += 60_000; await poll(); return { sent, notified };
    }],
    then: ["three pane notices and two human notices", ({ sent, notified }) => {
      expect(sent).toHaveLength(3); expect(notified).toHaveLength(2);
    }],
  });
  unit("a failed git read neither changes state nor sends", {
    when: ["fetch fails", async () => {
      const before = { cut: { episode: "old" } }, writes = [], sends = [];
      await pollPushWaitOnce({ repos: ["cut"], readCommits: async () => { throw Error("fetch failed"); },
        readState: () => before, writeState: x => writes.push(x), send: x => sends.push(x),
        notify: x => sends.push(x), now: () => t, log: () => {} }); return { writes, sends };
    }],
    then: ["nothing changes", ({ writes, sends }) => { expect(writes).toEqual([]); expect(sends).toEqual([]); }],
  });
  unit("caps human alerts at three per UTC day while retaining the unlanded count", {
    when: ["a fourth episode starts", async () => {
      let state = { cut: { humanAlerts: { day: "2026-11-15", count: 3 } } }; const sent = [], notified = [];
      await pollPushWaitOnce({ repos: ["cut"], readCommits: async () => commits(4), readUnlanded: async () => 7,
        readState: () => state, writeState: value => { state = structuredClone(value); },
        send: async (...args) => { sent.push(args); return { sent: true }; },
        notify: async (...args) => { notified.push(args); return { sent: true }; }, now: () => t });
      return { state, sent, notified };
    }],
    then: ["the pane hears it, the human does not, and the gap is recorded", ({ state, sent, notified }) => {
      expect(sent).toHaveLength(1); expect(notified).toHaveLength(0); expect(state.cut.unlanded).toBe(7);
    }],
  });
});

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
  // 12 Nov (Mattias via deep:0): the sender heard "när kontot har plats" with the 14 Nov reset while the pane could move at once.
  unit("a quota hold whose pane moves names the account it moves to, not the old account's reset", {
    when: ["the floor held a note while the stop mover has Claude W for the pane", () => deliveryBlockerDetail({
      lastReason: "wake-refused:quota-floor: Claude E has 2 % of its week left (floor 3 %) until 2026-11-14T23:00:00Z; moving to Claude W" })],
    then: ["the move and the account", detail => expect(detail).toBe("panelen flyttas till Claude W; meddelandet följer med och levereras där")],
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
