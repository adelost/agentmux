import { readFileSync } from "node:fs";
import { feature, unit, expect } from "bdd-vitest";
import { replayWindDownStop } from "../bin/replay-quota-wind-down.mjs";

const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/quota-wind-down-20261020.json", import.meta.url), "utf8"));

feature("quota wind-down historical replay (unit)", () => {
  for (const stop of fixture.stops) {
    unit(`matches the independent pane facts at ${stop.stop}`, {
      given: ["estimated five-minute readings and measured turn ends from design v2", () => stop],
      when: ["running the real stage and benefit decisions with a two-minute compact", replayWindDownStop],
      then: ["exactly the independently expected panes compact", result => {
        expect(result.compacted).toEqual(stop.expectedCompacted);
        for (const decision of result.decisions) expect(decision.pays, decision.pane).toBe(stop.panes[decision.pane].compactPays);
      }],
    });
  }
});
