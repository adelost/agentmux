import { feature, component, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";
import { HINTS_VERSION } from "../agent.mjs";
import { dispatch } from "./commands.mjs";

feature("amux hints-sync", () => {
  component("the command refreshes every configured root and exposes a stale live bridge", {
    given: ["two configured sessions and an old running bridge", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-hints-cli-"));
      const first = join(root, "first");
      const second = join(root, "second");
      mkdirSync(first, { recursive: true });
      mkdirSync(second, { recursive: true });
      const configPath = join(root, "agents.yaml");
      writeFileSync(configPath, [
        "alpha:",
        `  dir: ${first}`,
        "  panes:",
        "    - cmd: codex",
        "beta:",
        `  dir: ${second}`,
        "  panes:",
        "    - cmd: claude",
        "",
      ].join("\n"));
      return {
        root,
        first,
        second,
        configPath,
        logs: vi.spyOn(console, "log").mockImplementation(() => {}),
        warnings: vi.spyOn(console, "warn").mockImplementation(() => {}),
      };
    }],
    when: ["running the one fleet command", async (fx) => ({
      fx,
      result: await dispatch(["hints-sync"], {
        configPath: fx.configPath,
        readHeartbeat: () => ({ pid: 4242, hintsVersion: "older" }),
        isPidAlive: () => true,
      }),
    })],
    then: ["files update and the restart requirement is explicit", ({ fx, result }) => {
      expect(result).toMatchObject({
        version: HINTS_VERSION,
        configuredSessions: 2,
        workspaceRoots: 2,
        changedFiles: 4,
        errors: [],
        bridge: { state: "stale", restartRequired: true },
      });
      for (const workspace of [fx.first, fx.second]) {
        for (const file of ["CLAUDE.md", "AGENTS.md"]) {
          expect(readFileSync(join(workspace, ".agents", file), "utf8"))
            .toContain(`<!-- amux-hints-version: ${HINTS_VERSION} -->`);
        }
      }
      expect(fx.logs.mock.calls.flat().join(" ")).toContain("2 sessions / 2 workspaces");
      expect(fx.warnings.mock.calls.flat().join(" ")).toContain("bridge restart required");
      fx.logs.mockRestore();
      fx.warnings.mockRestore();
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });
});
