import { describe, expect, it } from "vitest";
import {
  describeModelObservation,
  latestCodexModelObservation,
  modelMatchesRequest,
  observationFromClaudeEvent,
  observationFromCodexReroute,
} from "./native-model-observation.mjs";

describe("native model observation", () => {
  it("treats Claude aliases as the requested model, not as a fallback", () => {
    expect(modelMatchesRequest("fable", "claude-fable-5")).toBe(true);
    expect(modelMatchesRequest("opus", "claude-opus-4-8")).toBe(true);
    expect(modelMatchesRequest("fable", "claude-sonnet-4-6")).toBe(false);
    expect(modelMatchesRequest("claude-opus-4-1", "claude-opus-4-1-20250805")).toBe(true);
    expect(modelMatchesRequest("claude-opus-4-1", "claude-opus-4-10-20250805")).toBe(false);
  });

  it("reads actual Claude and Codex models from their structured JSON", () => {
    expect(observationFromClaudeEvent({
      type: "assistant",
      message: { model: "claude-fable-5" },
    }, 10)).toMatchObject({ model: "claude-fable-5", source: "claude-assistant", observedAt: 10 });

    expect(latestCodexModelObservation([
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5.5", effort: "high" } }),
      "malformed",
      JSON.stringify({
        type: "turn_context",
        payload: {
          turn_id: "turn-2",
          model: "gpt-5.6-sol",
          collaboration_mode: { settings: { reasoning_effort: "xhigh" } },
        },
      }),
    ], 20)).toEqual({
      model: "gpt-5.6-sol",
      effort: "xhigh",
      source: "codex-turn-context",
      observedAt: 20,
      turnId: "turn-2",
    });
  });

  it("does not reuse a previous Codex turn while the current context row is pending", () => {
    const previous = JSON.stringify({
      type: "turn_context",
      payload: { turn_id: "turn-1", model: "gpt-5.6-sol", effort: "medium" },
    });
    const current = JSON.stringify({
      type: "turn_context",
      payload: { turn_id: "turn-2", model: "gpt-5.6-sol", effort: "high" },
    });

    expect(latestCodexModelObservation([previous], 21, { turnId: "turn-2" })).toBeNull();
    expect(latestCodexModelObservation([previous, current], 22, { turnId: "turn-2" }))
      .toMatchObject({ turnId: "turn-2", effort: "high" });
  });

  it("turns a first silent fallback into a real downgrade finding", () => {
    const finding = describeModelObservation({
      requestedModel: "claude-fable-5",
      observation: { model: "claude-sonnet-4-6", source: "claude-assistant", observedAt: 30 },
    });
    expect(finding).toMatchObject({
      expected: false,
      cause: "automatic",
      change: {
        direction: "downgrade",
        kind: "model",
        from: "claude-fable-5",
        to: "claude-sonnet-4-6",
      },
      divergence: { direction: "downgrade", kind: "model" },
    });
  });

  it("deduplicates repeated evidence but records a requested mid-session switch", () => {
    const previous = {
      model: "claude-fable-5",
      effort: null,
      requestedModel: "fable",
      requestedEffort: "high",
    };
    expect(describeModelObservation({
      previous,
      requestedModel: "fable",
      requestedEffort: "high",
      observation: { model: "claude-fable-5", effort: null },
    }).change).toBeNull();

    expect(describeModelObservation({
      previous,
      requestedModel: "opus",
      requestedEffort: "high",
      observation: { model: "claude-opus-4-8", effort: null },
    })).toMatchObject({
      expected: true,
      cause: "requested",
      change: { direction: "lateral", kind: "model" },
    });
  });

  it("normalizes the Codex app-server reroute notification", () => {
    expect(observationFromCodexReroute({
      threadId: "thread-1",
      turnId: "turn-1",
      fromModel: "gpt-5.6-sol",
      toModel: "gpt-5.5",
      reason: "highRiskCyberActivity",
    }, 40)).toEqual({
      model: "gpt-5.5",
      effort: null,
      source: "codex-reroute",
      observedAt: 40,
      turnId: "turn-1",
      reason: "highRiskCyberActivity",
      fromModel: "gpt-5.6-sol",
    });
  });

  it("warns on an observed effort drop without classifying it as a stop", () => {
    expect(describeModelObservation({
      requestedModel: "gpt-5.6-sol",
      requestedEffort: "max",
      observation: { model: "gpt-5.6-sol", effort: "xhigh", source: "codex-turn-context" },
    })).toMatchObject({
      expected: false,
      modelExpected: true,
      effortExpected: false,
      change: { direction: "downgrade", kind: "effort" },
      divergence: { direction: "downgrade", kind: "effort" },
    });
  });
});
