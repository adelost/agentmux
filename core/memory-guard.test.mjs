import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, feature, unit } from "bdd-vitest";
import {
  canStartHeavy,
  classifyMemory,
  isGuardStateStale,
  MEMORY_GUARDRAIL_DEFAULTS as T,
  parseMeminfo,
  pollMemoryGuardOnce,
  readGuardState,
  startMemoryGuard,
  transitionGuard,
} from "./memory-guard.mjs";

// 48 GiB host, 4 GiB swap — the 2026-07-20 incident shape.
const HOST = { memTotalKb: 48 * 1024 * 1024, swapTotalKb: 4 * 1024 * 1024 };

function meminfo({ availableGiB, swapFreeGiB }) {
  return [
    `MemTotal:       ${HOST.memTotalKb} kB`,
    `MemAvailable:   ${Math.round(availableGiB * 1024 * 1024)} kB`,
    `SwapTotal:      ${HOST.swapTotalKb} kB`,
    `SwapFree:       ${Math.round(swapFreeGiB * 1024 * 1024)} kB`,
  ].join("\n");
}

function sample(availableGiB, swapFreeGiB = 4) {
  return parseMeminfo(meminfo({ availableGiB, swapFreeGiB }));
}

feature("memory admission guard", () => {
  unit("parses one meminfo snapshot into the four counters", {
    then: ["the totals and free counters land exactly", () => {
      const parsed = sample(12, 3);
      expect(parsed.memTotalKb).toBe(HOST.memTotalKb);
      expect(parsed.memAvailableKb).toBe(12 * 1024 * 1024);
      expect(parsed.swapFreeKb).toBe(3 * 1024 * 1024);
    }],
  });

  unit("classifies the measured thresholds at their boundaries", {
    then: ["normal, warn, blocked and critical all hold", () => {
      expect(classifyMemory(sample(20))).toBe("normal");
      expect(classifyMemory(sample(8))).toBe("warn"); // <17%, swap fine
      expect(classifyMemory(sample(8, 0.5))).toBe("blocked"); // <17% AND swap <25%
      expect(classifyMemory(sample(5))).toBe("blocked"); // <11% regardless of swap
      expect(classifyMemory(sample(2.5, 0.3))).toBe("critical"); // <6% AND swap <10%
      expect(classifyMemory(sample(2.5, 2))).toBe("blocked"); // critical needs BOTH
      expect(classifyMemory(sample(7, 0.5))).toBe("blocked"); // <17% available AND swap <25%
      expect(classifyMemory(sample(7, 3))).toBe("warn"); // <17% but swap healthy
    }],
  });

  unit("escalates to critical only after two consecutive critical samples", {
    then: ["the first critical sample pre-escalates to blocked", () => {
      let state = { level: "warn" };
      state = transitionGuard(state, sample(2.5, 0.3));
      expect(state.level).toBe("blocked");
      expect(state.critStreak).toBe(1);
      state = transitionGuard(state, sample(2.5, 0.3));
      expect(state.level).toBe("critical");
      expect(state.critStreak).toBe(2);
    }],
  });

  unit("recovers only after three clear samples, ignoring still-allocated swap", {
    then: ["hysteresis holds, and a warn dip re-escalates immediately", () => {
      let state = { level: "blocked", critStreak: 0, clearStreak: 0 };
      state = transitionGuard(state, sample(12, 0.2));
      expect(state.level).toBe("blocked");
      state = transitionGuard(state, sample(12, 0.2));
      expect(state.level).toBe("blocked");
      state = transitionGuard(state, sample(12, 0.2));
      expect(state.level).toBe("normal");
      state = transitionGuard(state, sample(8));
      expect(state.level).toBe("warn");
    }],
  });

  unit("fails closed for automatic starters on a missing, stale, foreign-boot or future state", {
    then: ["every untrustworthy state is refused; manual start stays the override", () => {
      expect(canStartHeavy(null, { class: "browser", bootId: "b1" }))
        .toMatchObject({ ok: false, reason: "guard-state-stale" });
      const fresh = { bootId: "b1", observedAt: 1_000, level: "normal", sample: sample(20) };
      expect(canStartHeavy(fresh, { class: "browser", nowMs: 1_000 + T.stateTtlMs + 1, bootId: "b1" }))
        .toMatchObject({ ok: false, reason: "guard-state-stale" });
      expect(canStartHeavy(fresh, { class: "browser", nowMs: 1_500, bootId: "OTHER" }))
        .toMatchObject({ ok: false, reason: "guard-state-stale" });
      // A state with NO bootId is never proof when the current boot is known.
      expect(canStartHeavy({ observedAt: 1_000, level: "normal", sample: sample(20) }, {
        class: "browser", nowMs: 1_500, bootId: "b1",
      })).toMatchObject({ ok: false, reason: "guard-state-stale" });
      // A future timestamp is not freshness.
      expect(canStartHeavy(fresh, { class: "browser", nowMs: 500, bootId: "b1" }))
        .toMatchObject({ ok: false, reason: "guard-state-stale" });
      // …but a manual start is the explicit override and is never blocked.
      expect(canStartHeavy(null, { class: "browser", automatic: false }))
        .toMatchObject({ ok: true, reason: "manual-override" });
    }],
  });

  unit("denies automatic heavy starts at blocked/critical and enforces the reserve floor", {
    then: ["levels and projected headroom both bind", () => {
      const base = { bootId: "b1", observedAt: 1_000, sample: sample(6) };
      expect(canStartHeavy({ ...base, level: "blocked" }, { class: "emulator", nowMs: 1_000, bootId: "b1" }))
        .toMatchObject({ ok: false, reason: "memory-blocked" });
      expect(canStartHeavy({ ...base, level: "critical" }, { class: "emulator", nowMs: 1_000, bootId: "b1" }))
        .toMatchObject({ ok: false, reason: "memory-critical" });
      // 6 GiB available, 2 GiB reserve leaves 4 GiB < 5.28 GiB floor → refused.
      expect(canStartHeavy({ ...base, level: "warn" }, {
        class: "browser", reserveMiB: 2048, nowMs: 1_000, bootId: "b1",
      })).toMatchObject({ ok: false, reason: "memory-reserve-floor" });
      // 12 GiB available, 2 GiB reserve leaves ~9.9 GiB > floor → allowed.
      expect(canStartHeavy({ ...base, level: "warn", sample: sample(12) }, {
        class: "browser", reserveMiB: 2048, nowMs: 1_000, bootId: "b1",
      })).toMatchObject({ ok: true, reason: "memory-warn-allowed" });
    }],
  });

  unit("persists one atomic state file with boot identity and freshness", {
    then: ["the written file round-trips and staleness is measurable", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-memguard-"));
      try {
        const path = join(root, "memory-guard.json");
        const first = pollMemoryGuardOnce({
          path,
          readMeminfo: () => meminfo({ availableGiB: 2.5, swapFreeGiB: 0.3 }),
          bootId: "boot-x",
          nowMs: 5_000,
        });
        expect(first.state.level).toBe("blocked");
        const second = pollMemoryGuardOnce({
          path,
          readMeminfo: () => meminfo({ availableGiB: 2.5, swapFreeGiB: 0.3 }),
          bootId: "boot-x",
          nowMs: 35_000,
        });
        expect(second.state.level).toBe("critical");
        expect(second.changed).toBe(true);
        const persisted = readGuardState({ path });
        expect(persisted).toMatchObject({ bootId: "boot-x", observedAt: 35_000, level: "critical" });
        expect(isGuardStateStale(persisted, { nowMs: 36_000, bootId: "boot-x" })).toBe(false);
        expect(isGuardStateStale(persisted, { nowMs: 111_000, bootId: "boot-x" })).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("emits one visible alert when the first-ever verdict is non-normal", {
    then: ["the initial blocked boot alarms exactly once across two polls", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-memguard-alert-"));
      try {
        const alerts = [];
        const stop = startMemoryGuard({
          intervalMs: 3_600_000,
          path: join(root, "memory-guard.json"),
          readMeminfo: () => meminfo({ availableGiB: 5, swapFreeGiB: 4 }),
          bootId: "boot-alert",
          nowMs: 10_000,
          onTransition: (event) => { alerts.push(event); },
          log: () => {},
        });
        stop();
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ to: "blocked" });
        expect(alerts[0].from).toBeNull();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("emits no alert for an initial normal verdict or a held level", {
    then: ["quiet states stay quiet", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-memguard-quiet-"));
      try {
        const alerts = [];
        const stop = startMemoryGuard({
          intervalMs: 3_600_000,
          path: join(root, "memory-guard.json"),
          readMeminfo: () => meminfo({ availableGiB: 20, swapFreeGiB: 4 }),
          bootId: "boot-quiet",
          nowMs: 10_000,
          onTransition: (event) => { alerts.push(event); },
          log: () => {},
        });
        stop();
        expect(alerts).toHaveLength(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });
});
