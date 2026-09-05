import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("help before CLI config bootstrap", () => {
  it.each([["restart", "--all", "--help"], ["runtime", "restart", "-h"], ["help"]])(
    "%j works with invalid source config and creates no runtime config", (...args) => {
      const root = mkdtempSync(join(tmpdir(), "amux-help-bootstrap-"));
      const source = join(root, "agentmux.yaml"), generated = join(root, "agents.yaml");
      // Invalid YAML catches accidental config bootstrap before help dispatch.
      writeFileSync(source, "agents: [invalid\n");
      writeFileSync(join(root, "bridge.pid"), "4242\n");
      const guard = join(root, "guard.mjs");
      writeFileSync(guard, `
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const forbidden = () => { throw new Error("unexpected lifecycle effect during help"); };
        process.kill = forbidden;
        for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[key] = forbidden;
        syncBuiltinESMExports();
      `);
      try {
        const result = spawnSync(process.execPath, ["--import", guard,
          resolve(import.meta.dirname, "../bin/agent-cli.mjs"), ...args], {
          encoding: "utf8", timeout: 10_000,
          env: { HOME: root, PATH: "/usr/bin:/bin", AGENTMUX_BRIDGE_DIR: root,
            AGENTMUX_YAML: source, AGENTS_YAML: generated, STATE_FILE: join(root, "state.json"),
            PIDFILE: join(root, "bridge.pid"), AMUX_FLEET_RESTART_REQUEST: join(root, "restart.json") },
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("Usage:");
        expect(readFileSync(source, "utf8")).toBe("agents: [invalid\n");
        expect(existsSync(generated)).toBe(false);
        expect(existsSync(join(root, ".agentmux"))).toBe(false);
        expect(existsSync(join(root, "restart.json"))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    },
  );
});
