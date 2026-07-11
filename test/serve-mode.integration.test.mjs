import { feature, integration, expect } from "bdd-vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function setupCli() {
  const root = mkdtempSync(join(tmpdir(), "amux-serve-mode-"));
  const bridgeDir = join(root, "bridge");
  const binDir = join(bridgeDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const start = join(binDir, "start.sh");
  writeFileSync(start, "#!/usr/bin/env bash\necho fake-foreground-bridge\n");
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
});
