// THE CLASS GATE (SRC-0071 criteria 3 + 7).
//
// Three separate tools died the same death inside 24h: the cron environment
// differs from the interactive one, each tool rediscovered it alone, and every
// time it silently dropped data for hours first.
//   1. fleet-progress-cron: bare `tmux` → wrong socket → 223 "pane gone"
//   2. task-keeper-cron: identical bug
//   3. suggestions-comment-bridge: `#!/usr/bin/env node` shebang → node not on
//      cron PATH → ENOENT → Mattias' OWN ticket comments undelivered for 4h
// Manual tests always passed — that is WHY all three reached production. This
// gate runs REAL children under a sanitized env so the class dies at test time.
import { describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, chmodSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The cron reality: no nvm, no node, nothing but the base system.
const CRON_ENV = (home) => ({ HOME: home, PATH: "/usr/bin:/bin" });

/** Run a probe as a REAL child under the sanitized cron environment. */
const runProbe = (home, source) => {
  const probe = join(home, "probe.mjs");
  writeFileSync(probe, source);
  return spawnSync(process.execPath, [probe], {
    encoding: "utf-8", env: CRON_ENV(home), cwd: REPO,
  });
};

/** A stub amux whose shebang can only resolve when node is on PATH. */
const shebangAmux = (home) => {
  const path = join(home, "fake-amux.mjs");
  writeFileSync(path, "#!/usr/bin/env node\nprocess.exit(0);\n");
  chmodSync(path, 0o755);
  return path;
};

describe("cron-environment class gate", () => {
  it("all three amux spawn factories survive a cron env with no node on PATH", () => {
    const home = mkdtempSync(join(tmpdir(), "cron-class-"));
    try {
      const amuxBin = shebangAmux(home);
      const result = runProbe(home, `
        import { createAmuxCommentDeliverer, createAmuxCommentNotifier,
          createAmuxBoardAuthNotifier } from ${JSON.stringify(join(REPO, "core/suggestions-comment-bridge.mjs"))};
        const amuxBin = ${JSON.stringify(amuxBin)};
        await createAmuxCommentNotifier({ amuxBin })({ projectId: "p", ticketId: "T-1",
          commentId: 1, agent: "a", pane: 0, idempotencyKey: "k1" });
        await createAmuxBoardAuthNotifier({ amuxBin })({ status: 401, lastSuccessfulSyncAt: null });
        await createAmuxCommentDeliverer({ amuxBin })({ agent: "a", pane: 0,
          prompt: "hello", idempotencyKey: "k2" });
        console.log("ALL_THREE_OK");
      `);
      expect(result.stderr).not.toMatch(/ENOENT/u);
      expect(result.stdout).toContain("ALL_THREE_OK");
      expect(result.status).toBe(0);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("has teeth: the pre-fix shape (trusting the shebang) FAILS under the same env", () => {
    // Proof the gate above is not vacuous. This is exactly what the bridge did
    // before the fix: spawn the .mjs directly and let the kernel resolve node.
    // The precise failure is worth recording: `env` itself EXISTS, so exec
    // succeeds and no ENOENT event fires — env then cannot find node and exits
    // 127. The bridge only saw "amux failed (exit 127)" with no hint that its
    // own interpreter was the missing piece.
    const home = mkdtempSync(join(tmpdir(), "cron-class-teeth-"));
    try {
      const amuxBin = shebangAmux(home);
      const result = runProbe(home, `
        import { spawn } from "child_process";
        const child = spawn(${JSON.stringify(amuxBin)}, ["notifyuser"], { stdio: "ignore" });
        child.once("error", (error) => { console.log("PREFIX_FAILED:" + error.code); process.exit(0); });
        child.once("close", (code) => {
          console.log(code === 0 ? "PREFIX_SURVIVED" : "PREFIX_FAILED:exit" + code);
          process.exit(0);
        });
      `);
      expect(result.stdout).toMatch(/PREFIX_FAILED:(ENOENT|exit127)/u);
      expect(result.stdout).not.toContain("PREFIX_SURVIVED");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("no cron entrypoint resolves node from a bare name (every one uses an absolute interpreter)", () => {
    // The scripts export their own PATH, but a bare `node` still depends on
    // that export being right forever. Absolute NODE_BIN is the invariant.
    const scripts = readdirSync(join(REPO, "bin"))
      .filter((name) => name.endsWith("-cron.sh"));
    expect(scripts.length).toBeGreaterThanOrEqual(6);
    const offenders = [];
    for (const name of scripts) {
      const body = readFileSync(join(REPO, "bin", name), "utf-8");
      // A bare `node ...` invocation (not $NODE_BIN, not an absolute path).
      if (/(^|[|;&\s])node\s+["'$/]/mu.test(body)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  it("no shell script spawns a .mjs directly and relies on its shebang", () => {
    const offenders = [];
    for (const name of readdirSync(join(REPO, "bin"))) {
      if (!name.endsWith(".sh")) continue;
      const body = readFileSync(join(REPO, "bin", name), "utf-8");
      for (const line of body.split("\n")) {
        // Executing a .mjs where the line does not name an interpreter.
        if (!/\.mjs\b/u.test(line)) continue;
        if (/^\s*#/u.test(line)) continue;
        if (/NODE_BIN|node_modules|execPath|\$\(dirname|SCRIPT=|AGENTMUX_DIR=|ENTRY=/u.test(line)) continue;
        if (/^\s*\S*\/(bin|scripts)\/[\w-]+\.mjs/u.test(line)) offenders.push(`${name}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
