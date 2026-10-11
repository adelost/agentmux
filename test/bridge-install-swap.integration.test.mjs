import { feature, integration, expect } from "bdd-vitest";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A bridge stand-in started the real way: bin/start.sh runs the real runtime
// bootstrap, then this entry. It beats like the bridge and, when asked, starts
// claude, codex and git the way bridge code does, inheriting its working directory.
const BRIDGE_ENTRY = `
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME;
mkdirSync(join(home, ".agentmux"), { recursive: true });
writeFileSync(join(home, ".agentmux", "bridge-heartbeat.json"), JSON.stringify({ ts: new Date().toISOString(), pid: process.pid }) + "\\n");
const asked = setInterval(() => {
  if (!existsSync(join(home, "go"))) return;
  clearInterval(asked);
  const run = (file, args) => {
    const result = spawnSync(file, args, { encoding: "utf8" });
    return { status: result.status, error: String(result.stderr || "").trim().split("\\n").at(-1) };
  };
  writeFileSync(join(home, "children.json"), JSON.stringify({
    claude: run("claude", ["--version"]),
    codex: run("codex", ["debug", "models"]),
    git: run("git", ["ls-remote", process.env.AMUX_TEST_REMOTE]),
  }));
}, 20);
setInterval(() => {}, 60_000);
`;

// claude and codex read their working directory first and stop when it is gone
// (measured 2026-10-11: "The current working directory was deleted" and
// "Error: No such file or directory (os error 2)"). git is the real one.
const fakeEngine = (name) => [
  "#!/bin/sh",
  `/bin/pwd -P >/dev/null 2>&1 || { echo '${name}: working directory is gone' >&2; exit 1; }`,
  "echo ok",
].join("\n");

function writePackage(dir) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(join(REPO, "bin", "start.sh"), join(dir, "bin", "start.sh"));
  writeFileSync(join(dir, "bin", "runtime-env-bootstrap.mjs"), `import ${JSON.stringify(join(REPO, "bin", "runtime-env-bootstrap.mjs"))};\n`);
  writeFileSync(join(dir, "bin", "quota-recovery-bootstrap.mjs"), "");
  writeFileSync(join(dir, "index.mjs"), BRIDGE_ENTRY);
}

async function waitFor(check, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "amux-install-swap-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const remote = join(root, "remote.git");
  const packageDir = join(root, "lib", "node_modules", "agentmux");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  for (const name of ["claude", "codex"]) writeFileSync(join(bin, name), fakeEngine(name), { mode: 0o755 });
  spawnSync("git", ["init", "-q", "--bare", remote]);
  writePackage(packageDir);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, AMUX_TEST_REMOTE: remote,
    TMUX_SOCKET: join(root, "no-tmux.sock"), AMUX_AUTO_REVIVE: "false" };
  for (const name of ["AMUX_HEARTBEAT_PATH", "AMUX_BRIDGE_MODE_FILE", "PIDFILE", "READY_FILE"]) delete env[name];
  const supervisor = spawn("bash", ["bin/start.sh"], { cwd: packageDir, env, detached: true, stdio: "ignore" });
  const cleanup = () => {
    try { process.kill(-supervisor.pid, "SIGKILL"); } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { root, home, env, packageDir, supervisor, cleanup };
}

feature("a CLI-only release install while the bridge runs", () => {
  integration("the bridge still starts claude, codex and git, and doctor and the watchdog still know it", {
    given: ["a supervised bridge running from its package directory", setup],
    when: ["npm replaces the package directory, then the bridge starts programs and is checked", async (ctx) => {
      const beatPath = join(ctx.home, ".agentmux", "bridge-heartbeat.json");
      const bridgePid = await waitFor(() => existsSync(beatPath) && JSON.parse(readFileSync(beatPath, "utf8")).pid, "the bridge heartbeat");
      // What `npm install --global` does: rename the old package away, install the new one, delete the old.
      const retired = join(dirname(ctx.packageDir), ".agentmux-ZTspAblB");
      renameSync(ctx.packageDir, retired);
      writePackage(ctx.packageDir);
      rmSync(retired, { recursive: true, force: true });

      writeFileSync(join(ctx.home, "go"), "");
      const children = await waitFor(() => existsSync(join(ctx.home, "children.json"))
        && JSON.parse(readFileSync(join(ctx.home, "children.json"), "utf8")), "the bridge's children");

      const doctor = spawnSync(process.execPath, [join(REPO, "bin", "agent-cli.mjs"), "doctor"], { env: ctx.env, encoding: "utf8" });
      const bridgeLine = doctor.stdout.split("\n").find((line) => line.includes("bridge process")) || "";

      // A beat older than five minutes from a live pid is a hung bridge: the watchdog must name it.
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(beatPath, old, old);
      spawnSync("bash", [join(REPO, "bin", "bridge-watchdog-cron.sh")], { env: ctx.env, encoding: "utf8" });
      const watchdogLog = existsSync(join(ctx.home, ".agentmux", "watchdog.log"))
        ? readFileSync(join(ctx.home, ".agentmux", "watchdog.log"), "utf8") : "";
      return { bridgePid, children, bridgeLine, watchdogLog };
    }],
    then: ["every program starts, doctor names the supervised bridge, the watchdog acts on it", ({ bridgePid, children, bridgeLine, watchdogLog }, ctx) => {
      try {
        expect({
          children,
          doctor: bridgeLine.replace(/^.*bridge process\s+/u, "").trim(),
          watchdog: watchdogLog.trim().split("\n").at(-1).replace(/^\[[^\]]+\] /u, "").replace(/\(beat \d+s old\)/u, "(beat old)"),
        }).toEqual({
          children: { claude: { status: 0, error: "" }, codex: { status: 0, error: "" }, git: { status: 0, error: "" } },
          doctor: `pid ${bridgePid}, supervised by start.sh`,
          watchdog: `HUNG bridge pid(s) ${bridgePid} (beat old) -> kill -9 (supervisor restarts)`,
        });
      } finally { ctx.cleanup(); }
    }],
  });
});
