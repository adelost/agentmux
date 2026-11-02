import { feature, unit, expect } from "bdd-vitest";
import { blockedHandoffSender, deliveryBlockerDetail } from "./delivery-handoff.mjs";

// 2026-10-20 18:12Z: the quota floor held api:0's note to api:6 (Codex A's 5 h window spent), and the sender's stop
// notice said the pane's process could not be started, with advice to hand the work to another owner.
feature("the reason the sender of a held handoff reads", () => {
  unit("an evidence hold that clears quickly does not trigger a failed-start alarm", {
    when: ["two attempts at 50 seconds and a genuinely stalled hold at ten minutes", () => {
      const job = { agentName: "skyvw", pane: 0, source: "cli", kind: "prompt", status: "pending", attempts: 2,
        firstAttemptAt: 1_000, lastReason: "wake-refused:held-for-evidence:context-cost:unknown-evidence",
        metadata: { sender: "lsrc:7" } };
      return [blockedHandoffSender(job, 51_000), blockedHandoffSender(job, 601_000)];
    }],
    then: ["no premature alert, but a sustained hold reports to the sender", values => {
      expect(values[0]).toBeNull();
      expect(values[1]).toMatchObject({ key: "lsrc:7" });
    }],
  });
  unit("unknown context evidence does not claim the live pane failed to start", {
    when: ["an unsubmitted message is held for missing context evidence", () => deliveryBlockerDetail({
      lastReason: "wake-refused:held-for-evidence:context-cost:unknown-evidence",
    })],
    then: ["the actual evidence hold is explained", detail => expect(detail).toBe(
      "uppgifter om panelens kontext saknas; leveransen hålls tills de kan kontrolleras")],
  });
  unit("a quota hold names the account's state and says the job waits; a failed start reads as before", {
    when: ["the floor held a note to a Codex A pane, and a pane did not start", () => [
      deliveryBlockerDetail({ lastReason: "wake-refused:quota-floor: Codex A has spent its 5h window until 2026-10-20T22:15:37.000Z;"
        + " a turn now draws paid credits" }),
      deliveryBlockerDetail({ lastReason: "wake-refused:target CLI did not start" }),
    ]],
    then: ["the quota and the wait, then the start failure", details => expect(details).toEqual([
      "mottagarens kvot håller jobbet (Codex A has spent its 5h window until 2026-10-20T22:15:37.000Z; a turn now draws paid"
        + " credits); det levereras av sig självt när kontot har plats",
      "den adresserade agentprocessen kunde inte startas",
    ])],
  });
});
