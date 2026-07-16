// Hermetic tests for bin/board-curator-cron.sh (PR #16 review findings):
// bootstrap must baseline WITHOUT a brief, a brief fires only on real motion,
// an unchanged fingerprint is silent, an unverified send must NOT stamp, and
// the next run after a failed send retries and recovers. No real amux, no
// real board, no real crontab.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync, execSync } from "child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, mkdirSync } from "fs";
import { createServer } from "http";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "bin", "board-curator-cron.sh");

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "board-curator-"));
  const watchDir = join(root, "watch");
  const repoDir = join(root, "repo");
  mkdirSync(watchDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  execSync(
    "git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base",
    { cwd: repoDir },
  );
  const amuxLog = join(root, "amux-calls");
  const amuxMode = join(root, "amux-mode");
  const amux = join(root, "amux");
  // One CALL line per invocation regardless of newlines in the message.
  writeFileSync(amux, `#!/usr/bin/env bash
args="$*"
echo "CALL \${args//$'\\n'/ }" >> "${amuxLog}"
[ -f "${amuxMode}" ] && exit 1
exit 0
`);
  chmodSync(amux, 0o755);
  const boardState = join(root, "board-state.json");
  writeFileSync(boardState, JSON.stringify({ total: 1, counts: { ready: 1 } }));
  const curl = join(root, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash
cat "${boardState}"
`);
  chmodSync(curl, 0o755);
  const failingCurl = join(root, "curl-fail");
  writeFileSync(failingCurl, "#!/usr/bin/env bash\nexit 22\n");
  chmodSync(failingCurl, 0o755);
  const tokenFile = join(root, "read-token");
  writeFileSync(tokenFile, "test-token-test-token-test-token-1234\n");
  const conf = join(root, "fleets.conf");
  writeFileSync(conf, `ghost 2 ${repoDir} testproj\n`);
  return {
    root, watchDir, repoDir, amux, amuxLog, amuxMode,
    boardState, curl, failingCurl, tokenFile, conf,
  };
};

const run = (fx, extraEnv = {}) => spawnSync("bash", [SCRIPT], {
  encoding: "utf-8",
  env: {
    ...process.env,
    WATCH_DIR: fx.watchDir,
    CONF: fx.conf,
    AMUX: fx.amux,
    CURL: fx.curl,
    AMUX_GUARD_HEARTBEAT_DIR: join(fx.root, "heartbeats"),
    READ_TOKEN_FILE: fx.tokenFile,
    BOARD_URL: "http://board.test",
    CURATE_COOLDOWN_MIN: "0",
    SEND_TIMEOUT: "5",
    ...extraEnv,
  },
});

const amuxCalls = (fx) => existsSync(fx.amuxLog)
  ? readFileSync(fx.amuxLog, "utf-8").split("\n").filter((line) => line.startsWith("CALL ")) : [];
const commit = (fx, msg) => execSync(
  `git -c user.email=t@t -c user.name=t commit -q --allow-empty -m ${msg}`,
  { cwd: fx.repoDir },
);
const setBoard = (fx, counts) => writeFileSync(
  fx.boardState, JSON.stringify({ total: Object.values(counts).reduce((sum, value) => sum + value, 0), counts }),
);

describe("board-curator cron", () => {
  let fx;
  beforeEach(() => { fx = setup(); });
  afterEach(() => { rmSync(fx.root, { recursive: true, force: true }); });

  it("bootstraps a baseline without sending a brief", () => {
    const first = run(fx);
    expect(first.stdout).toContain("baseline established");
    expect(amuxCalls(fx)).toHaveLength(0);
    expect(existsSync(join(fx.watchDir, "ghost.curated"))).toBe(true);
  });

  it("stays silent while the fingerprint is unchanged", () => {
    run(fx);
    const second = run(fx);
    expect(second.stdout).toContain("no motion since last pass");
    expect(amuxCalls(fx)).toHaveLength(0);
  });

  it("does not wake a broker for repo-only motion", () => {
    run(fx);
    commit(fx, "work");
    const second = run(fx);
    expect(second.stdout).toContain("no motion");
    expect(amuxCalls(fx)).toHaveLength(0);
  });

  it("sends exactly one brief on actionable board motion, then goes silent again", () => {
    run(fx);
    setBoard(fx, { ready: 2 });
    const third = run(fx);
    expect(third.stdout).toContain("CURATION BRIEF SENT");
    const calls = amuxCalls(fx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("ghost -p 2");
    expect(calls[0]).toContain("KURATORSPASS");
    const fourth = run(fx);
    expect(fourth.stdout).toContain("no motion");
    expect(amuxCalls(fx)).toHaveLength(1);
  });

  it("does NOT stamp an unverified send and retries next run", () => {
    run(fx);
    const stampBefore = readFileSync(join(fx.watchDir, "ghost.curated"), "utf-8");
    setBoard(fx, { ready: 2 });
    writeFileSync(fx.amuxMode, "fail");
    const failed = run(fx);
    expect(failed.stdout).toContain("NOT stamped");
    expect(readFileSync(join(fx.watchDir, "ghost.curated"), "utf-8")).toBe(stampBefore);

    rmSync(fx.amuxMode);
    const recovered = run(fx);
    expect(recovered.stdout).toContain("CURATION BRIEF SENT");
    expect(amuxCalls(fx)).toHaveLength(2);
    expect(readFileSync(join(fx.watchDir, "ghost.curated"), "utf-8")).not.toBe(stampBefore);
  });

  it("stays silent and unstamped when the board is unreachable", () => {
    const first = run(fx, { CURL: fx.failingCurl });
    expect(first.stdout).toContain("board unreachable → silent");
    expect(existsSync(join(fx.watchDir, "ghost.curated"))).toBe(false);
    expect(amuxCalls(fx)).toHaveLength(0);
  });

  it("treats deferred and terminal-only boards as settled", () => {
    setBoard(fx, { deferred: 8, done: 109 });
    const first = run(fx);
    expect(first.stdout).toContain("zero actionable tickets → silent");
    expect(amuxCalls(fx)).toHaveLength(0);
    commit(fx, "unrelated-repo-motion");
    const second = run(fx);
    expect(second.stdout).toContain("zero actionable tickets → silent");
    expect(amuxCalls(fx)).toHaveLength(0);
  });

  it("includes board counts in the fingerprint and identifies with a User-Agent", async () => {
    let seenUa = null;
    let seenUrl = null;
    const server = createServer((req, res) => {
      seenUa = req.headers["user-agent"];
      seenUrl = req.url;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ total: 7, counts: { ready: 3, done: 4 } }));
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    const port = server.address().port;
    try {
      // Async spawn: spawnSync would block the event loop, so this in-process
      // server could never answer curl (observed as a 20s hang + empty board).
      await new Promise((ok, bad) => {
        const child = spawn("bash", [SCRIPT], { env: {
          ...process.env, WATCH_DIR: fx.watchDir, CONF: fx.conf, AMUX: fx.amux,
          CURL: "curl",
          AMUX_GUARD_HEARTBEAT_DIR: join(fx.root, "heartbeats"),
          READ_TOKEN_FILE: fx.tokenFile, BOARD_URL: `http://127.0.0.1:${port}`,
          CURATE_COOLDOWN_MIN: "0", SEND_TIMEOUT: "5",
        } });
        child.on("exit", ok);
        child.on("error", bad);
      });
      const stamp = readFileSync(join(fx.watchDir, "ghost.curated"), "utf-8");
      expect(stamp).toContain('board:3 {"in_progress": 0, "needs_detail": 0, "ready": 3, "triaging": 0}');
      expect(seenUa).toContain("amux-board-curator");
      expect(seenUrl).toBe("/api/tickets/summary?project=testproj");
    } finally {
      server.close();
    }
  });

  it("skips fleets without a board project column", () => {
    writeFileSync(fx.conf, `ghost 2 ${fx.repoDir}\n`);
    const result = run(fx);
    expect(result.stdout).toContain("no board project column → skip");
    expect(existsSync(join(fx.watchDir, "ghost.curated"))).toBe(false);
  });

  it("installer refuses a dangling entry and is idempotent-checkable", () => {
    // Refusal path only — never touch the real crontab from a test.
    const fakeDir = join(fx.root, "fake-checkout", "bin");
    mkdirSync(fakeDir, { recursive: true });
    const installer = readFileSync(join(REPO, "bin", "install-board-curator.sh"), "utf-8");
    const copy = join(fakeDir, "install-board-curator.sh");
    writeFileSync(copy, installer);
    chmodSync(copy, 0o755);
    const refused = spawnSync("bash", [copy], { encoding: "utf-8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("refusing to install");
  });
});
