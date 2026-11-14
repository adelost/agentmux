import { expect, feature, unit } from "bdd-vitest";
import { compactionNoticeText, compactCauseForEvent } from "./compaction-notice.mjs";

feature("compaction notice", () => {
  unit("the journal notice uses the same exact-session compact cause as the receipt", {
    given: ["one idle compact, followed by its native boundary", () => ({
      event: { timestamp: "2026-11-02T17:28:25Z" }, path: "/session.jsonl",
      receipt: { at: Date.parse("2026-11-02T17:28:20Z"), sessionPath: "/session.jsonl",
        compactCause: "50 min idle: 137030 tokens > 80000" } })],
    when: ["matching its receipt and formatting its Discord line", ({ event, path, receipt }) => {
      const cause = compactCauseForEvent(event, receipt, path);
      return compactionNoticeText("skybar:2", [{ ...event, cause }]);
    }],
    then: ["the same cause and its numbers are present", text => expect(text).toContain("50 min idle: 137030 tokens > 80000")],
  });
  unit("a compact receipt alone does not claim work has resumed", {
    when: ["one completed compact without a continuation receipt", () =>
      compactionNoticeText("skybar:2", [{ timestamp: "2026-11-02T17:28:25Z" }])],
    then: ["the notice states only what the receipt proves", (text) => {
      expect(text).toContain("Context compacted for **skybar:2**");
      expect(text).not.toContain("Work continues");
    }],
  });
});
