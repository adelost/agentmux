import { feature, integration, expect } from "bdd-vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function setupCli({ managed = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-serve-mode-"));
  const bridgeDir = join(root, "bridge");
  const binDir = join(bridgeDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const start = join(binDir, "start.sh");
  writeFileSync(start, managed
    ? `#!/usr/bin/env bash
set -u
cleanup() { rm -f "$PIDFILE" "$READY_FILE"; exit 0; }
trap cleanup TERM INT
echo $$ > "$PIDFILE"
echo $$ > "$READY_FILE"
while true; do sleep 1 & wait $! || true; done
`
    : "#!/usr/bin/env bash\necho fake-foreground-bridge\n");
  chmodSync(start, 0o755);
  const config = join(root, "agents.yaml");
  writeFileSync(config, "{}\n");
  const env = {
    ...process.env,
    HOME: root,
    AGENTMUX_BRIDGE_DIR: bridgeDir,
    AGENT_CONFIG: config,
    TMUX_SOCKET: join(root, "missing-tmux.sock"),
    PIDFILE: join(root, "bridge.pid"),
    READY_FILE: join(root, "bridge.ready"),
    AMUX_BRIDGE_MODE_FILE: join(root, "bridge-mode"),
    AMUX_BRIDGE_SERVICE_DIR: join(root, "bridge-service"),
    AMUX_BRIDGE_LOG: join(root, "bridge.log"),
  };
  const run = (...args) => spawnSync("node", [join(REPO, "bin", "agent-cli.mjs"), ...args], {
    cwd: REPO, env, encoding: "utf-8", timeout: 10_000,
  });
  return { root, env, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("serve CLI ownership UX", () => {
  integration("plain serve runs visibly and records manual ownership", {
    given: ["an isolated bridge launcher", setupCli],
    when: ["running amux serve", (ctx) => ({ ctx, result: ctx.run("serve") })],
    then: ["foreground output and manual mode", ({ ctx, result }) => {
      try {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Bridge running in this terminal");
        expect(result.stdout).toContain("fake-foreground-bridge");
        expect(readFileSync(ctx.env.AMUX_BRIDGE_MODE_FILE, "utf-8").trim()).toBe("manual");
      } finally { ctx.cleanup(); }
    }],
  });

  integration("stop persists intentional shutdown even when no process exists", {
    given: ["an isolated bridge launcher", setupCli],
    when: ["running amux stop", (ctx) => ({ ctx, result: ctx.run("stop") })],
    then: ["stopped mode", ({ ctx, result }) => {
      try {
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("not running");
        expect(readFileSync(ctx.env.AMUX_BRIDGE_MODE_FILE, "utf-8").trim()).toBe("stopped");
      } finally { ctx.cleanup(); }
    }],
  });

  integration("detached serve is tmux-free, readiness-gated, and exactly stoppable", {
    given: ["an isolated long-running bridge launcher", () => setupCli({ managed: true })],
    when: ["starting then stopping detached ownership", (ctx) => {
      const started = ctx.run("serve", "--detach");
      const record = JSON.parse(readFileSync(join(ctx.env.AMUX_BRIDGE_SERVICE_DIR, "process.json"), "utf8"));
      const readyPid = Number(readFileSync(ctx.env.READY_FILE, "utf8").trim());
      const stopped = ctx.run("stop");
      return { ctx, started, stopped, record, readyPid };
    }],
    then: ["the owned supervisor starts without tmux and stop removes it", ({ ctx, started, stopped, record, readyPid }) => {
      try {
        expect(started.status).toBe(0);
        expect(started.stdout).toContain("managed supervisor pid");
        expect(started.stdout).toContain("no tmux");
        expect(record.pid).toBe(readyPid);
        expect(readFileSync(ctx.env.AMUX_BRIDGE_MODE_FILE, "utf8").trim()).toBe("stopped");
        expect(stopped.status).toBe(0);
        expect(stopped.stdout).toContain("Bridge stopped");
        expect(() => process.kill(record.pid, 0)).toThrow();
      } finally {
        ctx.run("stop");
        ctx.cleanup();
      }
    }],
  });
});
