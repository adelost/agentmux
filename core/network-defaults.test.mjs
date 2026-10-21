import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { component, expect, feature } from "bdd-vitest";

// lsrc:0 2026-10-21: Claude W's quota reads failed with ETIMEDOUT, and at 07:36Z a rotation refused Claude W as
// target-access-unverified:network_error. A lost SYN is resent after 1 s and again at 3 s; Node gave the IPv4 address
// 250 ms, then tried IPv6, which has no route here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The world: a temporary home and an empty env file, so neither process reads the user's.
const world = () => {
  const home = mkdtempSync(join(tmpdir(), "amux-net-"));
  writeFileSync(join(home, ".env"), "");
  return { HOME: home, AMUX_DISCORD_ENV: join(home, ".env") };
};
// Reports the process's wait per address when it exits, after its entry point ran.
const probe = "data:text/javascript,import net from 'node:net';process.on('exit',()=>process.stderr.write('wait-per-address='+net.getDefaultAutoSelectFamilyAttemptTimeout()))";
const waitPerAddress = (args) => {
  const run = spawnSync(process.execPath, ["--import", probe, ...args], { cwd: root, env: { ...process.env, ...world() }, encoding: "utf8" });
  return Number(/wait-per-address=(\d+)/.exec(run.stderr)?.[1]);
};

feature("amux's processes wait out a lost SYN before they give up an address", () => {
  component("the bridge's bootstrap waits past the kernel's second SYN resend", {
    when: ["node starts with the bridge's runtime bootstrap", () => waitPerAddress(["--import", "./bin/runtime-env-bootstrap.mjs", "-e", ""])],
    then: ["more than 3 s", ms => expect(ms).toBeGreaterThan(3_000)],
  });
  component("the CLI waits past the kernel's second SYN resend", {
    when: ["the CLI prints its help", () => waitPerAddress(["bin/agent-cli.mjs", "--help"])],
    then: ["more than 3 s", ms => expect(ms).toBeGreaterThan(3_000)],
  });
});
