import { expect, feature, unit } from "bdd-vitest";
import { planStateAge, stateAgeLimit, stateAgeWord } from "./state-age-guard.mjs";
import { stateAgeDigests } from "./state-age-digests.mjs";

const H = 3600000, now = Date.parse("2026-10-27T09:24:00Z");
feature("state-age v2 clocks, thresholds and bounded recipient digests", () => {
  unit("owned open work ages at2h/72h/never while unowned open always ages at24h", {
    given: ["owned and unowned rows at every priority", () => [
      { state: "open", owner: "claw:6", priority: "P0" },
      { state: "open", owner: "claw:6", priority: "P1" },
      { state: "open", owner: "claw:6", priority: "P2" },
      { state: "open", owner: "claw:6", priority: "P3" },
      { state: "open", owner: "lsrc:3 staffs", priority: "P2" },
      { state: "review", owner: "claw:6", priority: "P1" },
      { state: "blockerad", owner: "claw:6", priority: "P2" },
    ]],
    when: ["reading limits", rows => rows.map(row => stateAgeLimit(row) / H)],
    then: ["the v2 limits apply exactly", values => expect(values).toEqual([2, 72, Infinity, Infinity, 24, 24, 24])],
  });
  unit("notes and translated forms retain the same leading state", {
    given: ["two working notes, a review and Swedish state words", () => ["working: step1", "working: step2; DONE old step", "granskning: bild", "öppen: efter3", "blockerad av3", "working27Oct checkpoint"]],
    when: ["normalizing state words", states => states.map(stateAgeWord)],
    then: ["notes do not become states", values => expect(values).toEqual(["working", "working", "review", "open", "blocked", "working"])],
  });
  unit("one digest per recipient groups dependencies and caps owner details at five", {
    given: ["an overdue parent, its unowned child and six owned roots", () => ({ id: "cutkit", dispatcher: "lsrc:3", panes: [], rows: [
      { row: "533c", state: "working", title: "remove generations", owner: "claw:6", priority: "P1", changedAt: now - 48 * H },
      { row: "557a", state: "open: after533c", title: "local ingress", owner: "lsrc:3 staffs", priority: "P2", changedAt: now - 25 * H },
      ...Array.from({ length: 6 }, (_, i) => ({ row: String(600 + i), state: "working", title: "another task", owner: "claw:6", priority: "P1", changedAt: now - (30 + i) * H })),
    ] })],
    when: ["building recipient digests then repeating the tick", p => {
      const plan = planStateAge({ projects: [p], now }); const messages = stateAgeDigests(plan, [p]);
      return { messages, repeat: stateAgeDigests(plan, [p], new Set(messages.map(m => m.idempotencyKey))) };
    }],
    then: ["both recipients get one message and the waiting child is nested", ({ messages, repeat }) => {
      expect(messages).toHaveLength(2); expect(repeat).toEqual([]);
      expect(messages.find(m => m.target === "claw:6").text).toContain("och 2 till");
      expect(messages.find(m => m.target === "lsrc:3").text).toMatch(/↳.*557a/u);
    }],
  });
});
