// Hermetic tests for fleet-progress-cron.sh sweep D (starvation watchdog):
// READY >= 1 with zero in_progress must nudge the broker after STARVE_SWEEPS
// consecutive hits, escalate to the human on the 2nd nudge, respect a
// dispatch-hold (auto-expiring), reset on recovery, and never fire on an
// unreachable board. No real amux, no real board, no real tmux server.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, execSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync, utimesSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "bin", "fleet-progress-cron.sh");

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "starve-sweep-"));
  const watchDir = join(root, "watch");
  const repoDir = join(root, "repo");
  mkdirSync(watchDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  execSync(
    "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base",
    { cwd: repoDir },
  );
  const amuxLog = join(root, "amux-calls");
  const amux = join(root, "amux");
  // One CALL line per invocation regardless of newlines in the message.
  writeFileSync(amux, `#!/usr/bin/env bash
args="$*"
echo "CALL \${args//$'\\n'/ }" >> "${amuxLog}"
exit 0
`);
  chmodSync(amux, 0o755);
  const tokenFile = join(root, "read-token");
  writeFileSync(tokenFile, "test-token-test-token-test-token-1234\n");
  const conf = join(root, "fleets.conf");
  writeFileSync(conf, `ghost 2 ${repoDir} testproj\n`);
  return { root, watchDir, repoDir, amux, amuxLog, tokenFile, conf };
};

// The board double: serves {counts: ...} and records the requests it saw.
const boardServer = async (counts) => {
  const seen = [];
  const state = { counts, tickets: [] };
  const server = createServer((req, res) => {
    seen.push({ url: req.url, ua: req.headers["user-agent"], auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ tickets: state.tickets, counts: state.counts, total: state.tickets.length }));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, seen, state, port: server.address().port };
};

// Async spawn: spawnSync would block the event loop and starve the in-process
// board server (same lesson as the board-curator tests).
const run = (fx, extraEnv = {}) => new Promise((ok, bad) => {
  let stdout = "";
  const child = spawn("bash", [SCRIPT], { env: {
    ...process.env,
    WATCH_DIR: fx.watchDir,
    CONF: fx.conf,
    AMUX: fx.amux,
    QUEUE_DIR: join(fx.root, "no-queue"),      // absent → queue sweep skipped
    GH: "/nonexistent-gh",                     // review-queue sweep skipped
    TMUX_SOCKET: join(fx.root, "no-tmux.sock"),// no server → fleet sweep skips panes
    READ_TOKEN_FILE: fx.tokenFile,
    STARVE_SWEEPS: "2",
    STARVE_COOLDOWN_MIN: "60",
    SEND_TIMEOUT: "5",
    ...extraEnv,
  } });
  child.stdout.on("data", (d) => { stdout += d; });
  child.on("exit", () => ok(stdout));
  child.on("error", bad);
});

const amuxCalls = (fx) => existsSync(fx.amuxLog)
  ? readFileSync(fx.amuxLog, "utf-8").split("\n").filter((line) => line.startsWith("CALL ")) : [];
const stateFile = (fx) => join(fx.watchDir, "starve-ghost.state");

describe("fleet starvation sweep (D)", () => {
  let fx, board;
  beforeEach(async () => {
    fx = setup();
    board = await boardServer({ ready: 24, in_progress: 0 });
  });
  afterEach(() => {
    board.server.close();
    rmSync(fx.root, { recursive: true, force: true });
  });
  const env = (extra = {}) => ({ BOARD_URL: `http://127.0.0.1:${board.port}`, ...extra });

  it("does not nudge on the first starving sweep, nudges the broker on the second", async () => {
    const first = await run(fx, env());
    expect(first).toContain("candidate (ready=24 in_progress=0, sweep 1/2)");
    expect(amuxCalls(fx)).toHaveLength(0);

    const second = await run(fx, env());
    expect(second).toContain("NUDGED (ready=24)");
    const calls = amuxCalls(fx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("ghost -p 2");
    expect(calls[0]).toContain("SVÄLT");
    expect(calls[0]).toContain("Dispatch-first");
  });

  it("identifies with a User-Agent and the read token against the board", async () => {
    await run(fx, env());
    expect(board.seen.length).toBeGreaterThan(0);
    expect(board.seen[0].ua).toContain("amux-fleet-watch");
    expect(board.seen[0].auth).toContain("Bearer test-token");
    expect(board.seen[0].url).toContain("project=testproj");
  });

  it("escalates to the human on the second nudge", async () => {
    await run(fx, env());
    await run(fx, env());                                      // nudge #1
    // Age the recorded nudge past the cooldown so the next sweep may re-nudge.
    const [hits, , nudges] = readFileSync(stateFile(fx), "utf-8").trim().split(" ");
    writeFileSync(stateFile(fx), `${hits} 1 ${nudges}`);
    const third = await run(fx, env());                        // nudge #2 + escalation
    expect(third).toContain("ESCALATED");
    const calls = amuxCalls(fx);
    expect(calls.some((c) => c.includes("notifyuser") && c.includes("SVÄLTER fortfarande"))).toBe(true);
  });

  it("stays silent within the cooldown after a nudge", async () => {
    await run(fx, env());
    await run(fx, env());                                      // nudge #1 stamps now
    const third = await run(fx, env());
    expect(third).toContain("in cooldown → skip");
    expect(amuxCalls(fx)).toHaveLength(1);
  });

  it("resets the counter the moment work is in progress again", async () => {
    await run(fx, env());
    expect(existsSync(stateFile(fx))).toBe(true);
    board.state.counts = { ready: 23, in_progress: 1 };
    const recovered = await run(fx, env());
    expect(recovered).toContain("recovered (ready=23 in_progress=1) → reset");
    expect(existsSync(stateFile(fx))).toBe(false);
    expect(amuxCalls(fx)).toHaveLength(0);
  });

  it("honors a fresh dispatch-hold and re-arms when it expires", async () => {
    await run(fx, env());
    const hold = join(fx.watchDir, "ghost.dispatch-hold");
    writeFileSync(hold, "alla workers quota-döda");
    const held = await run(fx, env());
    expect(held).toContain("dispatch-hold");
    expect(held).toContain("alla workers quota-döda");
    expect(amuxCalls(fx)).toHaveLength(0);

    const past = new Date(Date.now() - 4 * 3600 * 1000);       // > DISPATCH_HOLD_HOURS
    utimesSync(hold, past, past);
    const rearmed = await run(fx, env());
    expect(rearmed).toContain("dispatch-hold expired → re-arming");
    expect(rearmed).toContain("NUDGED");
    expect(existsSync(hold)).toBe(false);
  });

  it("handles a board response far beyond the 128KB argv cap", async () => {
    // A busy board returns full ticket texts; skydive's 64-ticket response
    // silently broke an argv-passed parse (Linux MAX_ARG_STRLEN, 2026-07-15).
    board.state.tickets = Array.from({ length: 80 }, (_, i) => ({
      id: `BIG-${i}`, raw: "x".repeat(4000),
    }));
    const out = await run(fx, env());
    expect(out).not.toContain("board unreachable");
    expect(out).toContain("candidate (ready=24 in_progress=0, sweep 1/2)");
  });

  it("skips loudly without state change when the board is unreachable", async () => {
    const out = await run(fx, { BOARD_URL: "http://127.0.0.1:9" });
    expect(out).toContain("board unreachable → skip (no state change)");
    expect(existsSync(stateFile(fx))).toBe(false);
    expect(amuxCalls(fx)).toHaveLength(0);
  });

  it("skips fleets without a board project column", async () => {
    writeFileSync(fx.conf, `ghost 2 ${fx.repoDir}\n`);
    const out = await run(fx, env());
    expect(out).toContain("no board project column → skip");
    expect(amuxCalls(fx)).toHaveLength(0);
  });
});
