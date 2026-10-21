import { execFileSync } from "node:child_process";
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import net from "node:net";
import { watchDeliveryAttempts } from "../bin/delivery-stall-watch.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, feature, integration, component } from "bdd-vitest";

feature("outside tmux watchdog", () => {
  integration("three consecutive socket failures queue one whole-fleet rebuild", {
    given: ["a real Unix socket whose tmux probe always times out", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-tmux-watchdog-"));
      const home = join(root, "home");
      const fakeBin = join(root, "bin");
      const socket = join(root, "tmux.sock");
      mkdirSync(home, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(fakeBin, "timeout"), "#!/usr/bin/env bash\nexit 124\n");
      writeFileSync(join(fakeBin, "ps"), `#!/usr/bin/env bash
echo "99999999 99999999 ${process.getuid?.() ?? 1000} tmux tmux -S ${socket} new-session -d -s test"
`);
      chmodSync(join(fakeBin, "timeout"), 0o755);
      chmodSync(join(fakeBin, "ps"), 0o755);
      const server = net.createServer();
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(socket, resolveListen);
      });
      return { root, home, fakeBin, socket, server };
    }],
    when: ["the external watchdog runs three times", (ctx) => {
      const env = {
        ...process.env,
        HOME: ctx.home,
        TMUX_SOCKET: ctx.socket,
        PATH: `${ctx.fakeBin}:${process.env.PATH}`,
      };
      const script = resolve("bin/bridge-watchdog-cron.sh");
      execFileSync("bash", [script], { env });
      const afterOne = readFileSync(join(ctx.home, ".agentmux", "tmux-watchdog-failures"), "utf8").trim();
      execFileSync("bash", [script], { env });
      const afterTwo = readFileSync(join(ctx.home, ".agentmux", "tmux-watchdog-failures"), "utf8").trim();
      execFileSync("bash", [script], { env });
      const request = JSON.parse(readFileSync(
        join(ctx.home, ".agentmux", "fleet-restart-request.json"), "utf8",
      ));
      return { afterOne, afterTwo, request };
    }],
    then: ["one and two failures remain suspicion while the third persists watchdog provenance", async (result, ctx) => {
      expect(result.afterOne).toBe("1");
      expect(result.afterTwo).toBe("2");
      expect(result.request).toMatchObject({ version: 1, source: "watchdog" });
      await new Promise((resolveClose) => ctx.server.close(resolveClose));
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
});

feature("delivery attempts watchdog", () => {
  component("a pending zero-attempt queue alerts once after ten minutes and rearms on progress", {
    given: ["an isolated HOME, no model process, and an 11-minute pending job", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-delivery-watch-"));
      const home = join(root, "home"), state = join(home, ".agentmux"), queue = join(state, "delivery-queue", "probe--p0");
      mkdirSync(queue, { recursive: true });
      const calls = join(root, "calls"), amux = join(root, "amux");
      writeFileSync(amux, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\n`);
      chmodSync(amux, 0o755);
      const job = { id: "probe", agentName: "probe", pane: 0, status: "pending", attempts: 0,
        createdAt: Date.now() - 11 * 60_000, text: "private must never be logged" };
      writeFileSync(join(queue, "probe.json"), JSON.stringify(job));
      return { root, home, state, queue, job, calls, amux };
    }],
    when: ["the minute watchdog observes the same stall twice, then an attempt and an empty queue", ctx => {
      const script = resolve("bin/bridge-watchdog-cron.sh");
      const run = () => execFileSync("bash", [script], { env: { ...process.env, HOME: ctx.home,
        AMUX: ctx.amux, NODE_BIN: process.execPath, TMUX_SOCKET: join(ctx.root, "no-tmux.sock") } });
      run(); run();
      const alerts = (() => { try { return readFileSync(ctx.calls, "utf8"); } catch { return ""; } })();
      ctx.job.lastAttemptAt = Date.now();
      writeFileSync(join(ctx.queue, "probe.json"), JSON.stringify(ctx.job)); run();
      rmSync(join(ctx.queue, "probe.json")); run();
      return alerts;
    }],
    then: ["only one notifyuser names the delay without message content and the episode resets", (alerts, ctx) => {
      try {
        expect(alerts.trim().split("\n")).toHaveLength(1);
        expect(alerts).toContain("notifyuser"); expect(alerts).toContain("10 min");
        expect(alerts).not.toContain("private must never");
        expect(JSON.parse(readFileSync(join(ctx.state, "delivery-stall-alert.json"), "utf8"))).toMatchObject({ episode: null });
      } finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
});

feature("delivery alert evidence", () => {
  component("recent attempts silence the alert and failed notification retries without job changes", {
    given: ["an isolated queued job and named notification I/O double", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-watch-evidence-")), queue = join(root, "delivery-queue", "probe--p0");
      mkdirSync(queue, { recursive: true });
      const now = Date.now(), jobPath = join(queue, "job.json");
      const original = JSON.stringify({ status: "pending", createdAt: now - 700_000, attempts: 0 });
      writeFileSync(jobPath, original);
      return { root, now, jobPath, original };
    }],
    when: ["the actual recent event clears the alarm, then a failed send is retried", ctx => {
      const events = join(ctx.root, "events.jsonl"), calls = [];
      writeFileSync(events, JSON.stringify({ event: "delivery_queue", state: "attempt", ts: new Date(ctx.now - 1000).toISOString() }) + "\n");
      watchDeliveryAttempts({ stateDir: ctx.root, now: ctx.now, notify: value => calls.push(value) });
      const recent = calls.length;
      writeFileSync(events, "");
      let failed = false;
      try { watchDeliveryAttempts({ stateDir: ctx.root, now: ctx.now, notify: () => { throw new Error("notification unavailable"); } }); }
      catch { failed = true; }
      watchDeliveryAttempts({ stateDir: ctx.root, now: ctx.now, notify: value => calls.push(value) });
      watchDeliveryAttempts({ stateDir: ctx.root, now: ctx.now, notify: value => calls.push(value) });
      return { recent, failed, calls };
    }],
    then: ["the ten-minute rule uses real attempt evidence, retries failure, deduplicates success, and never edits the queue", (result, ctx) => {
      try {
        expect(result.recent).toBe(0); expect(result.failed).toBe(true); expect(result.calls).toHaveLength(1);
        expect(readFileSync(ctx.jobPath, "utf8")).toBe(ctx.original);
      } finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
});
