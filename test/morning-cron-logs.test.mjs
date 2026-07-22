// The HOME-root log regression gate (claw:3 cleanup finding): dream-cron,
// todo-remind-cron and morning-digest-cron must write their internal logs
// under $HOME/.cache even with default env — a crontab redirect alone does
// not stop the script-internal default from recreating $HOME/agentmux-*.log.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, chmodSync, mkdirSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const setup = () => {
  const home = mkdtempSync(join(tmpdir(), "amux-home-"));
  // Stub node so agent-cli invocations succeed without a real fleet.
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const node = join(bin, "node");
  writeFileSync(node, "#!/usr/bin/env bash\necho stub-ok\nexit 0\n");
  chmodSync(node, 0o755);
  return { home, node };
};

const rootLogs = (home) => readdirSync(home)
  .filter((name) => name.startsWith("agentmux-") && name.endsWith(".log"));

describe("cron scripts never write logs to the HOME root", () => {
  let fx;
  beforeEach(() => { fx = setup(); });
  afterEach(() => { rmSync(fx.home, { recursive: true, force: true }); });

  const run = (script, extraEnv = {}) => spawnSync("bash", [join(REPO, "bin", script)], {
    encoding: "utf-8",
    env: { PATH: "/usr/bin:/bin", HOME: fx.home, NODE_BIN: fx.node, ...extraEnv },
  });

  it("todo-remind-cron logs under .cache (skip path, no tasks file)", () => {
    const result = run("todo-remind-cron.sh");
    expect(result.status).toBe(0);
    expect(rootLogs(fx.home)).toEqual([]);
    expect(existsSync(join(fx.home, ".cache", "agentmux-todo-remind.log"))).toBe(true);
  });

  it("dream-cron's canonical log default lives under .cache (text pin)", () => {
    // dream-cron does real multi-pane work even against stubs, so the
    // default is pinned at text level: the internal log path must be
    // .cache-based WITH its mkdir, or the next 04:00 recreates the
    // HOME-root file no matter what the crontab redirect says.
    const script = readFileSync(join(REPO, "bin", "dream-cron.sh"), "utf-8");
    expect(script).toContain('AGENTMUX_DREAM_LOG:-$HOME/.cache/agentmux-dream.log');
    expect(script).toMatch(/mkdir -p "\$\(dirname "\$AGENTMUX_DREAM_LOG"\)"/u);
    expect(script).not.toContain("$HOME/agentmux-dream.log");
    expect(script).toContain('export PATH="$HOME/.local/bin:/usr/bin:/bin:${PATH:-}"');
  });

  it("dream failure still invokes the independent incremental search refresh", () => {
    const calls = join(fx.home, "node-calls.log");
    writeFileSync(fx.node, [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$CALLS"',
      'case "$*" in *" dream "*) exit 1;; esac',
      "exit 0",
      "",
    ].join("\n"));
    const result = run("dream-cron.sh", {
      CALLS: calls,
      AGENTMUX_DREAM_LOG: join(fx.home, "dream.log"),
      OPENCLAW_WORKSPACE: join(fx.home, "workspace"),
    });
    expect(result.status).not.toBe(0);
    const invoked = readFileSync(calls, "utf8");
    expect(invoked).toContain("search --reindex");
    expect(invoked.indexOf("search --reindex")).toBeGreaterThan(invoked.indexOf("dream --quiet"));
  });

  it("morning-digest-cron logs under .cache", () => {
    const result = run("morning-digest-cron.sh");
    expect(result.status).toBe(0);
    expect(rootLogs(fx.home)).toEqual([]);
    expect(existsSync(join(fx.home, ".cache", "agentmux-morning-digest.log"))).toBe(true);
  });

  it("the installer refuses a dangling entry", () => {
    const copyDir = join(fx.home, "loose-bin");
    mkdirSync(copyDir, { recursive: true });
    const copy = join(copyDir, "install-morning-digest.sh");
    writeFileSync(copy, readFileSync(join(REPO, "bin", "install-morning-digest.sh"), "utf-8"));
    chmodSync(copy, 0o755);
    const refused = spawnSync("bash", [copy], { encoding: "utf-8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("refusing to install");
  });
});
