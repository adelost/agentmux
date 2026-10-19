import { feature, unit, expect } from "bdd-vitest";
import { accountWithRoom, parseIdleCapacityConfig } from "./idle-capacity-runtime.mjs";

// The accounts as `amux quota --json` read them on 2026-10-19 04:35Z.
const claude = (name, id, weekly) => ({ ok: true, provider: "claude", name, profile: { id, key: `claude:${id}` },
  limits: [{ kind: "session", usedPercent: 0 }, { kind: "weekly_all", usedPercent: weekly, isActive: true }] });
const codex = (name, id, weekly) => ({ ok: true, provider: "codex", name, profile: { id, key: `codex:${id}` },
  limits: [{ limitId: "codex", windows: [{ id: "primary", windowMinutes: 10080, usedPercent: weekly }] }] });
const night = [
  claude("Claude W", "wetterlind", 100), claude("Claude A", "2", 97), claude("Claude S", "1", 13),
  codex("Codex A", "1", 100), codex("Codex W", "2", 68),
  { ok: false, provider: "kimi", error: "credentials_expired" },
];

feature("the account the idle-capacity alarm points to", () => {
  unit("each engine names its account with the most weekly room below the reserve", {
    when: ["reading the night's accounts", () => ["claude", "codex", "kimi"]
      .map((engine) => accountWithRoom(night, engine, { reservePercent: 90 }))],
    then: ["Claude S and Codex W, with the logins that share each; nothing for an engine without room", (rooms) => {
      // The profile keys let the notice see a pane that already runs there (lsrc:0, 2026-10-19).
      expect(rooms).toEqual([
        { name: "Claude S", profileId: "1", usedPercent: 13, profileKeys: ["claude:1"] },
        { name: "Codex W", profileId: "2", usedPercent: 68, profileKeys: ["codex:2"] },
        null,
      ]);
    }],
  });

  unit("the alarm is off until the operator names a dispatcher pane", {
    when: ["reading three environments", () => [
      parseIdleCapacityConfig({}),
      parseIdleCapacityConfig({ AMUX_IDLE_CAPACITY_TARGET: "lsrc:0" }),
      parseIdleCapacityConfig({ AMUX_IDLE_CAPACITY_TARGET: "lsrc:0", AMUX_IDLE_CAPACITY_ALERT_ENABLED: "false" }),
    ]],
    then: ["only the named pane turns it on", (configs) => {
      expect(configs.map((config) => config.enabled)).toEqual([false, true, false]);
      expect(configs[1]).toMatchObject({ agentName: "lsrc", pane: 0, pollMs: 300_000 });
    }],
  });
});
