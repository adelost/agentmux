import { expect, feature, unit } from "bdd-vitest";
import { watchdogAlertDelivery } from "./suggestions-watchdog-outbox.mjs";

const reminder = (payload = {}) => ({
  id: 12,
  ticketId: "AI-0042",
  assignmentId: 9,
  kind: "pull_claim_attention_due",
  dedupeKey: "pull_claim_attention_due:9:1000",
  payload: {
    targetAgentId: "ai:4",
    question: "Are you still working on this ticket?",
    ...payload,
  },
  queuedAt: 1_000,
  deliveredAt: null,
});

feature("pull claim owner reminders", () => {
  unit("routes the short status question to the durable owner instead of the broker", {
    given: ["an AI pull reminder and a distinct broker", () => ({
      alert: reminder(), broker: { agent: "ai", pane: 2 },
    })],
    when: ["the watchdog resolves its delivery", ({ alert, broker }) =>
      watchdogAlertDelivery("ai", alert, {}, broker)],
    then: ["the owner pane and bounded answer contract are returned", (delivery) => {
      expect(delivery).toEqual({
        agent: "ai",
        pane: 4,
        prompt: "[BOARD CHECK · AI-0042] Are you still working on this ticket?\n"
          + "Reply exactly: working, waiting, blocked, or done.",
      });
    }],
  });

  unit("fails closed when the owner target is malformed", {
    given: ["a reminder without an agentmux owner target", () => reminder({ targetAgentId: "ai" })],
    when: ["the delivery is resolved", (alert) => () =>
      watchdogAlertDelivery("ai", alert, {}, { agent: "ai", pane: 2 })],
    then: ["broker fallback is rejected", (resolve) => {
      expect(resolve).toThrow("pull_claim_attention_due targetAgentId is not an agentmux target");
    }],
  });

  unit("classifies a missing question without attempting delivery", {
    given: ["a reminder with no status question", () => reminder({ question: "" })],
    when: ["the delivery is resolved", (alert) => () =>
      watchdogAlertDelivery("ai", alert, {}, { agent: "ai", pane: 2 })],
    then: ["the exact schema defect is reported", (resolve) => {
      expect(resolve).toThrow("pull_claim_attention_due question is missing");
    }],
  });
});
