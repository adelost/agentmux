import { expect, feature, unit } from "bdd-vitest";
import { codexRefusals, codexThreadOfRollout } from "./codex-refusal-notice.mjs";
import { capacityEvents } from "../test/fixtures/codex-capacity-2026-10-12.mjs";

const turn = (id, ...between) => [
  { type: "event_msg", timestamp: `${id}-start`, payload: { type: "user_message", message: "Hej" } },
  ...between,
  { type: "event_msg", timestamp: `${id}-end`, __hash: `${id}-hash`, payload: { type: "task_complete" } },
];
const usage = { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 9 } } } };

feature("a Codex turn that no model ran is told apart from a quiet answer", () => {
  unit("the October 12 capacity stop remains discoverable after earlier token usage", {
    when: ["reading the sanitized actual stop", () => codexRefusals(capacityEvents)],
    then: ["the failed final request is available for exact log classification", (refusals) => {
      expect(refusals).toHaveLength(1);
      expect(refusals[0].timestamp).toBe("2026-10-12T07:10:03.473Z");
      expect(refusals[0].turnId).toBe("01a12ef1-69fa-70a3-9fbe-3d7994a8d712");
    }],
  });
  unit("only a prompt closed without any token usage is a refusal", {
    when: ["reading refused, answered, aborted and open turns", () => codexRefusals([
      ...turn("refused"),
      ...turn("answered", usage),
      { type: "event_msg", payload: { type: "user_message", message: "stopped" } },
      { type: "event_msg", payload: { type: "turn_aborted" } },
      { type: "event_msg", payload: { type: "user_message", message: "still running" } },
    ])],
    then: ["the refused turn alone is listed with its prompt time", (refusals) => {
      expect(refusals).toEqual([{ id: "refused-hash", timestamp: "refused-end", promptAt: "refused-start" }]);
    }],
  });

  unit("the thread id comes from the exact rollout file", {
    when: ["reading a rollout path and a foreign file", () => [
      codexThreadOfRollout("/x/rollout-2026-07-10T11-22-25-019f4b55-db9f-74d1-9a7d-eac0e1acd4c3.jsonl"),
      codexThreadOfRollout("/x/session.jsonl")]],
    then: ["only the rollout yields a thread", (threads) => expect(threads).toEqual(["019f4b55-db9f-74d1-9a7d-eac0e1acd4c3", null])],
  });
});
