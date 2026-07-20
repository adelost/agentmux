import { expect, feature, unit } from "bdd-vitest";
import { relatedTests } from "./focused-tests.mjs";

const existsSet = (paths) => (path) => paths.includes(path);

feature("focused PR tests", () => {
  unit("a changed source file maps to its sibling test file", {
    then: ["exact mapping, nothing else", () => {
      const exists = existsSet(["core/memory-guard.test.mjs"]);
      expect(relatedTests("core/memory-guard.mjs", { exists }))
        .toEqual(["core/memory-guard.test.mjs"]);
    }],
  });

  unit("a changed test file runs itself", {
    then: ["identity mapping", () => {
      const exists = existsSet(["core/revive.test.mjs"]);
      expect(relatedTests("core/revive.test.mjs", { exists }))
        .toEqual(["core/revive.test.mjs"]);
    }],
  });

  unit("a changed file without a related test maps to nothing", {
    then: ["docs and scripts stay uncovered by tests, not widened", () => {
      const exists = existsSet(["core/other.test.mjs"]);
      expect(relatedTests("docs/FLEET-RESILIENCE-PLAN.md", { exists })).toEqual([]);
      expect(relatedTests("core/no-such-test.mjs", { exists })).toEqual([]);
    }],
  });

  unit("commands.mjs maps to its split CLI suite", {
    then: ["the alias lands the real file", () => {
      const exists = existsSet(["cli.test/commands.test.mjs"]);
      expect(relatedTests("cli/commands.mjs", { exists }))
        .toEqual(["cli.test/commands.test.mjs"]);
    }],
  });
});
