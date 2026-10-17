import { describe, it, expect } from "vitest";
import { waitingNotice, deliveredNotice } from "./delivery-notice-copy.mjs";
import { formatLimitedAlert } from "./quota-format.mjs";
import { unmappedChannelNotice } from "./unmapped-channel.mjs";
import { formatUserNotification } from "../cli/send-notify.mjs";
const job = { agentName: "skyvw", pane: 0, createdAt: 1000, acknowledgedAt: Date.parse("2026-10-17T02:48:00Z"),
  lastReason: "Claude quota is exhausted; exact-session recovery is pending" };
describe("restored full notice copy, Mattias 2026-10-17", () => {
  it("says when the human's waiting message can arrive", () => {
    expect(waitingNotice(job)).toContain("It is sent automatically when it can be.");
  });
  it("edits delivery into the time it arrived", () => {
    expect(deliveredNotice(job, { timeZone: "UTC" })).toContain("skyvw:0 got this at 02:48, after ");
  });
  it("names the stopped pane and its known automatic continuation", () => {
    expect(formatLimitedAlert({ paneKey: "skyvw:0", resetAt: "2026-10-21T07:00:00Z", autoResume: true }).discord)
      .toContain("amux continues it in the same session");
  });
  it("answers an unmapped channel in one short line", () => {
    expect(unmappedChannelNotice("test")).toBe("#test is missing from the amux channel map, so no agent has got your message yet. Write in another pane's channel for now.");
  });
  it("keeps a direct notification to one line, its level in words", () => {
    expect(formatUserNotification("Behöver svar.\nVälj A.", { level: "error", title: "Fråga" })).toBe("**Fråga** (error)\nBehöver svar. Välj A.");
  });
});
