import { expect, feature, unit } from "bdd-vitest";
import { planStateAge } from "./state-age-guard.mjs";
import { stateAgeDigests } from "./state-age-digests.mjs";

const H = 3600000, start = Date.parse("2026-10-26T13:24:00Z");
const receipts = messages => messages.flatMap(message => message.receiptKeys || [message.idempotencyKey]);
feature("newly overdue unowned rows bypass the already sent daily digest", () => {
  unit("one same-tick dispatcher message carries all newly overdue unowned rows, once each", {
    given: ["a daily digest already sent before two unowned rows reach24h", () => ({ id: "cutkit", dispatcher: "lsrc:3", panes: [], rows: [
      { row: "533c", title: "remove generations", state: "working", priority: "P1", owner: "claw:6", changedAt: start - 48 * H },
      ...["557a", "557b"].map(row => ({ row, title: "local ingress", state: "open: after533c", priority: "P2", owner: "lsrc:3 staffs", changedAt: start - 23 * H })),
    ] })],
    when: ["checking before and at the threshold, then again", project => {
      const first = stateAgeDigests(planStateAge({ projects: [project], now: start }), [project]);
      const seen = new Set(receipts(first));
      const secondPlan = planStateAge({ projects: [project], now: start + H });
      const urgent = stateAgeDigests(secondPlan, [project], seen);
      receipts(urgent).forEach(key => seen.add(key));
      return { first, urgent, repeat: stateAgeDigests(secondPlan, [project], seen),
        nextDay: stateAgeDigests(planStateAge({ projects: [project], now: start + 24 * H }), [project], seen) };
    }],
    then: ["the unowned rows are named immediately and cannot create another unowned alert", result => {
      expect(result.first).toHaveLength(2); expect(result.urgent).toHaveLength(1);
      expect(result.urgent[0].target).toBe("lsrc:3");
      expect(result.urgent[0].mentioned.map(row => row.row)).toEqual(expect.arrayContaining(["557a", "557b"]));
      expect(result.urgent[0].text).toMatch(/↳.*557a/u);
      expect(result.repeat).toEqual([]);
      expect(result.nextDay.flatMap(message => message.unownedReceiptKeys || [])).toEqual([]);
    }],
  });
});
