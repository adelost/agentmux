import { feature, unit, expect } from "bdd-vitest";
import { quotaParkDecision } from "./quota-park.mjs";

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
