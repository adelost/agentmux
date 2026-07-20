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
  writeFileSync(fakeNode, [
    "#!/usr/bin/env bash",
    "echo \"$*\" >> \"$HOME/revive-calls\"",
    "if [[ \"$*\" == *\"verify-release-identity\"* && \"${AMUX_TEST_IDENTITY_DOWN:-false}\" == \"true\" ]]; then",
    "  exit 42",
    "fi",
    "if [[ \"$*\" == *\"memory-guard\"* && \"${AMUX_TEST_MEMORY_DOWN:-false}\" == \"true\" ]]; then",
    "  exit 43",
    "fi",
    "if [[ \"$*\" == *\"runtime check\"* && \"${AMUX_TEST_RUNTIME_DOWN:-false}\" == \"true\" ]]; then",
    "  exit 23",
    "fi",
    "",
  ].join("\n"));
  chmodSync(fakeNode, 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const run = (extraEnv = {}) => spawnSync("bash", [SCRIPT], {
    cwd: REPO,
    env: { ...env, ...extraEnv },
    encoding: "utf-8",
  });
  return { home, run, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

feature("post-boot revive launcher", () => {
  integration("runs revive once for the current boot and then becomes a no-op", {
    given: ["an isolated HOME and fake node", setup],
    when: ["launching twice", (ctx) => ({ ctx, first: ctx.run(), second: ctx.run() })],
    then: ["gated revive runs once and one durable boot marker", ({ ctx, first, second }) => {
      try {
        expect(first.status).toBe(0);
        expect(second.status).toBe(0);
        const calls = readFileSync(join(ctx.home, "revive-calls"), "utf-8").trim().split("\n");
        expect(calls).toHaveLength(5);
        expect(calls[0]).toContain("bin/verify-release-identity.mjs");
        expect(calls[1]).toContain("bin/memory-guard.mjs check --class pane-revive");
        expect(calls[2]).toContain("bin/agent-cli.mjs runtime start");
        expect(calls[3]).toContain("bin/agent-cli.mjs runtime check --port 8811");
        expect(calls[4]).toContain("bin/agent-cli.mjs revive");
        expect(readFileSync(join(ctx.home, ".agentmux", "revive-boot-id"), "utf-8").trim())
          .toBe(readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim());
      } finally { ctx.cleanup(); }
    }],
  });

  integration("refuses pane revive before any runtime step when release identity fails", {
    given: ["an isolated HOME whose identity gate fails", setup],
    when: ["running post-boot revive", (ctx) => ({
      ctx,
      result: ctx.run({ AMUX_TEST_IDENTITY_DOWN: "true" }),
    })],
    then: ["the launcher is red, no pane or runtime step ran, boot stays retryable", ({ ctx, result }) => {
      try {
        const calls = readFileSync(join(ctx.home, "revive-calls"), "utf-8").trim().split("\n");
        expect(result.status).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain("bin/verify-release-identity.mjs");
        expect(calls.some((call) => call.includes("agent-cli.mjs"))).toBe(false);
        expect(result.stderr).toContain("post-boot revive REFUSED: release identity failed");
        expect(() => readFileSync(join(ctx.home, ".agentmux", "revive-boot-id")))
          .toThrow();
      } finally { ctx.cleanup(); }
    }],
  });

  integration("refuses pane revive when the memory admission gate denies it", {
    given: ["an isolated HOME whose memory gate refuses", setup],
    when: ["running post-boot revive", (ctx) => ({
      ctx,
      result: ctx.run({ AMUX_TEST_MEMORY_DOWN: "true" }),
    })],
    then: ["identity passed but no pane or runtime step ran", ({ ctx, result }) => {
      try {
        const calls = readFileSync(join(ctx.home, "revive-calls"), "utf-8").trim().split("\n");
        expect(result.status).toBe(1);
        expect(calls).toHaveLength(2);
        expect(calls[0]).toContain("bin/verify-release-identity.mjs");
        expect(calls[1]).toContain("bin/memory-guard.mjs check --class pane-revive");
        expect(calls.some((call) => call.includes("agent-cli.mjs"))).toBe(false);
        expect(result.stderr).toContain("post-boot revive REFUSED: memory admission denied");
        expect(() => readFileSync(join(ctx.home, ".agentmux", "revive-boot-id")))
          .toThrow();
      } finally { ctx.cleanup(); }
    }],
  });

  integration("fails before pane revive when the port-8811 runtime health check is down", {
    given: ["an isolated HOME whose runtime health check fails", setup],
    when: ["running post-boot revive", (ctx) => ({
      ctx,
      result: ctx.run({ AMUX_TEST_RUNTIME_DOWN: "true" }),
    })],
    then: ["the launcher is red and leaves the boot retryable", ({ ctx, result }) => {
      try {
        const calls = readFileSync(join(ctx.home, "revive-calls"), "utf-8").trim().split("\n");
        const healthChecks = calls.filter((call) => call.includes("runtime check --port 8811")).length;
        if (process.env.AMUX_MEASUREMENT_OUTPUT) {
          writeFileSync(process.env.AMUX_MEASUREMENT_OUTPUT, JSON.stringify({
            metric: "post_boot_native_runtime_health_checks",
            unit: "checks",
            operator: ">=",
            limit: 0.5,
            observed: healthChecks,
          }));
        }
        expect(result.status).toBe(1);
        expect(calls).toHaveLength(4);
        expect(calls[0]).toContain("bin/verify-release-identity.mjs");
        expect(calls[1]).toContain("bin/memory-guard.mjs check --class pane-revive");
        expect(calls[2]).toContain("bin/agent-cli.mjs runtime start");
        expect(calls[3]).toContain("bin/agent-cli.mjs runtime check --port 8811");
        expect(calls.some((call) => call.endsWith("bin/agent-cli.mjs revive"))).toBe(false);
        expect(result.stderr).toContain("post-boot revive failed; next serve will retry");
        expect(() => readFileSync(join(ctx.home, ".agentmux", "revive-boot-id")))
          .toThrow();
      } finally { ctx.cleanup(); }
    }],
  });

  integration("start.sh launches whole-fleet revive only on explicit opt-in", {
    given: ["the supervisor source", () => readFileSync(join(REPO, "bin", "start.sh"), "utf-8")],
    when: ["checking the startup contract", (source) => source],
    then: ["default is no revive mutation; AMUX_AUTO_REVIVE=true enables the gated path", (source) => {
      expect(source).toContain("AMUX_AUTO_REVIVE:-false");
      expect(source).toContain('= "true" ]');
      expect(source).toContain("post-boot-revive.sh");
      expect(source).toMatch(/post-boot-revive\.sh.*&/);
    }],
  });
});
