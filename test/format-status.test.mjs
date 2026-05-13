import { feature, unit, expect } from "bdd-vitest";
import { detectPaneStatus } from "../cli/format.mjs";

feature("pane status detection", () => {
  unit("treats compacting with a visible prompt and queued message as working", {
    given: ["Claude compact UI with queued prompt", () => [
      "❯ /compact",
      "",
      "* Compacting conversation… (1m 31s)",
      "  ▰▰▰▰▰▰▰▱ 64%",
      "",
      "  ❯ [dream 2026-05-13 13:33]",
      "────────────────────────────────────────────────────────────────────────────",
      "❯ Press up to edit queued messages",
      "────────────────────────────────────────────────────────────────────────────",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["status is working, not idle", (status) => {
      expect(status).toBe("working");
    }],
  });

  unit("still treats a plain visible prompt as idle", {
    given: ["normal idle composer", () => [
      "Done with previous task.",
      "",
      "❯ ",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["status is idle", (status) => {
      expect(status).toBe("idle");
    }],
  });
});
