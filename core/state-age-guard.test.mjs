import { expect, feature, unit } from "bdd-vitest";
import { planStateAge, stateAgeLimit, stateAgeOwners, reserveStateAgeMessages } from "./state-age-guard.mjs";

const H = 3600000, now = Date.parse("2026-10-27T09:24:00Z");
const row = (id, hours, extra = {}) => ({ row: id, title: "a task name", state: "open", priority: "P1", owner: "claw:6", changedAt: now - hours * H, ...extra });
const project = rows => ({ id: "cutkit", dispatcher: "lsrc:3", panes: ["claw:6", "lsrc:1"], rows });

feature("ledger age, pane liveness and registration alarms", () => {
  unit("uses2h/24h/72h and blocked24h, with daily row dedup", {
    given: ["rows on each side of the approved boundaries", () => [
      row("1", 2, { priority: "P0" }), row("2", 1.99, { priority: "P0" }),
      row("3", 24), row("4", 23.99), row("5", 72, { priority: "P2" }),
      row("6", 24, { priority: "P2", state: "BLOCKED by upstream" }),
      row("7", 100, { state: "Done27Oct" }), row("8", 24, { priority: "" }),
    ]],
    when: ["planning then repeating the same day", rows => {
      const first = planStateAge({ projects: [project(rows)], now });
      return { first, repeat: planStateAge({ projects: [project(rows)], now: now + H, seen: new Set(first.alarms.map(a => a.key)) }) };
    }],
    then: ["only due open rows notify their owner and dispatcher once", ({ first, repeat }) => {
      expect(first.alarms.map(a => a.row)).toEqual(["1", "3", "5", "6", "8"]);
      expect(first.messages).toHaveLength(10); expect(repeat.alarms.map(a => a.row)).toEqual(["2", "4"]);
    }],
  });
  unit("a staffing annotation is not an allocated owner", {
    given: ["an overdue unallocated row", () => row("557a", 24, { owner: "lsrc:3 staffs (skyvw:0 25 Oct)" })],
    when: ["planning", r => planStateAge({ projects: [project([r])], now })],
    then: ["only the dispatcher is addressed", plan => {
      expect(plan.messages.map(m => m.target)).toEqual(["lsrc:3"]); expect(plan.alarms[0].noOwner).toBe(true);
      expect(stateAgeOwners("lsrc:0 (owner); claw:6 (builder)")).toEqual(["lsrc:0", "claw:6"]);
      expect(stateAgeOwners("lsrc:5, updated07:2x")).toEqual(["lsrc:5"]);
    }],
  });
  unit("a working row flags an idle owner after2h even before its row-age limit", {
    given: ["a recently updated row whose named owner is idle", () => ({
      projects: [project([row("533c", 0.1, { state: "working; previous dependency is DONE" })])],
      panes: [{ key: "claw:6", status: "idle", idleSince: now - 2 * H }], now,
    })],
    when: ["planning", facts => planStateAge(facts)],
    then: ["it names the actual idle owner", plan => {
      expect(plan.alarms[0].reasons).toEqual(["owner-idle:claw:6"]); expect(plan.messages).toHaveLength(2);
    }],
  });
  unit("working outside a row is scoped, timed and sent only to the dispatcher", {
    given: ["one registered pane, one unregistered worker and one unrelated pane", () => ({
      projects: [project([row("1", 0.1, { state: "working" })])], panes: [
        { key: "claw:6", status: "working", workingSince: now - 2 * H },
        { key: "lsrc:1", status: "working", workingSince: now - H },
        { key: "api:8", status: "working", workingSince: now - H },
      ], now,
    })],
    when: ["planning", facts => planStateAge(facts)],
    then: ["only the scoped unregistered worker is flagged", plan => {
      expect(plan.alarms.map(a => a.pane)).toEqual(["lsrc:1"]); expect(plan.messages.map(m => m.target)).toEqual(["lsrc:3"]);
    }],
  });
  unit("unknown clocks remain unknown rather than authorizing an alarm", {
    given: ["missing row and working clocks", () => ({ projects: [project([row("1", 0, { changedAt: null })])],
      panes: [{ key: "lsrc:1", status: "working", workingSince: null }], now })],
    when: ["planning", facts => planStateAge(facts)],
    then: ["the missing evidence is explicit", plan => { expect(plan.alarms).toEqual([]); expect(plan.unknownClocks).toHaveLength(2); }],
  });
  unit("blocked overrides P2 rather than lengthening it", {
    given: ["a P2 blocked row", () => row("1", 24, { priority: "P2", state: "BLOCKED" })],
    when: ["reading its limit", r => stateAgeLimit(r)],
    then: ["the limit stays24h", ms => expect(ms).toBe(24 * H)],
  });
  unit("ambiguous open duplicate IDs remain explicit while closed archive entries do not interfere", {
    given: ["two open duplicates and one open row with a closed archive copy", () => [
      row("1", 48, { line: 10 }), row("1", 48, { line: 11 }),
      row("2", 48), row("2", 48, { state: "Done" }),
    ]],
    when: ["planning", rows => planStateAge({ projects: [project(rows)], now })],
    then: ["only the unambiguous row routes an alarm", result => {
      expect(result.alarms.map(a => a.row)).toEqual(["2"]);
      expect(result.unknownClocks).toContainEqual({ project: "cutkit", row: "1", kind: "duplicate-row", lines: [10, 11] });
    }],
  });
  unit("daily message reservations survive repeated ticks and refuse the tenth recipient effect", {
    given: ["nine durable recipient identities", () => ({ day: "2026-10-27", messages: Array.from({ length: 9 }, (_, i) => ({ idempotencyKey: String(i) })) })],
    when: ["reserving twice then adding another identity", plan => {
      const first = reserveStateAgeMessages(plan);
      return { first, repeat: reserveStateAgeMessages(plan, first), overflow: () => reserveStateAgeMessages({ ...plan, messages: [{ idempotencyKey: "tenth" }] }, first) };
    }],
    then: ["repeats do not consume another slot and the tenth is refused", ({ first, repeat, overflow }) => {
      expect(repeat).toEqual(first); expect(Object.keys(first)).toHaveLength(9); expect(overflow).toThrow("reach10");
    }],
  });
});
