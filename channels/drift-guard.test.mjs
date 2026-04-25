// Tests for drift-guard reply-forwarder helpers. The full forwardReplyAsync
// flow is integration-tested live (channel-mirror to Discord) — here we
// pin the boilerplate filter so future ack patterns can be added with
// confidence they don't slip through.

import { describe, it, expect } from "vitest";
import { isBoilerplateReply } from "./drift-guard.mjs";

describe("isBoilerplateReply", () => {
  it("matches 'No response requested.'", () => {
    expect(isBoilerplateReply("No response requested.")).toBe(true);
    expect(isBoilerplateReply("no response requested")).toBe(true);
  });

  it("matches Swedish acks (Re-läst., Läst. Standby., Standby.)", () => {
    expect(isBoilerplateReply("Re-läst.")).toBe(true);
    expect(isBoilerplateReply("Re-last")).toBe(true);
    expect(isBoilerplateReply("Läst. Standby.")).toBe(true);
    expect(isBoilerplateReply("Standby.")).toBe(true);
  });

  it("matches 'Acknowledged.' / 'OK.'", () => {
    expect(isBoilerplateReply("Acknowledged.")).toBe(true);
    expect(isBoilerplateReply("acknowledged")).toBe(true);
    expect(isBoilerplateReply("OK")).toBe(true);
    expect(isBoilerplateReply("Okej.")).toBe(true);
  });

  it("treats empty/whitespace-only text as boilerplate (skip forwarding)", () => {
    expect(isBoilerplateReply("")).toBe(true);
    expect(isBoilerplateReply("   \n  ")).toBe(true);
    expect(isBoilerplateReply(null)).toBe(true);
    expect(isBoilerplateReply(undefined)).toBe(true);
  });

  it("lets real signal through (recommendations, multi-sentence acks)", () => {
    expect(isBoilerplateReply("→ Rekommenderar B. Varför: ...")).toBe(false);
    expect(isBoilerplateReply("Read. Picking option 2 — see below.")).toBe(false);
    expect(isBoilerplateReply("Acknowledged. Switching to plan B because timeline shifted.")).toBe(false);
  });
});
