import { describe, it, expect } from "vitest";
import { waitingNotice, deliveredNotice } from "./delivery-notice-copy.mjs";
import { formatLimitedAlert } from "./quota-format.mjs";
import { unmappedChannelNotice } from "./unmapped-channel.mjs";
import { formatUserNotification } from "../cli/send-notify.mjs";
const job = { agentName: "skyvw", pane: 0, createdAt: 1000, acknowledgedAt: Date.parse("2026-10-17T02:48:00Z"),
  lastReason: "Claude quota is exhausted; exact-session recovery is pending" };
describe("restored full notice copy, Mattias 2026-10-17", () => {
  it("says when the human's waiting message can arrive", () => {
    expect(waitingNotice(job)).toContain("Det skickas automatiskt när det går.");
  });
  it("edits delivery into a short checkmark", () => {
    expect(deliveredNotice(job, { timeZone: "UTC" })).toContain("✅ skyvw:0 fick det här 02:48, efter ");
  });
  it("names the stopped pane and its known automatic continuation", () => {
    expect(formatLimitedAlert({ paneKey: "skyvw:0", resetAt: "2026-10-21T07:00:00Z", autoResume: true }).discord)
      .toContain("amux fortsätter själv i samma session");
  });
  it("answers an unmapped channel in one short line", () => {
    expect(unmappedChannelNotice("test")).toBe("#test saknas i amux kanalkarta, så ingen agent har fått ditt meddelande än. Skriv i en annan panels kanal så länge.");
  });
  it("keeps a direct notification to one line and one symbol", () => {
    expect(formatUserNotification("Behöver svar.\nVälj A.", { level: "error", title: "Fråga" })).toBe("🚨 **Fråga** (error)\nBehöver svar. Välj A.");
  });
});
