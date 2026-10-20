import { feature, unit, expect } from "bdd-vitest";
import { deliveryBlockerDetail } from "./delivery-handoff.mjs";

// 2026-10-20 18:12Z: the quota floor held api:0's note to api:6 (Codex A's 5 h window spent), and the sender's stop
// notice said the pane's process could not be started, with advice to hand the work to another owner.
feature("the reason the sender of a held handoff reads", () => {
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
