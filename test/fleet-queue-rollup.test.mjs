// Hermetic tests for fleet-progress-cron.sh sweep B rollup (SRC-0053 B):
// N wedged delivery jobs must produce ONE notify per sweep (count + oldest +
// bounded ids), the batch is marked alerted only after a successful notify,
// an already-alerted job stays silent, and DRY mutates nothing. No real amux,
// no real queue, no tmux server.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, execSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "bin", "fleet-progress-cron.sh");

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "queue-rollup-"));
  const watchDir = join(root, "watch");
  const queueDir = join(root, "queue", "skydive--p2");
  mkdirSync(watchDir, { recursive: true });
  mkdirSync(queueDir, { recursive: true });
  const amuxLog = join(root, "amux-calls");
  const amuxMode = join(root, "amux-mode");
  const amux = join(root, "amux");
  writeFileSync(amux, `#!/usr/bin/env bash
args="$*"
echo "CALL \${args//$'\\n'/ }" >> "${amuxLog}"
[ -f "${amuxMode}" ] && exit 1
exit 0
`);
  chmodSync(amux, 0o755);
  return { root, watchDir, queueDir: join(root, "queue"), paneDir: queueDir, amux, amuxLog, amuxMode };
};

const wedgeJob = (fx, id, ageMin) => writeFileSync(join(fx.paneDir, `${id}.json`), JSON.stringify({
  status: "pending",
  agentName: "skydive",
  pane: 2,
  text: `brief ${id}`,
  createdAt: Date.now() - ageMin * 60_000,
}));

const run = (fx, extraEnv = {}) => new Promise((ok, bad) => {
  let stdout = "";
  const child = spawn("bash", [SCRIPT], { env: {
    ...process.env,
    WATCH_DIR: fx.watchDir,
    CONF: join(fx.root, "missing-fleets.conf"),   // fleet/review/starvation sweeps skip
    AMUX: fx.amux,
    QUEUE_DIR: fx.queueDir,
    TMUX_SOCKET: join(fx.root, "no-tmux.sock"),
    STUCK_MIN: "60",
    SEND_TIMEOUT: "5",
    ...extraEnv,
  } });
  child.stdout.on("data", (d) => { stdout += d; });
  child.on("exit", () => ok(stdout));
  child.on("error", bad);
});

const notifyCalls = (fx) => existsSync(fx.amuxLog)
  ? readFileSync(fx.amuxLog, "utf-8").split("\n").filter((line) => line.startsWith("CALL notifyuser")) : [];
const qstate = (fx) => existsSync(join(fx.watchDir, "queue-warned.state"))
  ? readFileSync(join(fx.watchDir, "queue-warned.state"), "utf-8").split("\n").filter(Boolean) : [];

describe("fleet queue-sweep rollup", () => {
  let fx;
  beforeEach(() => { fx = setup(); });
  afterEach(() => { rmSync(fx.root, { recursive: true, force: true }); });

  it("rolls five wedged jobs into ONE notify with count, oldest and bounded ids", async () => {
    for (let i = 1; i <= 5; i++) wedgeJob(fx, `job-${i}000000000`, 60 + i * 10);
    const out = await run(fx);
    const calls = notifyCalls(fx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("5 leveranskö-jobb fasta");
    expect(calls[0]).toContain("äldst 110min");
    expect(calls[0]).toContain("(+2 till)");
    expect(qstate(fx)).toHaveLength(5);
    expect(out).toMatch(/STUCK skydive:2 job-1/);
  });

  it("stays silent for already-alerted jobs and only notifies genuinely new ones", async () => {
    wedgeJob(fx, "job-a000000000", 90);
    await run(fx);
    wedgeJob(fx, "job-b000000000", 70);
    const second = await run(fx);
    const calls = notifyCalls(fx);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("1 leveranskö-jobb fasta");
    expect(second).toContain("job-a000000000 still stuck");
  });

  it("does NOT mark the batch when the notify fails, and retries next sweep", async () => {
    wedgeJob(fx, "job-c000000000", 80);
    writeFileSync(fx.amuxMode, "fail");
    const failed = await run(fx);
    expect(failed).toContain("rollup notify failed → NOT marked");
    expect(qstate(fx)).toHaveLength(0);

    rmSync(fx.amuxMode);
    await run(fx);
    expect(qstate(fx)).toEqual(["job-c000000000"]);
    expect(notifyCalls(fx)).toHaveLength(2);
  });

  it("DRY logs the rollup without notifying or mutating state", async () => {
    wedgeJob(fx, "job-d000000000", 75);
    const out = await run(fx, { DRY: "1" });
    expect(out).toContain("DRY would notify rollup (1 nya, äldst 75min)");
    expect(notifyCalls(fx)).toHaveLength(0);
    expect(qstate(fx)).toHaveLength(0);
  });
});
