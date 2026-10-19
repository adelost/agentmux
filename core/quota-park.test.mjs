import { feature, unit, expect } from "bdd-vitest";
import { parkResumeDecision, quotaParkDecision } from "./quota-park.mjs";

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

// lsrc:0 2026-10-19: the parked Claude S panes should have resumed when the free reset gave the account room.
feature("when a parked pane resumes", () => {
  const parked = { window: "week", resetAt: Date.parse("2026-10-20T04:00:00Z"), parkedAt: "2026-10-19T19:53:00.000Z",
    account: { name: "Claude S" } };
  const at = Date.parse("2026-10-19T20:26:30Z");
  unit("room after the park resumes; a full week, a reading from before the park or a new turn does not", {
    when: ["four readings are decided", () => [
      parkResumeDecision({ park: parked, windows: [week(0)], observedAt: Date.parse("2026-10-19T20:26:28Z"), now: at }),
      parkResumeDecision({ park: parked, windows: [week(98)], observedAt: Date.parse("2026-10-19T20:26:28Z"), now: at }),
      parkResumeDecision({ park: parked, windows: [week(0)], observedAt: Date.parse("2026-10-19T19:40:00Z"), now: at }),
      parkResumeDecision({ park: parked, windows: [week(0)], observedAt: at, newTurn: "started a new turn since its park", now: at }),
    ]],
    then: ["resume, wait, wait, drop", decisions => expect(decisions.map(decision => decision.action))
      .toEqual(["resume", "wait", "wait", "drop"])],
  });
});
