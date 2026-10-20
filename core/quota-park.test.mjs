import { feature, unit, expect } from "bdd-vitest";
import { parkResumeDecision, quotaFloorHold, quotaFloorPercent, quotaParkContinuation, quotaParkDecision } from "./quota-park.mjs";

const NOW = Date.parse("2026-10-19T09:30:00Z");
const week = (usedPercent, resetsAt = "2026-10-25T18:08:00Z") => ({ kind: "week", usedPercent, resetsAt });

// 2026-10-19 09:2xZ: Codex W's week was spent with ten Codex panes stopped on it;
// parking them would only have sent ten compacts the account refuses.
feature("which stops a pane is parked for", () => {
  unit("a spent week has stopped its panes already, so nothing is parked", {
    when: ["Codex W reads 100 % with the reset six days away", () => quotaParkDecision({ engine: "codex", windows: [week(100)], now: NOW })],
    then: ["no park", decision => expect(decision).toEqual({ park: false, cell: "already-stopped" })],
  });
  unit("Claude's grace note still parks at a full window, since the compact runs within the grace", {
    when: ["the session reads 100 % at the grace note, the reset 3 h away", () => quotaParkDecision({ engine: "claude", graceNote: true,
      windows: [{ kind: "session", usedPercent: 100, resetsAt: "2026-10-19T12:30:00Z" }], now: NOW })],
    then: ["parked for the session window", decision => expect(decision).toMatchObject({ park: true, cell: "near-limit", window: "session" })],
  });
});

// 2026-10-20: the park at 3 % came 11 s before Claude S's session stopped its panes at 10:19:37Z. api:0, idle with a
// job running since 09:59Z, was never compacted and read 577k tokens cold at 11:11Z; claw:2 and ai:1 followed at 11:23Z.
feature("parking a pane while there is still time to compact it", () => {
  const at = Date.parse("2026-10-20T09:50:00Z");
  const session = (usedPercent, resetsAt = "2026-10-20T11:10:00Z") => ({ kind: "session", usedPercent, resetsAt });
  unit("a session forecast to run out within 20 minutes parks a working pane before 3 % is left", {
    when: ["Claude S has used 93 % of a session that opened 3 h 40 min ago", () => quotaParkDecision({ engine: "claude",
      windows: [session(93)], now: at })],
    then: ["parked for the session, with the 7 % it had left", decision => expect(decision)
      .toMatchObject({ park: true, cell: "near-limit", window: "session", leftPercent: 7 })],
  });
  unit("an idle pane's cache ages from its last activity, so a stop a working pane outlives parks an idle one", {
    when: ["3 % is left, the reset 45 min away; one pane works, one has been idle 20 min", () => {
      const windows = [session(97, new Date(at + 45 * 60_000).toISOString())];
      return [quotaParkDecision({ engine: "claude", windows, working: true, now: at }),
        quotaParkDecision({ engine: "claude", windows, working: false, lastActivityAt: at - 20 * 60_000, now: at })];
    }],
    then: ["the working pane keeps its warm cache, the idle one is parked", ([working, idle]) => {
      expect(working).toMatchObject({ park: false, cell: "cache-outlives-stop" });
      expect(idle).toMatchObject({ park: true, window: "session" });
    }],
  });
  unit("a grace note read before its window reset parks nothing in the new window", {
    when: ["skybar:1 at 11:10:11Z with its note of 10:19:37Z, the session just reset and the week at 38 %", () => quotaParkDecision({
      engine: "claude", graceNote: true, graceNoteAt: Date.parse("2026-10-20T10:19:37Z"), now: Date.parse("2026-10-20T11:10:11Z"),
      windows: [session(0, "2026-10-20T16:10:00Z"), { kind: "week", usedPercent: 38, resetsAt: "2026-10-27T04:00:00Z" }] })],
    then: ["no park, since the account has room", decision => expect(decision).toEqual({ park: false, cell: "room" })],
  });
  unit("the first 20 minutes of a window are no forecast", {
    when: ["a session 5 min old has used 25 %", () => quotaParkDecision({ engine: "claude", now: at,
      windows: [session(25, new Date(at + 295 * 60_000).toISOString())] })],
    then: ["no park", decision => expect(decision).toEqual({ park: false, cell: "room" })],
  });
});

// lsrc:0 2026-10-19: the parked Claude S panes should have resumed when the free reset gave the account room.
feature("when a parked pane resumes", () => {
  const parked = { window: "week", resetAt: Date.parse("2026-10-20T04:00:00Z"), parkedAt: "2026-10-19T19:53:00.000Z",
    account: { name: "Claude S" } };
  const at = Date.parse("2026-10-19T20:26:30Z");
  unit("room after the park resumes; a full week or a reading from before the park does not", {
    when: ["three readings are decided", () => [
      parkResumeDecision({ park: parked, windows: [week(0)], observedAt: Date.parse("2026-10-19T20:26:28Z"), now: at }),
      parkResumeDecision({ park: parked, windows: [week(98)], observedAt: Date.parse("2026-10-19T20:26:28Z"), now: at }),
      parkResumeDecision({ park: parked, windows: [week(0)], observedAt: Date.parse("2026-10-19T19:40:00Z"), now: at }),
    ]],
    then: ["resume, wait, wait", decisions => expect(decisions.map(decision => decision.action))
      .toEqual(["resume", "wait", "wait"])],
  });
  // lsrc:0 2026-10-20: left alone only when it works or has a queued message as room returns.
  unit("with room, a queued message or a later running turn leaves it alone; a finished one does not count", {
    when: ["four panes are decided at the same reading", () => {
      const decide = (activity) => parkResumeDecision({ park: parked, windows: [week(0)], observedAt: at, activity, now: at }).action;
      const notice = quotaParkContinuation({ window: "week", resetAt: parked.resetAt });
      let reads = 0;
      const unread = parkResumeDecision({ park: parked, windows: [week(98)], observedAt: at, now: at,
        activity: () => { reads += 1; return {}; } }).action;
      return { decided: [
        decide(() => ({ turn: { prompt: "[from skydive:0] Report", busy: false } })),
        decide(() => ({ queued: { source: "cli" } })),
        decide(() => ({ turn: { prompt: "[from claw:0] Review the Kit view next.", busy: true } })),
        decide(() => ({ turn: { prompt: notice, busy: true } })),
      ], unread, reads };
    }],
    then: ["resume, drop, drop, wait; without room the pane is not read", ({ decided, unread, reads }) => {
      expect(decided).toEqual(["resume", "drop", "drop", "wait"]);
      expect([unread, reads]).toEqual(["wait", 0]);
    }],
  });
  // A pane parked before its window ran low still works; the same 8 % is no room returning.
  unit("a pane parked with 8 % left resumes only once its window has more room than at the park", {
    when: ["a reading at 8 % left, then one of a fresh session", () => {
      const early = { window: "session", resetAt: Date.parse("2026-10-20T11:10:00Z"), parkedAt: "2026-10-20T09:55:00.000Z",
        leftPercent: 8, account: { name: "Claude S" } };
      const read = (usedPercent, resetsAt) => parkResumeDecision({ park: early, windows: [{ kind: "session", usedPercent, resetsAt }],
        observedAt: Date.parse("2026-10-20T10:01:00Z"), now: Date.parse("2026-10-20T10:01:30Z") }).action;
      return [read(92, "2026-10-20T11:10:00Z"), read(0, "2026-10-20T15:10:00Z")];
    }],
    then: ["wait, then resume", actions => expect(actions).toEqual(["wait", "resume"])],
  });
});

// lsrc:0 2026-10-19: a week is used until about 3 % is left; parking at 4 % stopped panes too early.
feature("the quota floor", () => {
  const reset = "2026-10-20T04:00:00Z";
  unit("the park waits for the floor: 4 % left keeps working, 3 % parks", {
    when: ["Claude S reads 96 % and 97 % with the reset 18 h away", () => [96, 97].map((used) =>
      quotaParkDecision({ engine: "claude", windows: [week(used, reset)], now: NOW }).park)],
    then: ["no park, then a park", parks => expect(parks).toEqual([false, true])],
  });
  unit("only a live week at or under the floor holds work; 0 turns the floor off", {
    when: ["four readings", () => [
      quotaFloorHold({ windows: [week(97, reset)], now: NOW }),
      quotaFloorHold({ windows: [week(96, reset)], now: NOW }),
      quotaFloorHold({ windows: [week(99, "2026-10-19T09:00:00Z")], now: NOW }),
      quotaFloorHold({ windows: [week(99, reset)], floorPercent: 0, now: NOW }),
    ]],
    then: ["held at 3 % left, open at 4 %, open after the reset, open when off", holds => expect(holds)
      .toEqual([{ leftPercent: 3, resetsAt: reset }, null, null, null])],
  });
  unit("the setting is a percent left on the week, 3 by default; a bad value is reported", {
    when: ["five environments", () => {
      const warnings = [];
      const read = (value) => quotaFloorPercent(value === undefined ? {} : { AMUX_QUOTA_FLOOR_PERCENT: value }, (line) => warnings.push(line));
      return { values: [read(undefined), read("2"), read("0"), read("abc"), read("150")], warnings };
    }],
    then: ["3, 2, 0, then the default twice with a warning each", ({ values, warnings }) => {
      expect(values).toEqual([3, 2, 0, 3, 3]);
      expect(warnings).toHaveLength(2);
    }],
  });
});
