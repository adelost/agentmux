import { describe, expect, it } from "vitest";
import {
  claudePrintSessionId,
  codexJsonlThreadId,
} from "../spikes/web-ui/canary-proof.mjs";

describe("native rollback evidence parsers", () => {
  it("reads the exact Claude session from both historical print-json shapes", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(claudePrintSessionId(JSON.stringify({ type: "result", session_id: id }))).toBe(id);
    expect(claudePrintSessionId(JSON.stringify([
      { type: "system", subtype: "init", session_id: id },
      { type: "assistant", session_id: id },
      { type: "result", session_id: id },
    ]))).toBe(id);
  });

  it("reads the Codex thread-start receipt instead of inferring from output text", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(codexJsonlThreadId([
      JSON.stringify({ type: "thread.started", thread_id: id }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n"))).toBe(id);
  });
});
