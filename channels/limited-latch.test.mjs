import { feature, unit, expect } from "bdd-vitest";
import { nextLimitedMemory, clearsLimitedLatch, enteredLimited } from "./auto-compact.mjs";

/** One poll cycle: remember, then ask whether this reading alerts. */
const poll = (prev, status) => ({
  alerts: enteredLimited(prev, status),
  remembered: nextLimitedMemory(prev, status),
});

feature("A quota banner that scrolls out of the pane tail", () => {
  unit("does not re-announce a stall when a delivery pushes the banner out of view", {
    given: ["a pane already remembered as limited", () => "limited"],
    when: ["a delivery redraws the tail, then the banner re-prints", (prev) => {
      const flap = poll(prev, "unknown");
      return poll(flap.remembered, "limited");
    }],
    then: ["the second reading is not a new edge", (result) => expect(result.alerts).toBe(false)],
  });

  unit("holds the latch through idle, which is absence of evidence, not recovery", {
    given: ["a pane already remembered as limited", () => "limited"],
    when: ["one poll reads it as idle", (prev) => nextLimitedMemory(prev, "idle")],
    then: ["it is still remembered as limited", (state) => expect(state).toBe("limited")],
  });

  unit("releases the latch when the pane is demonstrably running again", {
    given: ["a pane already remembered as limited", () => "limited"],
    when: ["a real turn is observed", (prev) => nextLimitedMemory(prev, "working")],
    then: ["the memory follows the pane out of the stall", (state) => expect(state).toBe("working")],
  });

  unit("alerts on a genuinely new stall after the pane had recovered", {
    given: ["a pane that ran again after its last limit", () => nextLimitedMemory("limited", "working")],
    when: ["it hits the quota once more", (prev) => poll(prev, "limited")],
    then: ["this one is news and is announced", (result) => expect(result.alerts).toBe(true)],
  });

  unit("still announces the first stall a bridge ever sees", {
    given: ["no memory for the pane at all", () => undefined],
    when: ["the first observation is limited", (prev) => poll(prev, "limited")],
    then: ["a cold bridge does not go quiet about a live stall", (result) => expect(result.alerts).toBe(true)],
  });

  unit("names only a running pane as proof of recovery", {
    given: ["the statuses a poll can return", () => ["working", "idle", "unknown", "limited"]],
    when: ["each is asked whether it clears the latch", (all) => all.filter(clearsLimitedLatch)],
    then: ["only working does", (clearing) => expect(clearing).toEqual(["working"])],
  });
});
