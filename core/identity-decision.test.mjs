import { describe, expect, it } from "vitest";
import { identityDecision } from "./release-identity.mjs";

describe("identity decision", () => {
  it("always allows the bridge (recovery channel) but gates panel revive on identity", () => {
    expect(identityDecision({ ok: true, issues: [], warnings: [] })).toEqual({
      allowBridge: true,
      allowRevive: true,
      reason: "ok",
      detail: "",
    });

    const refused = identityDecision({
      ok: false,
      issues: [{ code: "linked-checkout", detail: "global package resolves into a git working tree" }],
    });
    expect(refused.allowBridge).toBe(true);
    expect(refused.allowRevive).toBe(false);
    expect(refused.reason).toBe("linked-checkout");
    expect(refused.detail).toContain("git working tree");

    expect(identityDecision(null)).toMatchObject({
      allowBridge: true,
      allowRevive: false,
      reason: "identity-unobservable",
    });
  });
});
