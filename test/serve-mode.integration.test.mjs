import { feature, integration, expect } from "bdd-vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawn, spawnSync } from "child_process";
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
cleanup() { sleep "\${FAKE_STOP_DELAY:-0}"; rm -f "$PIDFILE" "$READY_FILE"; exit 0; }
trap cleanup TERM INT
if [[ -n "\${AMUX_TEST_ENV_CAPTURE:-}" ]]; then
  printf 'TMUX=%s\\nTMUX_PANE=%s\\n' "\${TMUX-}" "\${TMUX_PANE-}" > "$AMUX_TEST_ENV_CAPTURE"
fi
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
  return { root, env, run, bridgeDir, start, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return false;
};

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
      const inheritedEnvironment = join(ctx.root, "detached-environment");
      ctx.env.TMUX = "/tmp/caller-tmux.sock,123,0";
      ctx.env.TMUX_PANE = "%42";
      ctx.env.AMUX_TEST_ENV_CAPTURE = inheritedEnvironment;
      const started = ctx.run("serve", "--detach");
      const record = JSON.parse(readFileSync(join(ctx.env.AMUX_BRIDGE_SERVICE_DIR, "process.json"), "utf8"));
      const readyPid = Number(readFileSync(ctx.env.READY_FILE, "utf8").trim());
      const detachedEnvironment = readFileSync(inheritedEnvironment, "utf8");
      const stopped = ctx.run("stop");
      return { ctx, started, stopped, record, readyPid, detachedEnvironment };
    }],
    then: ["the owned supervisor drops caller tmux identity and stop removes it", ({
      ctx, started, stopped, record, readyPid, detachedEnvironment,
    }) => {
      try {
        expect(started.status).toBe(0);
        expect(started.stdout).toContain("managed supervisor pid");
        expect(started.stdout).toContain("no tmux");
        expect(detachedEnvironment).toBe("TMUX=\nTMUX_PANE=\n");
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

  integration("manual stop completes before an immediate managed replacement can publish readiness", {
    given: ["a manual supervisor whose shutdown hook is deliberately slow", () => setupCli({ managed: true })],
    when: ["stopping manual ownership and immediately starting managed ownership", async (ctx) => {
      try {
        const manual = spawn("bash", [ctx.start], {
          cwd: ctx.bridgeDir,
          detached: true,
          stdio: "ignore",
          env: { ...ctx.env, FAKE_STOP_DELAY: "0.6" },
        });
        manual.unref();
        expect(await waitFor(() => existsSync(ctx.env.READY_FILE))).toBe(true);
        const stopped = ctx.run("stop");
        if (stopped.status !== 0) throw new Error(`manual stop failed: ${stopped.stderr || stopped.stdout}`);
        const restarted = ctx.run("serve", "--detach");
        await new Promise((resolveWait) => setTimeout(resolveWait, 800));
        const readinessSurvived = existsSync(ctx.env.READY_FILE);
        const finalStop = ctx.run("stop");
        return { ctx, stopped, restarted, readinessSurvived, finalStop };
      } catch (error) {
        ctx.run("stop");
        ctx.cleanup();
        throw error;
      }
    }],
    then: ["the old hook cannot erase the replacement sentinels", ({
      ctx, stopped, restarted, readinessSurvived, finalStop,
    }) => {
      try {
        expect({ status: stopped.status, stdout: stopped.stdout, stderr: stopped.stderr })
          .toMatchObject({ status: 0 });
        expect({ status: restarted.status, stdout: restarted.stdout, stderr: restarted.stderr })
          .toMatchObject({ status: 0 });
        expect(restarted.stdout).toContain("managed supervisor pid");
        expect(readinessSurvived).toBe(true);
        expect(finalStop.status).toBe(0);
      } finally { ctx.cleanup(); }
    }],
  });
});
