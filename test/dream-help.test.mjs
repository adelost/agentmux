// End-to-end dispatch contract: `amux dream --help` prints usage and writes
// nothing. Regression for the flag-parser layer where --help fell through to
// a full stateless Dream run.

import { expect, feature, component } from "bdd-vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

feature("amux dream --help end to end", () => {
  component("the real CLI prints usage with zero writes, locks, or model calls", {
    given: ["an empty HOME and workspace", () => {
      const home = mkdtempSync(join(tmpdir(), "amux-dream-help-"));
      return {
        home,
        workspace: join(home, "workspace"),
        cleanup: () => rmSync(home, { recursive: true, force: true }),
      };
    }],
    when: ["invoking dream --help through the real binary", (fx) => spawnSync(
      process.execPath,
      [join(REPO, "bin", "agent-cli.mjs"), "dream", "--help"],
      {
        encoding: "utf-8",
        timeout: 30_000,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: fx.home,
          OPENCLAW_WORKSPACE: fx.workspace,
          AMUX_JANITOR_ENABLED: "false",
        },
      },
    )],
    then: ["usage on stdout, exit zero, and not a single side effect", (result, fx) => {
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: amux dream");
      expect(result.stdout).not.toContain("stateless summary");
      expect(existsSync(fx.workspace)).toBe(false);
      expect(existsSync(join(fx.home, ".openclaw", ".dream.lock"))).toBe(false);
      fx.cleanup();
    }],
  });
});
