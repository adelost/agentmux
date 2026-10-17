import { describe, it, expect } from "vitest";
import { jsonlContextFooter, nativeContextFooter } from "./context-footer.mjs";

describe("original visible model, effort and context footer", () => {
  it("keeps JSONL effort and measured tokens", () => {
    expect(jsonlContextFooter({ model: "claude-opus-4-8", effort: "high", percent: 61, tokens: 122000 }))
      .toBe("_opus-4-8 high · context: 61% (122k)_");
  });
  it("uses the native observed model and effort", () => {
    expect(nativeContextFooter({ model: "old", observedModel: "claude-opus-4-8", observedEffort: "high", context: { percent: 61, usedTokens: 122000 } }))
      .toBe("_opus-4-8 high · context: 61% (122k)_");
  });
});
