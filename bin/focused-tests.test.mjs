import { expect, feature, unit } from "bdd-vitest";
import { relatedTests, unmappedExecutables } from "./focused-tests.mjs";

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

  unit("an unmapped executable is a gate failure with the exact path", {
    then: ["core/foo.mjs without core/foo.test.mjs is unmapped", () => {
      const exists = existsSet([]);
      expect(relatedTests("core/foo.mjs", { exists })).toEqual([]);
      expect(unmappedExecutables(["core/foo.mjs"], { exists })).toEqual(["core/foo.mjs"]);
    }],
  });

  unit("the PS1 maps to its source-contract test", {
    then: ["the alias lands the contract file", () => {
      const exists = existsSet(["test/windows-restarter-contract.test.mjs"]);
      expect(relatedTests("bin/windows-discord-restarter.ps1", { exists }))
        .toEqual(["test/windows-restarter-contract.test.mjs"]);
    }],
  });

  unit("docs, assets and build metadata may carry zero tests; nothing else", {
    then: ["allowlist holds, arbitrary config fails", () => {
      const exists = existsSet([]);
      expect(unmappedExecutables([
        "docs/FLEET-RESILIENCE-PLAN.md",
        "screenshot.png",
        "package.json",
        ".github/workflows/pull-request.yml",
        ".gitignore",
      ], { exists })).toEqual([]);
      expect(unmappedExecutables(["agentmux.yaml", "bin/other-cron.sh"], { exists }))
        .toEqual(["agentmux.yaml", "bin/other-cron.sh"]);
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
