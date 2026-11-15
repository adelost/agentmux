import { component, expect, feature } from "bdd-vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeLifecycle } from "./bridge.mjs";
import { PassThrough, Writable } from "node:stream";

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
  component("foreground output reaches its terminal streams and log", {
    given: ["a foreground supervisor that writes to both output streams", () => {
      const fixture = bridgeFixture();
      writeFileSync(join(fixture.bridgeDir, "bin", "start.sh"), "#!/usr/bin/env bash\nprintf 'out-marker\\n'\nprintf 'err-marker\\n' >&2\n");
      const out = new PassThrough(), err = new PassThrough(), captured = { out: "", err: "" };
      out.on("data", (chunk) => { captured.out += chunk; }); err.on("data", (chunk) => { captured.err += chunk; });
      const startupHousekeeping = async () => ({ log: { rotated: false, beforeBytes: 0, afterBytes: 0 },
        sessions: { scanned: 0, candidates: 0, trimmed: 0, unchanged: 0, failed: 0, reclaimedBytes: 0, retentionDays: 14, dryRun: false, oversized: 0, oversizedBytes: 0 } });
      return { ...fixture, captured, lifecycle: createBridgeLifecycle({ bridgeDir: fixture.bridgeDir, env: fixture.env, startupHousekeeping,
        terminalOut: out, terminalErr: err }) };
    }],
    when: ["starting it", async (ctx) => { await ctx.lifecycle.serve({}, ctx.ctx); return ctx; }],
    then: ["both streams reach their respective terminal and the file", (ctx) => {
      try {
        expect(ctx.captured.out).toContain("out-marker");
        expect(ctx.captured.err).toContain("err-marker");
        expect(readFileSync(ctx.env.AMUX_BRIDGE_LOG, "utf8")).toMatch(/\[\d{4}-\d\d-\d\dT.*Z\] foreground bridge start/u);
        expect(readFileSync(ctx.env.AMUX_BRIDGE_LOG, "utf8")).toContain("out-marker");
        expect(readFileSync(ctx.env.AMUX_BRIDGE_LOG, "utf8")).toContain("err-marker");
      } finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
  component("managed startup writes each output line to its log once", {
    given: ["an isolated managed supervisor", () => {
      const fixture = bridgeFixture();
      writeFileSync(join(fixture.bridgeDir, "bin", "start.sh"), `#!/usr/bin/env bash\nprintf 'managed-marker\\n'\nprintf '%s' "$$" > "$PIDFILE"\nprintf '%s' "$$" > "$READY_FILE"\nsleep 5\n`);
      const startupHousekeeping = async () => ({ log: { rotated: false, beforeBytes: 0, afterBytes: 0 },
        sessions: { scanned: 0, candidates: 0, trimmed: 0, unchanged: 0, failed: 0, reclaimedBytes: 0, retentionDays: 14, dryRun: false, oversized: 0, oversizedBytes: 0 } });
      return { ...fixture, lifecycle: createBridgeLifecycle({ bridgeDir: fixture.bridgeDir, env: fixture.env, startupHousekeeping }) };
    }],
    when: ["starting the managed supervisor", async (ctx) => { await ctx.lifecycle.serve({ detach: true }, ctx.ctx); return ctx; }],
    then: ["one line appears in the log", async (ctx) => {
      try {
        const log = readFileSync(ctx.env.AMUX_BRIDGE_LOG, "utf8");
        expect(log.match(/managed-marker/gu)).toHaveLength(1);
      } finally { await ctx.lifecycle.stop(ctx.ctx); rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
  component("an unavailable log does not prevent a foreground start", {
    given: ["a log path that is a directory", () => {
      const fixture = bridgeFixture(), marker = join(fixture.root, "launched");
      fixture.env.AMUX_BRIDGE_LOG = fixture.root;
      writeFileSync(join(fixture.bridgeDir, "bin", "start.sh"), `#!/usr/bin/env bash\ntouch "${marker}"\n`);
      const startupHousekeeping = async () => ({ log: { rotated: false, beforeBytes: 0, afterBytes: 0 },
        sessions: { scanned: 0, candidates: 0, trimmed: 0, unchanged: 0, failed: 0, reclaimedBytes: 0, retentionDays: 14, dryRun: false, oversized: 0, oversizedBytes: 0 } });
      return { ...fixture, marker, lifecycle: createBridgeLifecycle({ bridgeDir: fixture.bridgeDir, env: fixture.env, startupHousekeeping }) };
    }],
    when: ["starting the bridge", async (ctx) => { await ctx.lifecycle.serve({}, ctx.ctx); return ctx; }],
    then: ["the supervisor still ran", (ctx) => {
      try { expect(existsSync(ctx.marker)).toBe(true); }
      finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
  component("terminal errors leave the foreground log copying", {
    given: ["a supervisor writing twice to both streams and failing terminal streams", () => {
      const fixture = bridgeFixture();
      writeFileSync(join(fixture.bridgeDir, "bin", "start.sh"), "#!/usr/bin/env bash\nprintf 'first-out\\n'; printf 'first-err\\n' >&2\nsleep 0.1\nprintf 'later-out\\n'; printf 'later-err\\n' >&2\n");
      const failing = () => new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("terminal gone"), { code: "EPIPE" })); } });
      const startupHousekeeping = async () => ({ log: { rotated: false, beforeBytes: 0, afterBytes: 0 },
        sessions: { scanned: 0, candidates: 0, trimmed: 0, unchanged: 0, failed: 0, reclaimedBytes: 0, retentionDays: 14, dryRun: false, oversized: 0, oversizedBytes: 0 } });
      return { ...fixture, lifecycle: createBridgeLifecycle({ bridgeDir: fixture.bridgeDir, env: fixture.env, startupHousekeeping,
        terminalOut: failing(), terminalErr: failing() }) };
    }],
    when: ["starting the supervisor", async (ctx) => { await ctx.lifecycle.serve({}, ctx.ctx); return ctx; }],
    then: ["later output from both streams remains in the log", (ctx) => {
      try {
        const log = readFileSync(ctx.env.AMUX_BRIDGE_LOG, "utf8");
        expect(log).toContain("later-out"); expect(log).toContain("later-err");
      } finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
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
            scanned: 0, candidates: 0, trimmed: 0, unchanged: 0, failed: 0,
            reclaimedBytes: 0,
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

feature("two launches racing for the bridge (row 103)", () => {
  component("a launch whose housekeeping overlaps a started bridge leaves that bridge's markers and starts nothing", {
    given: ["a stopped bridge whose housekeeper lets another launch bring a bridge up", () => {
      const fixture = bridgeFixture();
      const spawned = join(fixture.root, "spawned");
      writeFileSync(join(fixture.bridgeDir, "bin", "start.sh"), `#!/usr/bin/env bash\ntouch "${spawned}"\n`);
      const startupHousekeeping = async () => {
        writeFileSync(fixture.env.PIDFILE, `${process.pid}`);
        writeFileSync(fixture.env.READY_FILE, `${process.pid}`);
        return { log: { rotated: false, beforeBytes: 0, afterBytes: 0 }, sessions: { scanned: 0, candidates: 0, trimmed: 0, unchanged: 0, failed: 0, reclaimedBytes: 0, retentionDays: 14, dryRun: false, oversized: 0, oversizedBytes: 0 } };
      };
      return { ...fixture, spawned, lifecycle: createBridgeLifecycle({ bridgeDir: fixture.bridgeDir, env: fixture.env, startupHousekeeping }) };
    }],
    when: ["serve finishes its housekeeping", async (ctx) => {
      await ctx.lifecycle.serve([], ctx.ctx);
      return ctx;
    }],
    then: ["the running bridge keeps its pid and ready files and no second start.sh ran", (ctx) => {
      try {
        expect(readFileSync(ctx.env.PIDFILE, "utf8")).toBe(`${process.pid}`);
        expect(existsSync(ctx.env.READY_FILE)).toBe(true);
        expect(existsSync(ctx.spawned)).toBe(false);
      } finally {
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }],
  });
});
