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

  unit("non-JavaScript metadata never becomes a Vitest input by filename accident", {
    then: ["workflow YAML is allowlisted but maps to no test file", () => {
      const exists = existsSet([".github/workflows/pull-request.yml"]);
      expect(relatedTests(".github/workflows/pull-request.yml", { exists })).toEqual([]);
      expect(unmappedExecutables([".github/workflows/pull-request.yml"], { exists })).toEqual([]);
    }],
  });

  unit("the PS1 maps to its source-contract test", {
    then: ["the alias lands the contract file", () => {
      const exists = existsSet(["test/windows-restarter-contract.test.mjs"]);
      expect(relatedTests("bin/windows-discord-restarter.ps1", { exists }))
        .toEqual(["test/windows-restarter-contract.test.mjs"]);
    }],
  });

  unit("docs and assets may carry zero tests; executable metadata maps or fails", {
    then: ["allowlist stays narrow and package metadata runs the release contract", () => {
      const exists = existsSet([]);
      expect(unmappedExecutables([
        "docs/FLEET-RESILIENCE-PLAN.md",
        "screenshot.png",
        ".github/workflows/pull-request.yml",
        ".gitignore",
      ], { exists })).toEqual([]);
      const packageExists = existsSet(["core/release-install.test.mjs"]);
      expect(relatedTests("package.json", { exists: packageExists }))
        .toEqual(["core/release-install.test.mjs"]);
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

  unit("config.mjs maps to its split CLI suite", {
    then: ["the alias lands the sender-policy tests", () => {
      const exists = existsSet(["cli.test/config.test.mjs"]);
      expect(relatedTests("cli/config.mjs", { exists }))
        .toEqual(["cli.test/config.test.mjs"]);
    }],
  });

  unit("tmux attach maps to the layout and selective-start contract", {
    then: ["the alias lands the real component test", () => {
      const exists = existsSet(["cli.test/layout-contract.test.mjs"]);
      expect(relatedTests("cli/tmux.mjs", { exists }))
        .toEqual(["cli.test/layout-contract.test.mjs"]);
    }],
  });

  unit("bridge entrypoints map to their extracted focused contracts", {
    then: ["agent startup and Discord notices run the exact owning tests", () => {
      const exists = existsSet([
        "core/tui-stall-recovery.test.mjs",
        "core/delivery-notices.test.mjs",
      ]);
      expect(relatedTests("agent.mjs", { exists }))
        .toEqual(["core/tui-stall-recovery.test.mjs"]);
      expect(relatedTests("index.mjs", { exists }))
        .toEqual(["core/delivery-notices.test.mjs"]);
      expect(unmappedExecutables(["agent.mjs", "index.mjs"], { exists })).toEqual([]);
    }],
  });

  unit("dream orchestration maps to policy and command tests", {
    then: ["the alias covers both the pure boundary and delivery orchestration", () => {
      const exists = existsSet(["core/dream-eligibility.test.mjs", "test/commands-dream.test.mjs"]);
      expect(relatedTests("cli/dream.mjs", { exists }))
        .toEqual(["core/dream-eligibility.test.mjs", "test/commands-dream.test.mjs"]);
    }],
  });

  unit("split orientation modules map to their owning focused contracts", {
    then: ["runtime, generated hints, and semantic index all have explicit coverage", () => {
      const exists = existsSet([
        "cli.test/commands.test.mjs", "test/native-runtime-service.test.mjs",
        "cli/hints-sync.test.mjs", "core/search.test.mjs", "core/doctor.test.mjs",
        "core/windows-wsl-probe.test.mjs",
      ]);
      expect(relatedTests("cli/runtime.mjs", { exists })).toEqual([
        "cli.test/commands.test.mjs", "test/native-runtime-service.test.mjs",
      ]);
      expect(relatedTests("cli/native-runtime-service.mjs", { exists }))
        .toEqual(["test/native-runtime-service.test.mjs"]);
      expect(relatedTests("core/hints-tool-guide.mjs", { exists })).toEqual(["cli/hints-sync.test.mjs"]);
      expect(relatedTests("core/search-semantic.mjs", { exists })).toEqual(["core/search.test.mjs"]);
      expect(relatedTests("core/heartbeat.mjs", { exists }))
        .toEqual(["core/doctor.test.mjs", "core/windows-wsl-probe.test.mjs"]);
    }],
  });

  unit("the Codex rollout reader maps to its split component suite", {
    then: ["the alias lands the actual test path", () => {
      const exists = existsSet(["test/codex-jsonl-reader.test.mjs"]);
      expect(relatedTests("core/codex-jsonl-reader.mjs", { exists }))
        .toEqual(["test/codex-jsonl-reader.test.mjs"]);
    }],
  });

  unit("the windows manager files map to their smoke and contract tests", {
    then: ["the loop, the installer, and the rescue tool all land their focused tests", () => {
      const exists = existsSet(["bin/windows-manager-smoke.test.mjs", "test/windows-manager-contract.test.mjs"]);
      expect(relatedTests("bin/windows-manager.mjs", { exists }))
        .toEqual(["bin/windows-manager-smoke.test.mjs", "test/windows-manager-contract.test.mjs"]);
      expect(relatedTests("bin/windows-rescue-tool.ps1", { exists }))
        .toEqual(["test/windows-manager-contract.test.mjs"]);
      expect(unmappedExecutables(["bin/windows-manager.mjs", "bin/windows-rescue-tool.ps1"], { exists }))
        .toEqual([]);
      const installerExists = existsSet(["test/windows-manager-install-contract.test.mjs"]);
      expect(relatedTests("bin/windows-manager-install.ps1", { exists: installerExists }))
        .toEqual(["test/windows-manager-install-contract.test.mjs"]);
      expect(unmappedExecutables(["bin/windows-manager-install.ps1"], { exists: installerExists }))
        .toEqual([]);
    }],
  });
});
