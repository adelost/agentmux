import { feature, unit, expect } from "bdd-vitest";
import { seedLimitedFromLedger, enteredLimited } from "./auto-compact.mjs";

const ledger = (rows) => () => rows;

feature("Re-announcing a quota stall across a bridge restart", () => {
  unit("stays quiet about a pane that was already limited before the restart", {
    given: ["a ledger whose newest row for the pane is its limited entry", () => seedLimitedFromLedger(
      new Map(),
      { readEventsFn: ledger([{ session: "skyvw", pane: 3, event: "limited" }]) },
    )],
    when: ["the poller sees it limited again", (prev) => enteredLimited(prev.get("skyvw:3"), "limited")],
    then: ["no fresh alert fires", (alerts) => expect(alerts).toBe(false)],
  });

  unit("still alerts when the pane ran again and then stalled anew", {
    given: ["a limited row followed by a real turn", () => seedLimitedFromLedger(
      new Map(),
      { readEventsFn: ledger([
        { session: "skyvw", pane: 3, event: "limited" },
        { session: "skyvw", pane: 3, event: "prompt" },
      ]) },
    )],
    when: ["the poller sees it limited again", (prev) => enteredLimited(prev.get("skyvw:3"), "limited")],
    then: ["the new stall is announced, because this one is news", (alerts) => expect(alerts).toBe(true)],
  });

  unit("stays quiet when only queued traffic followed the stall", {
    given: ["a limited row buried under delivery rows addressed to a silent pane", () => seedLimitedFromLedger(
      new Map(),
      { readEventsFn: ledger([
        { session: "skydive", pane: 3, event: "limited" },
        { session: "skydive", pane: 3, event: "delivery_queue" },
        { session: "skydive", pane: 3, event: "notification" },
        { session: "skydive", pane: 3, event: "delivery_queue" },
      ]) },
    )],
    when: ["the poller sees it limited again after a restart", (prev) => enteredLimited(prev.get("skydive:3"), "limited")],
    then: ["a quota-dead pane collecting mail is not a pane that recovered",
      (alerts) => expect(alerts).toBe(false)],
  });

  unit("leaves a pane that never hit a limit alone", {
    given: ["a ledger with only ordinary turns", () => seedLimitedFromLedger(
      new Map(),
      { readEventsFn: ledger([{ session: "lsrc", pane: 2, event: "stop" }]) },
    )],
    when: ["reading back what was seeded", (prev) => prev.get("lsrc:2")],
    then: ["nothing was seeded for it", (state) => expect(state).toBeUndefined()],
  });

  unit("survives an unreadable ledger instead of taking the bridge down", {
    given: ["a reader that throws", () => seedLimitedFromLedger(
      new Map([["skyvw:4", "limited"]]),
      { readEventsFn: () => { throw new Error("events.jsonl is gone"); } },
    )],
    when: ["reading back what was seeded", (prev) => prev.get("skyvw:4")],
    then: ["the caller's map is returned untouched", (state) => expect(state).toBe("limited")],
  });
});
