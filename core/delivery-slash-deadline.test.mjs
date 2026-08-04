import { feature, unit, expect } from "bdd-vitest";
import { submittedTerminalMs } from "./delivery-broker.mjs";

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * 60 * 1_000;

feature("How long a submitted job may hold its lane", () => {
  unit("gives a slash command only a minute, because it has no receipt to wait for", {
    given: ["a submitted slash command", () => ({ kind: "slash", text: "/model claude-opus-5" })],
    when: ["asking how long it may hold the lane", (job) => submittedTerminalMs(job)],
    then: ["it gives up after a minute instead of starving the queue for an hour",
      (ms) => expect(ms).toBe(ONE_MINUTE)],
  });

  unit("still gives a prompt the full hour, because a long turn is legitimate", {
    given: ["a submitted prompt", () => ({ kind: "prompt", text: "run the full test suite" })],
    when: ["asking how long it may hold the lane", (job) => submittedTerminalMs(job)],
    then: ["the existing hour is untouched", (ms) => expect(ms).toBe(ONE_HOUR)],
  });

  unit("treats an unlabelled job as a prompt", {
    given: ["a job with no kind", () => ({ text: "legacy row" })],
    when: ["asking how long it may hold the lane", (job) => submittedTerminalMs(job)],
    then: ["it keeps the conservative hour", (ms) => expect(ms).toBe(ONE_HOUR)],
  });
});
