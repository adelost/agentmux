import { describe, it, expect } from "vitest";
import { planQuotaStopMirror } from "./watcher-quota-stop.mjs";

const stop = "You've hit your weekly limit · resets Oct 21, 9am (Europe/Stockholm)";
const turn = (id, content, at = 1) => ({ taskNotification: true, endTimestamp: new Date(at * 1000).toISOString(), items: [{ id, type: "text", content }] });
describe("watcher quota episode delivery", () => {
  it("acknowledges repeated quota items without mirroring the same stop after background completions", () => {
    const first = planQuotaStopMirror(turn("first", stop));
    expect(first.turn.items).toHaveLength(1);
    const repeated = planQuotaStopMirror(turn("new-background-item", stop, 2), first.next);
    expect(repeated.turn.items).toEqual([]);
    expect(repeated.next.text).toBe(stop);
  });
  it("keeps real replies and errors and allows a stop after productive recovery", () => {
    const first = planQuotaStopMirror(turn("first", stop));
    const real = planQuotaStopMirror(turn("reply", "Build failed: missing file", 2), first.next);
    expect(real.turn.items[0].content).toBe("Build failed: missing file");
    expect(planQuotaStopMirror(turn("next-stop", stop, 3), real.next).turn.items).toHaveLength(1);
  });
  it("delivers the necessary error for a new human request even during the same quota stop", () => {
    const first = planQuotaStopMirror(turn("first", stop));
    const next = { ...turn("human-stop", stop, 2), taskNotification: false };
    expect(planQuotaStopMirror(next, first.next).turn.items[0].id).toBe("human-stop");
  });
  it("keeps changed reset notices and item receipts intact", () => {
    const first = planQuotaStopMirror(turn("first", stop));
    const changed = planQuotaStopMirror(turn("new-window", stop.replace("Oct 21", "Oct 28"), 2), first.next);
    expect(changed.turn.items[0].id).toBe("new-window");
  });
});
