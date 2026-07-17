import { feature, unit, expect } from "bdd-vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  BRIDGE_MODE_MANAGED,
  BRIDGE_MODE_MANUAL,
  BRIDGE_MODE_STOPPED,
  readBridgeMode,
  planOfflineSyncBridge,
  resolveServeMode,
  writeBridgeMode,
} from "./bridge-mode.mjs";

feature("bridge ownership mode", () => {
  unit("serve defaults to visible foreground and detach is explicit", {
    when: ["resolving serve flags", () => [resolveServeMode({}), resolveServeMode({ detach: true })]],
    then: ["manual then managed", (modes) => expect(modes).toEqual([BRIDGE_MODE_MANUAL, BRIDGE_MODE_MANAGED])],
  });

  unit("conflicting foreground and detach flags fail loud", {
    when: ["resolving both modes", () => () => resolveServeMode({ fg: true, detach: true })],
    then: ["the ambiguity is rejected", (run) => expect(run).toThrow("either foreground or --detach")],
  });

  unit("offline sync preserves managed ownership and permits explicit takeover", {
    when: ["planning managed, explicit-manual, and stopped bridge states", () => [
      planOfflineSyncBridge({ wasRunning: true, mode: BRIDGE_MODE_MANAGED }),
      planOfflineSyncBridge({ wasRunning: true, mode: BRIDGE_MODE_MANUAL, allowManagedTakeover: true }),
      planOfflineSyncBridge({ wasRunning: false, mode: BRIDGE_MODE_STOPPED }),
    ]],
    then: ["only running bridges stop and restart under explicit managed ownership", (plans) => {
      expect(plans).toEqual([
        { stop: true, restartManaged: true },
        { stop: true, restartManaged: true },
        { stop: false, restartManaged: false },
      ]);
    }],
  });

  unit("offline sync refuses to strand a manually owned bridge", {
    when: ["planning without explicit managed takeover", () => () =>
      planOfflineSyncBridge({ wasRunning: true, mode: BRIDGE_MODE_MANUAL })],
    then: ["the unsafe ownership change fails before shutdown", (run) => {
      expect(run).toThrow("--detach");
    }],
  });

  unit("mode persists and absent state defaults to manual", {
    given: ["an in-memory file", () => {
      let value = null;
      return {
        read: () => {
          if (value === null) throw new Error("missing");
          return value;
        },
        write: (_path, next) => { value = next; },
        value: () => value,
      };
    }],
    when: ["reading legacy state, writing stopped, then reading it", (io) => {
      const initial = readBridgeMode({ path: "x", read: io.read });
      writeBridgeMode(BRIDGE_MODE_STOPPED, { path: "/tmp/x", write: io.write });
      const stopped = readBridgeMode({ path: "x", read: io.read });
      return { initial, stopped, raw: io.value() };
    }],
    then: ["manual is the real default and intentional stop is durable", (result) => {
      expect(result).toEqual({ initial: BRIDGE_MODE_MANUAL, stopped: BRIDGE_MODE_STOPPED, raw: "stopped\n" });
    }],
  });

  unit("watchdog autostart is gated on managed mode", {
    when: ["reading the shell watchdog contract", () => readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "bridge-watchdog-cron.sh"),
      "utf-8",
    )],
    then: ["manual and stopped modes exit before detached spawn", (script) => {
      const gate = script.indexOf('[ "$MODE" = "managed" ] || exit 0');
      const spawn = script.indexOf("nohup bash bin/start.sh");
      expect(gate).toBeGreaterThan(0);
      expect(spawn).toBeGreaterThan(gate);
    }],
  });

  unit("a stale quota sidecar restarts a still-responsive bridge", {
    when: ["reading the shell watchdog contract", () => readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "bridge-watchdog-cron.sh"),
      "utf-8",
    )],
    then: ["the independent heartbeat is bounded and the disabled state is exempt", (script) => {
      expect(script).toContain('QUOTA_HEARTBEAT="$STATE_DIR/quota-recovery-heartbeat.json"');
      expect(script).toContain('QUOTA_STALE_SEC=900');
      expect(script).toContain('! grep -q \'"state":"disabled"\'');
      expect(script).toContain('STALE quota recovery');
      expect(script).toContain('kill -9 $PIDS');
    }],
  });

  unit("every bridge observer recognizes the preload launch command", {
    given: ["the launch command and both independent process observers", () => {
      const root = join(dirname(fileURLToPath(import.meta.url)), "..");
      return {
        launch: readFileSync(join(root, "bin", "start.sh"), "utf-8"),
        doctor: readFileSync(join(root, "cli", "commands.mjs"), "utf-8"),
        watchdog: readFileSync(join(root, "bin", "bridge-watchdog-cron.sh"), "utf-8"),
      };
    }],
    when: ["checking the shared argv boundary", (sources) => sources],
    then: ["legacy and preload launches stay observable", ({ launch, doctor, watchdog }) => {
      const processPattern = "[n]ode( [^ ]+)* index\\.mjs";
      const javascriptPattern = processPattern.replace("\\", "\\\\");
      expect(launch).toContain("node --import ./bin/quota-recovery-bootstrap.mjs index.mjs");
      expect(doctor).toContain(`pgrep -f '${javascriptPattern}'`);
      expect(watchdog).toContain(`pgrep -f '${processPattern}'`);
      const observer = /node( [^ ]+)* index\.mjs/u;
      expect(observer.test("node index.mjs")).toBe(true);
      expect(observer.test("node --import ./bin/quota-recovery-bootstrap.mjs index.mjs")).toBe(true);
    }],
  });
});
