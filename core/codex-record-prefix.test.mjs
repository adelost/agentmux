import { describe, it, expect } from "vitest";
import { classifyCodexRecordPrefix } from "./codex-record-prefix.mjs";

describe("bounded Codex writer-prefix classification", () => {
  it("recognizes new irrelevant subtypes without a whitelist", () => {
    expect(classifyCodexRecordPrefix('{"timestamp":"2026-10-14T15:55:59.217Z","ordinal":42,"type":"event_msg","payload":{"type":"future_large_event",'))
      .toEqual({ type: "event_msg", payloadType: "future_large_event" });
    expect(classifyCodexRecordPrefix('{"type":"turn_context","payload":{"model":"gpt-6.1-sol",'))
      .toEqual({ type: "turn_context", payloadType: null });
  });

  it("refuses unclassifiable envelopes and does not discover types inside quoted text", () => {
    for (const header of [
      '{"text":"quoted \\"type\\":\\"compacted\\",',
      '{"type":"event_msg","payload":{"message":"quoted type image_generation_end",',
      '{"type":"response_item","payload":{"role":"user","content":[',
      '{"timestamp":"2026-10-14T15:55:59.217Z","type":"event_msg","payload":{"type":"unfinished',
    ]) expect(classifyCodexRecordPrefix(header)).toBeNull();
    expect(classifyCodexRecordPrefix('{"type":"event_msg","payload":{"type":"user_message","message":"quoted image_generation_end"'))
      .toEqual({ type: "event_msg", payloadType: "user_message" });
  });
});
