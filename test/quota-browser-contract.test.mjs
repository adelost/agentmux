import { describe, expect, it } from "vitest";
import {
  quotaDeliveryView, quotaHeadline, quotaObservationView, quotaRows,
} from "../spikes/web-ui/quota-observation.js";

const observation = {
  schemaVersion: 1,
  source: "codex.rollout.rate_limits",
  observedAt: "2026-07-17T12:00:00.000Z",
  refreshIntervalMs: 15 * 60_000,
  usedPercent: 65,
  remainingPercent: 35,
  resetsAt: "2026-07-23T04:16:00.000Z",
};

describe("Code browser quota observation contract", () => {
  it("renders the canonical provider observation while it is fresh", () => {
    const view = quotaObservationView(observation, Date.parse("2026-07-17T12:29:59.999Z"));
    expect(view)
      .toEqual({ state: "fresh", ageMs: 29 * 60_000 + 59_999,
        source: "codex.rollout.rate_limits", observedAt: "2026-07-17T12:00:00.000Z",
        usedPercent: 65, remainingPercent: 35, resetsAt: "2026-07-23T04:16:00.000Z" });
    expect(quotaHeadline(quotaRows("codex", { observation }, view))).toMatchObject({
      label: "Week", usedPercent: 65, remainingPercent: 35,
      resetsAt: "2026-07-23T04:16:00.000Z",
    });
  });

  it("removes the percentage at two intervals instead of showing stale as current", () => {
    expect(quotaObservationView(observation, Date.parse("2026-07-17T12:30:00.000Z")))
      .toEqual({ state: "stale", ageMs: 30 * 60_000,
        source: "codex.rollout.rate_limits", observedAt: "2026-07-17T12:00:00.000Z",
        usedPercent: null, remainingPercent: null, resetsAt: null });
  });

  it("classifies a stopped or failed Suggest delivery independently from collection", () => {
    expect(quotaDeliveryView({ ok: false, error: "network_error",
      health: { state: "alert", reason: "suggestions-delivery-stale" } }))
      .toEqual({ state: "failed", reason: "suggestions-delivery-stale" });
    expect(quotaDeliveryView({ ok: true, health: { state: "nominal" } }))
      .toEqual({ state: "synced", reason: null });
    expect(quotaDeliveryView({ ok: true, health: { state: "nominal" },
      previousHealth: { state: "alert", reason: "suggestions-delivery-stale" } }))
      .toEqual({ state: "recovered", reason: "suggestions-delivery-stale" });
  });
});
