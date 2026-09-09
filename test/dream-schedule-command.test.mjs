import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDreamLock } from "../core/dream-lock.mjs";
import { cmdDream } from "../cli/dream.mjs";
import { dreamCatchupCrontab } from "../core/dream-cron-install.mjs";
import { parseDreamSchedule } from "../core/dream-health.mjs";

const roots = [], restore = [];
function environment(key, value) {
  const old = process.env[key]; process.env[key] = value;
  restore.push(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
}
afterEach(() => { for (const fn of restore.splice(0).reverse()) fn(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("actual Dream scheduling seam", () => {
  it("does not write a gap or run maintenance when a scheduled child starts after midnight", async () => {
    const home = mkdtempSync(join(tmpdir(), "dream-midnight-")); roots.push(home); environment("HOME", home);
    environment("AMUX_JANITOR_ENABLED", "false"); environment("AMUX_SCHEDULED_DREAM_DATE", "2026-09-08");
    environment("AMUX_SCHEDULED_DREAM_TOKEN", "late-child");
    const workspace = join(home, "workspace"); mkdirSync(workspace);
    let effects = 0;
    const result = await cmdDream({ configPath: "unused" }, { workspace }, {
      now: new Date("2026-09-08T22:00:01Z"), agents: [], runtimeConfig: {},
      owner: { agent: "test", pane: 0, engine: "codex" },
      readReceipts: () => { effects++; return {}; }, collectSources: () => { effects++; return { sources: [], unreadable: [] }; },
      nightlyCompact: async () => { effects++; return {}; },
    });
    expect(result.skipped).toBe("scheduled-date-changed");
    expect(effects).toBe(0); expect(readdirSync(workspace)).toEqual([]);
  });
  it("loads the configured runtime path under the actual minimal cron environment", () => {
    const home = mkdtempSync(join(tmpdir(), "dream-cron-env-")); roots.push(home);
    const workspace = join(home, "workspace"); mkdirSync(workspace);
    mkdirSync(join(home, ".agentmux")); mkdirSync(join(home, ".local/bin"), { recursive: true });
    const config = join(home, "generated.yaml");
    writeFileSync(config, "dream: {agent: test, pane: 0}\n");
    writeFileSync(join(home, ".agentmux/.env"), `AGENTS_YAML=${config}\nOPENCLAW_WORKSPACE=${workspace}\n`);
    writeFileSync(join(home, ".local/bin/crontab"), "#!/bin/sh\nprintf 'CRON_TZ=Europe/Stockholm\\n0 0 * * * /fake/dream-cron.sh\\n'\n", { mode: 0o755 });
    const result = spawnSync("/bin/bash", [new URL("../bin/dream-catchup.sh", import.meta.url).pathname, "--dry"], {
      env: { HOME: home, PATH: "/usr/bin:/bin", NODE_BIN: process.execPath }, encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).due).toBe(true);
    expect(readdirSync(workspace)).toEqual([]);
  });
  it("does not collect stale sources while another controller owns the lock", async () => {
    const home = mkdtempSync(join(tmpdir(), "dream-lock-source-")); roots.push(home); environment("HOME", home);
    environment("AMUX_JANITOR_ENABLED", "false");
    const workspace = join(home, "workspace"); mkdirSync(workspace);
    const lock = acquireDreamLock(); expect(lock.acquired).toBe(true);
    const forbidden = () => { throw new Error("source read outside controller lock"); };
    try {
      const result = await cmdDream({ configPath: "unused" }, { workspace }, {
        agents: [], runtimeConfig: {}, owner: { agent: "test", pane: 0, engine: "codex" },
        readReceipts: forbidden, collectSources: forbidden, nightlyCompact: forbidden,
      });
      expect(result.skipped).toBe("lock-held");
    } finally { lock.release(); }
  });
  it("claims under the lock and does not repeat source collection or maintenance on a second automatic call", async () => {
    const home = mkdtempSync(join(tmpdir(), "dream-command-schedule-")); roots.push(home); environment("HOME", home);
    environment("AMUX_JANITOR_ENABLED", "false"); environment("AMUX_SCHEDULED_DREAM_DATE", "2026-09-09");
    environment("AMUX_SCHEDULED_DREAM_TOKEN", "test-token");
    const workspace = join(home, "workspace"); mkdirSync(workspace);
    let reads = 0, maintenance = 0;
    const deps = { now: new Date("2026-09-09T07:00:00Z"), agents: [], runtimeConfig: {}, owner: { agent: "test", pane: 0, engine: "codex" },
      readReceipts: () => ({}), collectSources: () => { reads++; return { sources: [], unreadable: [] }; },
      nightlyCompact: async () => { maintenance++; return {}; },
    };
    await cmdDream({ configPath: "unused" }, { workspace, quiet: true }, deps);
    expect(reads).toBe(1); expect(maintenance).toBe(1);
    const result = await cmdDream({ configPath: "unused" }, { workspace, quiet: true }, deps);
    expect(result.skipped).toBe("already-validated"); expect(reads).toBe(1); expect(maintenance).toBe(1);
    expect(readdirSync(join(home, ".agentmux", "dream-schedule"))).toHaveLength(1);
  });
  it("keeps the one schedule parseable and preserves unrelated crontab bytes", () => {
    const before = "# private jobs\n7 * * * * /other/job\nCRON_TZ=Europe/Stockholm\n0 4 * * * /fake/bin/dream-cron.sh >> /a/log 2>&1\n";
    const after = dreamCatchupCrontab(before, "/fake");
    expect(after.startsWith(before)).toBe(true);
    expect(parseDreamSchedule(after, { timeZone: "UTC" }).hour).toBe(4);
    expect(dreamCatchupCrontab(after, "/fake")).toBe(after);
    expect(() => dreamCatchupCrontab(before, "/different-artifact")).toThrow("same installed package");
    expect(() => dreamCatchupCrontab("", "/fake")).toThrow("configure one daily");
  });
});
