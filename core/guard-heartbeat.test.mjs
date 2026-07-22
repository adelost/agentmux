import { spawnSync } from "child_process";
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyGuardHeartbeat,
  GUARD_CRON_REGISTRY,
  guardHeartbeatPath,
  readGuardHeartbeat,
  readGuardHeartbeats,
  writeGuardHeartbeat,
} from "./guard-heartbeat.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "amux-guard-heartbeat-"));
  roots.push(path);
  return path;
};

afterEach(() => roots.splice(0).forEach((path) =>
  rmSync(path, { recursive: true, force: true })));

describe("guard heartbeat ledger", () => {
  it("atomically persists a private, bounded metric snapshot", () => {
    const dir = root();
    const beat = writeGuardHeartbeat({
      key: "comment-bridge",
      intervalSec: 60,
      metrics: { projects: 4, delivered: 2, outcome: "ok" },
      now: new Date("2026-07-15T04:00:00Z"),
      dir,
    });
    expect(readGuardHeartbeat("comment-bridge", dir)).toEqual(beat);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(guardHeartbeatPath("comment-bridge", dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(guardHeartbeatPath("comment-bridge", dir), "utf8")).not.toContain("undefined");
  });

  it("goes RED only after the exact greater-than-2x boundary", () => {
    const beat = {
      schemaVersion: 1,
      key: "watchdog-outbox",
      ts: "2026-07-15T04:00:00.000Z",
      intervalSec: 60,
      metrics: {},
    };
    const entry = { key: "watchdog-outbox", intervalSec: 60, beat };
    expect(classifyGuardHeartbeat(entry, {
      now: new Date("2026-07-15T04:02:00.000Z").getTime(),
    }).state).toBe("ok");
    expect(classifyGuardHeartbeat(entry, {
      now: new Date("2026-07-15T04:02:00.001Z").getTime(),
    }).state).toBe("stale");
  });

  it("classifies a fresh intentional no-op as disabled instead of healthy", () => {
    const entry = {
      key: "fleet-progress",
      intervalSec: 1200,
      beat: {
        schemaVersion: 1, key: "fleet-progress", intervalSec: 1200,
        ts: "2026-07-15T04:00:00.000Z", metrics: { disabled: true },
      },
    };
    expect(classifyGuardHeartbeat(entry, {
      now: new Date("2026-07-15T04:01:00.000Z").getTime(),
    }).state).toBe("disabled");
  });

  it("fails closed on interval inflation and future-dated snapshots", () => {
    const canonical = GUARD_CRON_REGISTRY.find((entry) => entry.key === "comment-bridge");
    const beat = {
      schemaVersion: 1,
      key: canonical.key,
      ts: "2026-07-15T04:00:00.000Z",
      intervalSec: canonical.intervalSec,
      metrics: {},
    };
    expect(classifyGuardHeartbeat({ ...canonical, beat: { ...beat, intervalSec: 3_600 } }, {
      now: new Date("2026-07-15T04:00:01.000Z").getTime(),
    }).state).toBe("invalid");
    expect(classifyGuardHeartbeat({ ...canonical, beat: { ...beat, ts: "2026-07-15T04:00:10.001Z" } }, {
      now: new Date("2026-07-15T04:00:05.000Z").getTime(),
    }).state).toBe("invalid");
  });

  it("keeps every expected guard visible even before its first beat", () => {
    const rows = readGuardHeartbeats({ dir: root() });
    expect(rows.map((row) => row.key)).toEqual(GUARD_CRON_REGISTRY.map((row) => row.key));
    expect(rows.every((row) => row.beat === null)).toBe(true);
  });

  it("successful no-op shell sweeps beat, while a disarmed contender cannot", () => {
    const base = root();
    const heartbeatDir = join(base, "beats");
    const fakeHome = join(base, "home");
    mkdirSync(fakeHome, { recursive: true });
    const env = {
      ...process.env,
      HOME: fakeHome,
      NODE_BIN: process.execPath,
      AMUX_GUARD_HEARTBEAT_DIR: heartbeatDir,
      WATCH_DIR: join(base, "watch"),
      KEEPER_DIR: join(base, "keeper"),
      CONF: join(base, "missing.conf"),
      REPO: join(base, "missing-repo"),
      BACKLOG: join(base, "missing-repo", "missing-backlog.md"),
    };
    const cases = [
      ["fleet-progress-cron.sh", "fleet-progress"],
      ["task-keeper-cron.sh", "task-keeper"],
      ["backlog-pull-cron.sh", "backlog-pull"],
      ["board-curator-cron.sh", "board-curator"],
    ];
    for (const [script, key] of cases) {
      const result = spawnSync("bash", [join(REPO, "bin", script)], { env, encoding: "utf8" });
      expect(result.status, `${script}: ${result.stderr}`).toBe(0);
      expect(readGuardHeartbeat(key, heartbeatDir)?.key).toBe(key);
    }

    const disarm = join(base, "disarm.sh");
    writeFileSync(disarm, `#!/usr/bin/env bash
source "${join(REPO, "bin", "guard-heartbeat.sh")}"
guard_heartbeat_arm fleet-progress 1200
guard_heartbeat_disarm
`);
    chmodSync(disarm, 0o755);
    rmSync(guardHeartbeatPath("fleet-progress", heartbeatDir));
    expect(spawnSync("bash", [disarm], { env }).status).toBe(0);
    expect(readGuardHeartbeat("fleet-progress", heartbeatDir)).toBeNull();
  });

  it("keeps all six production entrypoints wired to their canonical keys", () => {
    const sources = {
      "fleet-progress": readFileSync(join(REPO, "bin", "fleet-progress-cron.sh"), "utf8"),
      "task-keeper": readFileSync(join(REPO, "bin", "task-keeper-cron.sh"), "utf8"),
      "watchdog-outbox": readFileSync(join(REPO, "bin", "suggestions-watchdog-outbox.mjs"), "utf8"),
      "comment-bridge": readFileSync(join(REPO, "bin", "suggestions-comment-bridge.mjs"), "utf8"),
      "backlog-pull": readFileSync(join(REPO, "bin", "backlog-pull-cron.sh"), "utf8"),
      "board-curator": readFileSync(join(REPO, "bin", "board-curator-cron.sh"), "utf8"),
    };
    expect(Object.keys(sources)).toEqual(GUARD_CRON_REGISTRY.map((entry) => entry.key));
    for (const [key, source] of Object.entries(sources)) {
      expect(source).toContain(`\"${key}\"`);
      expect(source).toMatch(/(?:guard_heartbeat_arm|writeGuardHeartbeat)/);
    }
  });
});
