import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  canStartHeavy,
  classifyMemory,
  isGuardStateStale,
  MEMORY_GUARDRAIL_DEFAULTS as T,
  parseMeminfo,
  pollMemoryGuardOnce,
  readGuardState,
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

describe("memory guard", () => {
  it("parses one meminfo snapshot into the four counters", () => {
    const parsed = sample(12, 3);
    expect(parsed.memTotalKb).toBe(HOST.memTotalKb);
    expect(parsed.memAvailableKb).toBe(12 * 1024 * 1024);
    expect(parsed.swapFreeKb).toBe(3 * 1024 * 1024);
  });

  it("classifies the measured thresholds at their boundaries", () => {
    expect(classifyMemory(sample(20))).toBe("normal");
    expect(classifyMemory(sample(8))).toBe("warn"); // <17%, swap fine
    expect(classifyMemory(sample(8, 0.5))).toBe("blocked"); // <17% AND swap <25%
    expect(classifyMemory(sample(5))).toBe("blocked"); // <11% regardless of swap
    expect(classifyMemory(sample(2.5, 0.3))).toBe("critical"); // <6% AND swap <10%
    expect(classifyMemory(sample(2.5, 2))).toBe("blocked"); // critical needs BOTH
    expect(classifyMemory(sample(7, 0.5))).toBe("blocked"); // <17% available AND swap <25%
    expect(classifyMemory(sample(7, 3))).toBe("warn"); // <17% but swap healthy
  });

  it("escalates to critical only after two consecutive critical samples", () => {
    let state = { level: "warn" };
    state = transitionGuard(state, sample(2.5, 0.3));
    expect(state.level).toBe("blocked"); // first critical sample: pre-escalates to blocked
    expect(state.critStreak).toBe(1);
    state = transitionGuard(state, sample(2.5, 0.3));
    expect(state.level).toBe("critical");
    expect(state.critStreak).toBe(2);
  });

  it("recovers only after three clear samples, ignoring still-allocated swap", () => {
    let state = { level: "blocked", critStreak: 0, clearStreak: 0 };
    state = transitionGuard(state, sample(12, 0.2)); // >21% available, swap still used
    expect(state.level).toBe("blocked");
    state = transitionGuard(state, sample(12, 0.2));
    expect(state.level).toBe("blocked");
    state = transitionGuard(state, sample(12, 0.2));
    expect(state.level).toBe("normal");
    // A dip below the warn threshold re-escalates immediately.
    state = transitionGuard(state, sample(8));
    expect(state.level).toBe("warn");
  });

  it("fails closed for automatic starters on a missing, stale, or foreign-boot state", () => {
    expect(canStartHeavy(null, { class: "browser", bootId: "b1" }))
      .toMatchObject({ ok: false, reason: "guard-state-stale" });
    const fresh = { bootId: "b1", observedAt: 1_000, level: "normal", sample: sample(20) };
    expect(canStartHeavy(fresh, { class: "browser", nowMs: 1_000 + T.stateTtlMs + 1, bootId: "b1" }))
      .toMatchObject({ ok: false, reason: "guard-state-stale" });
    expect(canStartHeavy(fresh, { class: "browser", nowMs: 1_500, bootId: "OTHER" }))
      .toMatchObject({ ok: false, reason: "guard-state-stale" });
    // …but a manual start is the explicit override and is never blocked.
    expect(canStartHeavy(null, { class: "browser", automatic: false }))
      .toMatchObject({ ok: true, reason: "manual-override" });
  });

  it("denies automatic heavy starts at blocked/critical and enforces the reserve floor", () => {
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
  });

  it("persists one atomic state file with boot identity and freshness", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-memguard-"));
    try {
      const path = join(root, "memory-guard.json");
      const first = pollMemoryGuardOnce({
        path,
        readMeminfo: () => meminfo({ availableGiB: 2.5, swapFreeGiB: 0.3 }),
        bootId: "boot-x",
        nowMs: 5_000,
      });
      expect(first.state.level).toBe("blocked"); // first critical sample pre-escalates to blocked
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
      expect(isGuardStateStale(persisted, { nowMs: 35_000 + 1_000, bootId: "boot-x" })).toBe(false);
      expect(isGuardStateStale(persisted, { nowMs: 35_000 + 76_000, bootId: "boot-x" })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
