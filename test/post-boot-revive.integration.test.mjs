import { feature, integration, expect } from "bdd-vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { dirname } from "path";
import { fileURLToPath } from "url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "bin", "post-boot-revive.sh");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "amux-post-boot-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, "#!/usr/bin/env bash\necho \"$*\" >> \"$HOME/revive-calls\"\n");
  chmodSync(fakeNode, 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const run = () => spawnSync("bash", [SCRIPT], { cwd: REPO, env, encoding: "utf-8" });
  return { home, run, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

feature("post-boot revive launcher", () => {
  integration("runs revive once for the current boot and then becomes a no-op", {
    given: ["an isolated HOME and fake node", setup],
    when: ["launching twice", (ctx) => ({ ctx, first: ctx.run(), second: ctx.run() })],
    then: ["one revive call and one durable boot marker", ({ ctx, first, second }) => {
      try {
        expect(first.status).toBe(0);
        expect(second.status).toBe(0);
        const calls = readFileSync(join(ctx.home, "revive-calls"), "utf-8").trim().split("\n");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain("bin/agent-cli.mjs revive");
        expect(readFileSync(join(ctx.home, ".agentmux", "revive-boot-id"), "utf-8").trim())
          .toBe(readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim());
      } finally { ctx.cleanup(); }
    }],
  });

  integration("start.sh launches it asynchronously and supports an explicit opt-out", {
    given: ["the supervisor source", () => readFileSync(join(REPO, "bin", "start.sh"), "utf-8")],
    when: ["checking the startup contract", (source) => source],
    then: ["background launch plus AMUX_AUTO_REVIVE=false gate", (source) => {
      expect(source).toContain("AMUX_AUTO_REVIVE:-true");
      expect(source).toContain("post-boot-revive.sh");
      expect(source).toMatch(/post-boot-revive\.sh.*&/);
    }],
  });
});
