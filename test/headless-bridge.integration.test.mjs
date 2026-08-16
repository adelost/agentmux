import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "..");
const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return false;
};

describe("local bridge without Discord", () => {
  it("starts the singleton queue broker and publishes readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-headless-bridge-"));
    const home = join(root, "home");
    const configHome = join(home, ".agentmux");
    mkdirSync(configHome, { recursive: true });
    const sourcePath = join(configHome, "agentmux.yaml");
    const generatedPath = join(configHome, "agents.yaml");
    const pidPath = join(root, "bridge.pid");
    const readyPath = join(root, "bridge.ready");
    writeFileSync(sourcePath, "agents: {}\n");
    const env = {
      ...process.env,
      HOME: home,
      AGENTMUX_YAML: sourcePath,
      AGENTS_YAML: generatedPath,
      PIDFILE: pidPath,
      READY_FILE: readyPath,
      STATE_FILE: join(root, "state.json"),
      AMUX_HEARTBEAT_PATH: join(root, "heartbeat.json"),
      AMUX_MEMORY_GUARD_PATH: join(root, "memory.json"),
      AMUX_PANE_SLEEP_ENABLED: "false",
    };
    for (const key of ["DISCORD_TOKEN", "AMUX_DISCORD_ENV", "AGENT_CONFIG"]) delete env[key];
    let output = "";
    const child = spawn(process.execPath, [join(repo, "index.mjs")], { cwd: repo, env });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    try {
      expect(await waitFor(() => existsSync(readyPath) && output.includes("local bridge")), output)
        .toBe(true);
      expect(child.exitCode).toBeNull();
    }
    finally {
      child.kill("SIGTERM");
      await new Promise((done) => child.once("exit", done));
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
