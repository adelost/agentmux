import { feature, unit, expect } from "bdd-vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  BRIDGE_MODE_MANAGED,
  BRIDGE_MODE_MANUAL,
  BRIDGE_MODE_STOPPED,
  readBridgeMode,
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
});
