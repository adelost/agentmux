import { expect, feature, unit } from "bdd-vitest";
import { accountRotationOutcome, classifyClaudeRotationPane } from "./account-rotation.mjs";

feature("Claude account rotation policy", () => {
  unit("a sleeping pane changes selection without being woken", {
    when: ["classifying a shell-only Claude pane", () => classifyClaudeRotationPane({
      processState: { command: "bash", shell: true, running: false },
    })],
    then: ["the pane is dormant and safe", (result) => {
      expect(result).toEqual({ allow: true, mode: "dormant", reason: "pane-sleeping" });
    }],
  });

  unit("active work or queued delivery blocks the whole transition", {
    when: ["classifying both unsafe states", () => [
      classifyClaudeRotationPane({
        processState: { command: "claude", running: true },
        busy: true,
        transportState: "empty-idle",
        liveDeliveryJobs: 0,
        sessionId: "session",
      }),
      classifyClaudeRotationPane({
        processState: { command: "claude", running: true },
        busy: false,
        transportState: "empty-idle",
        liveDeliveryJobs: 1,
        sessionId: "session",
      }),
    ]],
    then: ["neither pane is eligible", (results) => {
      expect(results.map((result) => result.reason)).toEqual([
        "active-or-unknown-turn",
        "live-or-unknown-delivery",
      ]);
    }],
  });

  unit("a rollback is reported as partial rather than recovered", {
    when: ["one pane rolls back after restart failure", () => accountRotationOutcome([
      { key: "lsrc:0", status: "switched" },
      { key: "lsrc:1", status: "rolled-back" },
    ])],
    then: ["the fleet result remains honest", (result) => {
      expect(result.status).toBe("PARTIAL");
    }],
  });
});
