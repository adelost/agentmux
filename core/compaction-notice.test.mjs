import { expect, feature, unit } from "bdd-vitest";
import { compactionNoticeText } from "./compaction-notice.mjs";

feature("compaction notice", () => {
  unit("a compact receipt alone does not claim work has resumed", {
    when: ["one completed compact without a continuation receipt", () =>
      compactionNoticeText("skybar:2", [{ timestamp: "2026-11-02T17:28:25Z" }])],
    then: ["the notice states only what the receipt proves", (text) => {
      expect(text).toContain("Context compacted for **skybar:2**");
      expect(text).not.toContain("Work continues");
    }],
  });
});
