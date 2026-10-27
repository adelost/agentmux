import { expect, feature, integration } from "bdd-vitest";
import { vi } from "vitest";
import { cmdStateAge, qualifyStateAge, stateAgeQueuedReceipts } from "./state-age.mjs";
import { watchStateAge } from "./state-age-watch.mjs";

feature("state-age historical calibration cannot send or activate incomplete evidence", () => {
  integration("durable job receipts recover unowned-row dedup after local state is lost", {
    given: ["an existing submitted dispatcher job and an unrelated CLI job", () => ({ list: () => [
      { source: "state-age", status: "submitted", idempotencyKey: "batch", metadata: { receiptKeys: ["batch", "state-age-unowned:cutkit:557a"] } },
      { source: "cli", metadata: { receiptKeys: ["unrelated"] } },
    ] })],
    when: ["recovering without changing queue state", queue => stateAgeQueuedReceipts(queue, [{ dispatcher: "lsrc:3" }])],
    then: ["the submitted alert remains reserved without a resend", keys => {
      expect([...keys]).toEqual(["batch", "state-age-unowned:cutkit:557a"]);
    }],
  });
  integration("watch is hourly, non-overlapping and never starts after a refused initial check", {
    given: ["a controllable clock and slow check", () => ({ interval: vi.fn(() => 42), check: vi.fn().mockResolvedValue({}) })],
    when: ["starting the watch", async f => ({ ...f, timer: await watchStateAge(f.check, { interval: f.interval }) })],
    then: ["it checks once and overlapping ticks cannot issue two checks", async f => {
      expect(f.timer).toBe(42); expect(f.check).toHaveBeenCalledTimes(1);
      expect(f.interval.mock.calls[0][1]).toBe(3600000);
      let finish; f.check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const tick = f.interval.mock.calls[0][0], waiting = tick(); await tick();
      expect(f.check).toHaveBeenCalledTimes(2); finish(); await waiting;
      const rejected = vi.fn();
      await expect(watchStateAge(() => Promise.reject(Error("unqualified")), { interval: rejected })).rejects.toThrow("unqualified");
      expect(rejected).not.toHaveBeenCalled();
    }],
  });
  integration("replay never creates a queue job and rejects --send", {
    given: ["one configured project and a replay boundary", () => ({
      projects: [{ id: "cutkit", root: "/not-read", ledger: "docs/TASKS.md", dispatcher: "lsrc:0" }],
      replay: vi.fn(() => ({ project: "cutkit", source: {}, days: { "2026-10-26": { messages: 1 } }, firstFlags: {}, paneHistoryAvailable: false })),
      queue: { enqueue: vi.fn() }, quiet: vi.spyOn(console, "log").mockImplementation(() => {}),
    })],
    when: ["running calibration", async f => ({ ...f, report: await cmdStateAge(["replay", "--project", "cutkit", "--since", "2026-10-24", "--until", "2026-10-27"], {}, f) })],
    then: ["it remains read-only and cannot qualify", async f => {
      expect(f.queue.enqueue).not.toHaveBeenCalled(); expect(f.report.eligible).toBe(false);
      expect(qualifyStateAge(f.report, f.projects[0])).toBe(false);
      await expect(cmdStateAge(["replay", "--project", "cutkit", "--since", "2026-10-24", "--until", "2026-10-27", "--send"], {}, f)).rejects.toThrow("never sends");
    }],
    cleanup: f => f.quiet.mockRestore(),
  });
});
