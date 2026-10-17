import { describe, it, expect } from "vitest";
import { waitingNotice, deliveredNotice } from "./delivery-notice-copy.mjs";
import { formatLimitedAlert } from "./quota-format.mjs";
import { unmappedChannelNotice } from "./unmapped-channel.mjs";
import { formatUserNotification } from "../cli/send-notify.mjs";
const job = { agentName: "skyvw", pane: 0, createdAt: 1000, acknowledgedAt: Date.parse("2026-10-17T02:48:00Z"),
  lastReason: "Claude quota is exhausted; exact-session recovery is pending" };
describe("approved short notice copy, Sky 2026-10-17", () => {
  it("says when the human's waiting message can arrive", () => {
    expect(waitingNotice(job)).toBe("⏸ skyvw:0 får det här när kvoten är tillbaka.");
  });
  it("edits delivery into a short checkmark", () => {
    expect(deliveredNotice(job, { timeZone: "UTC" })).toBe("✓ skyvw:0 fick det 02:48.");
  });
  it("names the stopped pane and its known automatic continuation", () => {
    expect(formatLimitedAlert({ paneKey: "skyvw:0", resetAt: "2026-10-21T07:00:00Z", autoResume: true }).discord)
      .toMatch(/^⛔ skyvw:0 väntar på kvot till .* och fortsätter sedan själv\.$/u);
  });
  it("answers an unmapped channel in one short line", () => {
    expect(unmappedChannelNotice("test")).toBe("Ingen panel läser #test. Skriv i en panels kanal.");
  });
  it("keeps a direct notification to one line and one symbol", () => {
    expect(formatUserNotification("Behöver svar.\nVälj A.", { level: "error", title: "Fråga" })).toBe("🚨 Fråga: Behöver svar. Välj A.");
  });
});
