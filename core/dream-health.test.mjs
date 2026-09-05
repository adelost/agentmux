import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { parseDreamSchedule, dreamDeadline, readDreamSuccess, observeDreamHealth } from "./dream-health.mjs";
import { lintMemory, formatMemoryStatus } from "./memory-lint.mjs";

const roots = [], now = new Date("2026-09-05T04:30:00Z");
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "amux-dream-health-")); roots.push(home);
  const workspace = join(home, "workspace"); mkdirSync(join(workspace, "memory"), { recursive: true });
  const options = { home, now, env: { HOME: home, OPENCLAW_WORKSPACE: workspace }, config: { dream: { agent: "fake", pane: 0 } },
    readCrontab: () => "CRON_TZ=Europe/Stockholm\n0 4 * * * /fake/dream-cron.sh\n" };
  const daily = join(workspace, "memory", "2026-09-05.md");
  return { home, workspace, options, daily };
}
function success(fx) {
  const runId = "41310b1d-8a21-4e8c-8a57-196ecc5a2cf5", dateKey = "2026-09-05";
  const input = JSON.stringify({ dateKey, createdAt: "2026-09-05T02:10:00Z", owner: { agent: "fake", pane: 0 } });
  const sha = createHash("sha256").update(input).digest("hex");
  const product = `> Kuraterad av fake:0 efter verifierad kompaktering · run \`${runId}\` · source \`${sha}\`.\n- Verified fixture work.`;
  const base = join(fx.home, ".agentmux", "dream-input", `${dateKey}-${runId}`);
  mkdirSync(join(fx.home, ".agentmux", "dream-input"), { recursive: true });
  writeFileSync(`${base}.json`, input); writeFileSync(`${base}.summary.md`, product);
  writeFileSync(fx.daily, [
    "> summary: Fixture", "> why: Health check", "<!-- amux-dream-failed:2026-09-05 04:00 old-failure -->",
    "<!-- amux-dream-run:2026-09-05 04:10 (1 panes ok / 0 failed) -->",
    "<!-- amux-dream-summary:2026-09-05 -->", product, "<!-- /amux-dream-summary:2026-09-05 -->",
  ].join("\n"));
  return base;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("on-demand Dream deadline and artifact guard", () => {
  it("warns about a missing run without needing a failure marker", () => {
    const fx = fixture(), health = observeDreamHealth(fx.workspace, fx.options);
    expect(health.status).toBe("warn"); expect(health.detail).toContain("missing/stale");
    const memory = lintMemory(fx.workspace, { now, home: fx.home, dreamHealth: health });
    expect(memory.findings.some((f) => f.code === "dream_freshness")).toBe(true);
    expect(formatMemoryStatus(memory)).toContain("Latest dream: WARN");
  });
  it("does not alarm before the deadline or inside explicit grace", () => {
    const fx = fixture();
    for (const at of ["2026-09-05T01:00:00Z", "2026-09-05T02:59:00Z"]) {
      expect(observeDreamHealth(fx.workspace, { ...fx.options, now: new Date(at) }).state).toBe("pending");
    }
    expect(observeDreamHealth(fx.workspace, { ...fx.options, env: { ...fx.options.env, AMUX_DREAM_GRACE_MS: "10800000" } }).state).toBe("pending");
  });
  it("rejects yesterday's sentinel in today's daily file", () => {
    const fx = fixture(); writeFileSync(fx.daily, "<!-- amux-dream-run:2026-09-04 04:10 (0 panes ok / 0 failed) -->");
    expect(observeDreamHealth(fx.workspace, fx.options).status).toBe("warn");
  });
  it("accepts validated success after an older error, without needing any live agent", () => {
    const fx = fixture(); success(fx);
    const health = observeDreamHealth(fx.workspace, fx.options);
    expect(health.state).toBe("healthy"); expect(health.success.runId).toBeTruthy();
    expect(lintMemory(fx.workspace, { now, home: fx.home, dreamHealth: health }).findings.filter((f) => f.code.startsWith("dream"))).toEqual([]);
  });
  it("does not trust a success marker if the run/source product no longer verifies", () => {
    const fx = fixture(), base = success(fx); writeFileSync(`${base}.summary.md`, "wrong run");
    expect(readDreamSuccess(fx.workspace, "2026-09-05", { home: fx.home, now }).ok).toBe(false);
    expect(observeDreamHealth(fx.workspace, fx.options).status).toBe("warn");
  });
  it("accepts a controller no-work run but not partial or future results", () => {
    const fx = fixture();
    for (const [time, failed, expected] of [["04:10", 0, "healthy"], ["04:10", 1, "warn"], ["23:59", 0, "warn"]]) {
      writeFileSync(fx.daily, `<!-- amux-dream-run:2026-09-05 ${time} (0 panes ok / ${failed} failed) -->`);
      expect(observeDreamHealth(fx.workspace, fx.options).state).toBe(expected);
    }
  });
  it("uses the actual cron timezone across summer/winter and memory date boundaries", () => {
    const schedule = parseDreamSchedule("CRON_TZ=America/New_York\n30 23 * * * /fake/dream-cron.sh", { timeZone: "UTC" });
    expect(new Date(dreamDeadline(new Date("2026-09-06T03:45:00Z"), schedule).startMs).toISOString()).toBe("2026-09-06T03:30:00.000Z");
    expect(dreamDeadline(new Date("2026-09-06T03:45:00Z"), schedule).dateKey).toBe("2026-09-06");
    expect(new Date(dreamDeadline(new Date("2026-01-06T04:45:00Z"), schedule).startMs).toISOString()).toBe("2026-01-06T04:30:00.000Z");
    expect(new Date(dreamDeadline(new Date("2026-09-06T05:00:00Z"), schedule).deadlineMs).toISOString()).toBe("2026-09-06T04:30:00.000Z");
  });
  it("reports unavailable or unsupported scheduling honestly and leaves unscheduled workspaces alone", () => {
    const fx = fixture();
    expect(observeDreamHealth(fx.workspace, { ...fx.options, readCrontab: () => { throw new Error("offline"); } }).detail).toContain("unverified");
    expect(observeDreamHealth(fx.workspace, { ...fx.options, readCrontab: () => "" }).status).toBe("warn");
    expect(observeDreamHealth(fx.workspace, { ...fx.options, config: {}, readCrontab: () => "" }).state).toBe("disabled");
    expect(observeDreamHealth("/not-the-target", fx.options).state).toBe("disabled");
    expect(() => parseDreamSchedule("*/5 * * * * /fake/dream-cron.sh", { timeZone: "UTC" })).toThrow("not a supported");
  });
});
