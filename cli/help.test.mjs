import { expect, feature, unit } from "bdd-vitest";
import { vi } from "vitest";
import { cmdHelp } from "./help.mjs";

feature("amux help", () => {
  unit("documents that stop compacts first and how to skip it", {
    when: ["printing the help", () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try { cmdHelp(); return log.mock.calls.flat().join("\n"); } finally { log.mockRestore(); }
    }],
    then: ["the stop line names the compact and the --no-compact escape", (text) => {
      expect(text).toMatch(/stop <name\|:nr>.*compacts large idle panes/u);
      expect(text).toContain("--no-compact");
    }],
  });
});
