import { component, expect, feature } from "bdd-vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeLifecycle } from "./bridge.mjs";

function bridgeFixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-bridge-housekeeping-"));
  const bridgeDir = join(root, "bridge");
  mkdirSync(join(bridgeDir, "bin"), { recursive: true });
  const start = join(bridgeDir, "bin", "start.sh");
  writeFileSync(start, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(start, 0o755);
  const env = {
    ...process.env,
    HOME: root,
    PIDFILE: join(root, "bridge.pid"),
    READY_FILE: join(root, "bridge.ready"),
    AMUX_BRIDGE_MODE_FILE: join(root, "bridge-mode"),
    AMUX_BRIDGE_SERVICE_DIR: join(root, "service"),
    AMUX_BRIDGE_LOG: join(root, "bridge.log"),
  };
  const ctx = {
    bridgeDir,
    tmux: async () => { throw new Error("no test tmux session"); },
  };
  return { root, bridgeDir, env, ctx };
}

feature("bridge startup housekeeping seam", () => {
  component("does not rotate storage while a ready bridge owns it", {
    given: ["a ready bridge and an injected housekeeper", () => {
      const fixture = bridgeFixture();
      writeFileSync(fixture.env.PIDFILE, `${process.pid}\n`);
      writeFileSync(fixture.env.READY_FILE, `${process.pid}\n`);
      const calls = [];
      return { ...fixture, calls, lifecycle: createBridgeLifecycle({
        bridgeDir: fixture.bridgeDir,
        env: fixture.env,
        startupHousekeeping: async (input) => { calls.push(input); },
      }) };
    }],
    when: ["serve observes existing ownership", async (ctx) => {
      await ctx.lifecycle.serve([], ctx.ctx);
      return ctx;
    }],
    then: ["housekeeping never touches the live log", (ctx) => {
      try {
        expect(ctx.calls).toHaveLength(0);
      } finally {
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }],
  });

  component("runs housekeeping once before a fresh foreground launch", {
    given: ["a stopped bridge and an injected housekeeper", () => {
      const fixture = bridgeFixture();
      const calls = [];
      const startupHousekeeping = async (input) => {
        calls.push(input);
        return {
          log: { rotated: false, beforeBytes: 0, afterBytes: 0 },
          sessions: {
            scanned: 0, candidates: 0, deleted: 0, failed: 0, freedBytes: 0,
            retentionDays: 14, dryRun: false, oversized: 0, oversizedBytes: 0,
          },
        };
      };
      return { ...fixture, calls, lifecycle: createBridgeLifecycle({
        bridgeDir: fixture.bridgeDir, env: fixture.env, startupHousekeeping,
      }) };
    }],
    when: ["serving in the visible terminal", async (ctx) => {
      await ctx.lifecycle.serve([], ctx.ctx);
      return ctx;
    }],
    then: ["maintenance ran exactly once against the configured bridge log", (ctx) => {
      try {
        expect(ctx.calls).toHaveLength(1);
        expect(ctx.calls[0].bridgeLogPath).toBe(ctx.env.AMUX_BRIDGE_LOG);
      } finally {
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }],
  });
});
