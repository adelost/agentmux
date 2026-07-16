// Hermetic gate for fleet-progress-cron.sh sweep A (broker self-snooze).
//
// The snooze is the only sanctioned way for a broker to answer "nothing READY"
// (.OFF is permanent and human-only). A broker must be ACTIVE to touch it, and
// that activity freshens its session jsonl — so the moment jsonl freshness
// counts as "progress", the next sweep deletes the snooze the broker just set
// and re-nudges an hour later, forever (api:2, 2026-07-15: snooze set 18:05,
// deleted 18:20 by "OK (framdrift 11min sedan)", NUDGED again 21:00).
//
// jsonl mtime is a LIVENESS signal (used correctly to never interrupt a broker
// mid-turn). Progress is a COMMIT — this sweep is named fleet-progress and its
// own nudge text says "Inga commits i X".
//
// Real tmux on a throwaway socket, real git repo, temp HOME. No real amux.
import { feature, integration, expect } from "bdd-vitest";
import { spawn, execSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "bin", "fleet-progress-cron.sh");
const MINUTE_MS = 60_000;

// A broker that chattered this long ago is idle enough to be swept (past
// ACTIVE_SEC=150s "mid-turn, never interrupt") but still inside STALE_MIN=60,
// so the sweep takes its "progress" branch — exactly where the snooze died.
const BROKER_CHATTER_AGE_MIN = 10;

const ageStamp = (minutes) => new Date(Date.now() - minutes * MINUTE_MS);

const setup = ({ lastCommitAgeMin, brokerChatterAgeMin = BROKER_CHATTER_AGE_MIN }) => {
  const root = mkdtempSync(join(tmpdir(), "snooze-sweep-"));
  const home = join(root, "home");
  const watchDir = join(root, "watch");
  const repoDir = join(root, "repo");
  const socket = join(root, "tmux.sock");
  for (const d of [home, watchDir, repoDir, join(home, ".agentmux", "guard-heartbeats")]) {
    mkdirSync(d, { recursive: true });
  }

  const committedAt = ageStamp(lastCommitAgeMin).toISOString();
  execSync("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base", {
    cwd: repoDir,
    env: { ...process.env, GIT_AUTHOR_DATE: committedAt, GIT_COMMITTER_DATE: committedAt },
  });

  // The pane's cwd resolves to the session-jsonl dir: cwd → slug ('/' and '.'
  // → '-') → $HOME/.claude/projects/<slug>/*.jsonl.
  execSync(`tmux -S '${socket}' new-session -d -s ghost -c '${repoDir}'`);
  const projects = join(home, ".claude", "projects", repoDir.replace(/[/.]/g, "-"));
  mkdirSync(projects, { recursive: true });
  const jsonl = join(projects, "session.jsonl");
  writeFileSync(jsonl, "{}\n");
  const chatteredAt = ageStamp(brokerChatterAgeMin);
  utimesSync(jsonl, chatteredAt, chatteredAt);

  const amuxLog = join(root, "amux-calls");
  const amux = join(root, "amux");
  writeFileSync(amux, `#!/usr/bin/env bash\necho "CALL $*" >> "${amuxLog}"\nexit 0\n`);
  chmodSync(amux, 0o755);

  const boardState = join(root, "board.json");
  writeFileSync(boardState, JSON.stringify({ counts: { deferred: 8, done: 109 } }));
  const curl = join(root, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash\ncat "${boardState}"\n`);
  chmodSync(curl, 0o755);
  const tokenFile = join(root, "read-token");
  writeFileSync(tokenFile, "test-token-test-token-test-token-1234\n");

  const conf = join(root, "fleets.conf");
  writeFileSync(conf, `ghost 0 ${repoDir} testproj\n`);

  const snooze = join(watchDir, "ghost.snooze");
  writeFileSync(snooze, "");

  return {
    root, home, watchDir, repoDir, socket, conf, amux, amuxLog,
    boardState, curl, tokenFile, snooze,
  };
};

const teardown = (fx) => {
  try { execSync(`tmux -S '${fx.socket}' kill-server`, { stdio: "ignore" }); } catch { /* already gone */ }
  rmSync(fx.root, { recursive: true, force: true });
};

const runSweep = (fx) => new Promise((ok, bad) => {
  let stdout = "";
  const child = spawn("bash", [SCRIPT], {
    env: {
      ...process.env,
      HOME: fx.home,
      NODE_BIN: process.execPath,               // script resets PATH off the temp HOME
      WATCH_DIR: fx.watchDir,
      CONF: fx.conf,
      AMUX: fx.amux,
      CURL: fx.curl,
      BOARD_URL: "http://board.test",
      READ_TOKEN_FILE: fx.tokenFile,
      TMUX_SOCKET: fx.socket,
      QUEUE_DIR: join(fx.root, "no-queue"),     // absent → queue sweep skipped
      GH: "/nonexistent-gh",                    // review-queue sweep skipped
      SEND_TIMEOUT: "5",
    },
  });
  child.stdout.on("data", (d) => { stdout += d; });
  child.on("exit", () => ok(stdout));
  child.on("error", bad);
});

feature("fleet-watch broker self-snooze", () => {
  integration("survives a sweep where the broker only chattered and never committed", {
    given: ["a snoozed fleet whose broker answered the nudge but shipped no commit", () =>
      setup({ lastCommitAgeMin: 300 })],
    when: ["the next sweep runs while that answer is still fresh", async (fx) => {
      const stdout = await runSweep(fx);
      return { stdout, snoozeSurvived: existsSync(fx.snooze) };
    }],
    then: ["the snooze the broker just set is still standing", ({ stdout, snoozeSurvived }, fx) => {
      expect(stdout).toContain("ghost:0");
      expect(snoozeSurvived).toBe(true);
      teardown(fx);
    }],
  });

  integration("is cleared once the fleet actually commits", {
    given: ["a snoozed fleet that has just landed real work", () =>
      setup({ lastCommitAgeMin: 1 })],
    when: ["the next sweep runs", async (fx) => {
      const stdout = await runSweep(fx);
      return { stdout, snoozeSurvived: existsSync(fx.snooze) };
    }],
    then: ["the stale snooze is dropped so the watch re-arms", ({ stdout, snoozeSurvived }, fx) => {
      expect(stdout).toContain("framdrift");
      expect(snoozeSurvived).toBe(false);
      teardown(fx);
    }],
  });

  integration("never wakes an idle broker for a deferred and terminal-only board", {
    given: ["a stale fleet whose board has no unfinished tickets", () =>
      setup({ lastCommitAgeMin: 300, brokerChatterAgeMin: 300 })],
    when: ["the quiet-fleet sweep runs", async (fx) => {
      rmSync(fx.snooze);
      const stdout = await runSweep(fx);
      const calls = existsSync(fx.amuxLog) ? readFileSync(fx.amuxLog, "utf-8") : "";
      return { stdout, calls };
    }],
    then: ["the board truth suppresses both broker and human messages", ({ stdout, calls }, fx) => {
      expect(stdout).toContain("zero unfinished board tickets → silent");
      expect(calls).toBe("");
      teardown(fx);
    }],
  });

  integration("still wakes a stale broker when the board has executable work", {
    given: ["a stale fleet with one READY ticket", () => {
      const fx = setup({ lastCommitAgeMin: 300, brokerChatterAgeMin: 300 });
      rmSync(fx.snooze);
      writeFileSync(fx.boardState, JSON.stringify({ counts: { ready: 1 } }));
      return fx;
    }],
    when: ["the quiet-fleet sweep runs", async (fx) => {
      const stdout = await runSweep(fx);
      const calls = existsSync(fx.amuxLog) ? readFileSync(fx.amuxLog, "utf-8") : "";
      return { stdout, calls };
    }],
    then: ["the broker receives one board-grounded typed-deferral brief", ({ stdout, calls }, fx) => {
      expect(stdout).toContain("NUDGED");
      expect(calls).toContain("TYPAD deferral");
      expect(calls).toContain("human_decision");
      teardown(fx);
    }],
  });
});
