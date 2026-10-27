import { unit, feature, expect } from "bdd-vitest";
import { dreamDeadlineMs, dreamWaitDeadlineMs } from "./dream-deadline.mjs";

feature("Dream wait deadline", () => {
  for (const [dateKey, utc] of [
    ["2026-09-05", "2026-09-05T10:00:00.000Z"],
    ["2026-12-05", "2026-12-05T11:00:00.000Z"],
    ["2026-03-29", "2026-03-29T10:00:00.000Z"],
    ["2026-10-25", "2026-10-25T11:00:00.000Z"],
  ]) unit(`${dateKey} ends at 12:00 Stockholm time`, {
    when: ["calculating the deadline", () => new Date(dreamDeadlineMs(dateKey)).toISOString()],
    then: ["it is local noon in summer and winter time, also on the switch days", result => expect(result).toBe(utc)],
  });

  unit("a catch-up run that starts after noon still waits 15 minutes", {
    given: ["a run starting at 14:00Z on a day whose noon was 10:00Z", () => Date.parse("2026-09-05T14:00:00Z")],
    when: ["calculating the wait deadline", start => dreamWaitDeadlineMs("2026-09-05", start) - start],
    then: ["the wait is 15 minutes", wait => expect(wait).toBe(15 * 60_000)],
  });

  unit("a night run at 02:00 waits until noon", {
    given: ["a run starting at 02:00Z", () => Date.parse("2026-09-05T02:00:00Z")],
    when: ["calculating the wait deadline", start => dreamWaitDeadlineMs("2026-09-05", start) - start],
    then: ["the wait is eight hours", wait => expect(wait).toBe(8 * 60 * 60_000)],
  });
});
