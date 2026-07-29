// Stale delivery guard: the lsrc:3 incident shape, warning without rewriting.

import { expect, feature, component } from "bdd-vitest";
import { staleDeliveryJobDecision, reportStaleDeliveryJobs, runDeliveryPreflight } from "./delivery-stale.mjs";

const NOW = 3_600_000;
const job = (over = {}) => ({
  id: "j1",
  status: "pending",
  createdAt: 0,
  lastAttemptAt: 0,
  ...over,
});

feature("staleDeliveryJobDecision: loud only for physical stages past the bound", () => {
  component("the incident shape and the untouched cases", {
    given: ["one of each stage and age", () => ({
      pastingStuck: job({ status: "pasting", lastAttemptAt: NOW - 33 * 60_000 }),
      pastingFresh: job({ status: "pasting", lastAttemptAt: NOW - 5 * 60_000 }),
      pendingParked: job({ status: "pending", lastAttemptAt: NOW - 500 * 60_000 }),
      submittedAncient: job({ status: "submitted", lastAttemptAt: NOW - 500 * 60_000 }),
      acknowledged: job({ status: "acknowledged", lastAttemptAt: NOW - 500 * 60_000 }),
      untimed: job({ status: "pasting", createdAt: 0, lastAttemptAt: null }),
    })],
    when: ["judging each", (jobs) => Object.fromEntries(
      Object.entries(jobs).map(([key, value]) => [key, staleDeliveryJobDecision(value, NOW)]),
    )],
    then: ["only a stuck physical stage is stale, everything else is quiet", (r) => {
      expect(r.pastingStuck.stale).toBe(true);
      expect(r.pastingStuck.reason).toContain("stale-pasting");
      expect(r.pastingFresh.stale).toBe(false);
      expect(r.pendingParked.stale).toBe(false);
      expect(r.submittedAncient.stale).toBe(false);
      expect(r.acknowledged.stale).toBe(false);
      expect(r.untimed.stale).toBe(false);
    }],
  });
});

feature("reportStaleDeliveryJobs: visible warning, no rewrite, exactly once per job", () => {
  component("a stuck paste warns loudly and stays recoverable", {
    given: ["a queue with one stuck and one fresh job", () => {
      const events = [];
      const logs = [];
      const updates = [];
      const stuck = job({ id: "stuck", status: "pasting", lastAttemptAt: NOW - 33 * 60_000 });
      const queue = {
        list: () => [stuck, job({ id: "fresh", status: "pasting", lastAttemptAt: NOW - 2 * 60_000 })],
        update: (target, patch) => { updates.push({ id: target.id, patch }); return Object.assign(target, patch); },
      };
      return {
        queue,
        events,
        logs,
        updates,
        run: () => reportStaleDeliveryJobs({
          agentName: "lsrc", pane: 3, queue, now: () => NOW,
          queueEvent: (job, kind, meta) => events.push({ id: job.id, kind, meta }),
          log: (line) => logs.push(line),
        }),
      };
    }],
    when: ["reporting twice", async (fx) => ({
      first: await fx.run(),
      second: await fx.run(),
      updates: fx.updates,
      events: fx.events,
      logs: fx.logs,
    })],
    then: ["one warning, zero status rewrites, the job is never re-flagged", (r) => {
      expect(r.first).toEqual(["stuck"]);
      expect(r.second).toEqual([]);
      expect(r.events).toEqual([{ id: "stuck", kind: "stale-warning", meta: { reason: expect.stringContaining("stale-pasting") } }]);
      expect(r.logs).toHaveLength(1);
      expect(r.updates[0].patch.status).toBeUndefined(); // no terminal rewrite
      expect(r.updates[0].patch.staleNoticeSentAt).toBe(NOW);
    }],
  });
});

feature("runDeliveryPreflight: one ordered pass", () => {
  component("cancellation, notices, and stale reporting all run before delivery", {
    given: ["one of each pre-delivery item", () => {
      const order = [];
      const queue = {
        list: () => [job({ id: "stale", status: "pasting", lastAttemptAt: NOW - 40 * 60_000 })],
        update: (target, patch) => ({ ...target, ...patch }),
        pendingCancellationRequests: () => ["cancel-req-1"],
        pendingTerminalNotices: () => [{ id: "notice-1", unverifiedNoticeNextAttemptAt: 0 }],
      };
      return {
        queue,
        order,
        run: () => runDeliveryPreflight({
          agentName: "lsrc", pane: 3, queue, now: () => NOW,
          queueEvent: (job, kind) => order.push(`event:${job.id}:${kind}`),
          log: () => {},
          terminalizeNotSent: async (request) => { order.push(`terminalize:${request}`); },
          notifyTerminal: async (notice) => { order.push(`notify:${notice.id}`); },
        }),
      };
    }],
    when: ["running preflight", (fx) => fx.run().then((reported) => ({ reported, order: fx.order }))],
    then: ["all three paths fire in order, stale as warning only", (r) => {
      expect(r.reported).toEqual(["stale"]);
      expect(r.order).toEqual(["terminalize:cancel-req-1", "notify:notice-1", "event:stale:stale-warning"]);
    }],
  });
});
