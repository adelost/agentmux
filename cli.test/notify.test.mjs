import { feature, unit, expect } from "bdd-vitest";

// notifyWorker is async + depends on real agent instance, so we test the helpers
// that are reusable. The full worker is integration-tested manually.

import { detectPaneStatus } from "../cli/format.mjs";

feature("notify worker status detection", () => {
  unit("working → idle transition detected", {
    given: ["working then idle pane content", () => [
      "some output\n  esc to interrupt\n",
      "some output\n❯ \nbypass permissions on\n",
    ]],
    when: ["detecting both states", (contents) => contents.map(detectPaneStatus)],
    then: ["first is working, second is idle", ([first, second]) => {
      expect(first).toBe("working");
      expect(second).toBe("idle");
    }],
  });

  unit("menu stops the worker", {
    given: ["pane with menu", () => "Enter to select\n1. Option A\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns menu", (s) => expect(s).toBe("menu")],
  });

  unit("permission stops the worker", {
    given: ["pane with permission request", () => "Allow once  Allow always\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns permission", (s) => expect(s).toBe("permission")],
  });
});
