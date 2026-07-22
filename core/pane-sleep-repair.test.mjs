import { expect, feature, unit } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockedWakeDecision,
  createPaneSleepRepair,
  listPaneSleepStates,
  PANE_SLEEP_REPAIR_TTL_MS,
  planSleepRepair,
} from "./pane-sleep-repair.mjs";
import { createPaneSleepWakeLifecycle } from "./pane-sleep-wake.mjs";
import { readPaneSleepState, writePaneSleepState } from "./pane-sleep.mjs";
import { claudeProjectDir } from "./claude-paths.mjs";

const NOW = Date.parse("2026-07-20T12:00:00Z");
const STALE = NOW - PANE_SLEEP_REPAIR_TTL_MS - 60_000;
const SESSION = "11111111-1111-4111-8111-111111111111";

function interrupted(status, overrides = {}) {
  return {
    version: 1,
    agentName: "lsrc",
    pane: 3,
    status,
    stage: status,
    sleepGeneration: 4,
    sessionId: "session-a",
    processGeneration: "pane:pid:start",
    armedAt: STALE,
    updatedAt: STALE,
    ...overrides,
  };
}

feature("stale interrupted records are re-judged against process truth", () => {
  unit("an arming record older than the TTL with an exited process becomes asleep", {
    given: ["a stale arming record and a stopped pane with its session saved", () => ({
      state: interrupted("arming"),
      truth: { running: false, sessionId: "session-a" },
    })],
    when: ["planning the repair", ({ state, truth }) => planSleepRepair({ state, truth, nowMs: NOW })],
    then: ["the record lands asleep with provenance", (plan) => {
      expect(plan.action).toBe("asleep");
      expect(plan.reason).toBe("repair-process-exited");
      expect(plan.state).toMatchObject({
        status: "asleep",
        stage: "asleep",
        sleepGeneration: 4,
        sessionId: "session-a",
        repairedFrom: "arming",
        sleptAt: NOW,
      });
    }],
  });

  unit("an arming record over a live working pane clears to awake", {
    given: ["a stale arming record and a running pane", () => ({
      state: interrupted("arming"),
      truth: { running: true, sessionId: "session-a" },
    })],
    when: ["planning the repair", ({ state, truth }) => planSleepRepair({ state, truth, nowMs: NOW })],
    then: ["the record clears and nothing is slept", (plan) => {
      expect(plan.action).toBe("clear");
      expect(plan.reason).toBe("repair-process-running");
      expect(plan.state).toMatchObject({ status: "awake", stage: "awake", repairedFrom: "arming" });
    }],
  });

  unit("a stuck wake_pending record is re-judged the same way", {
    given: ["a stale wake_pending record", () => interrupted("wake_pending", { wakeRequestedAt: STALE })],
    when: ["planning both truths", (state) => [
      planSleepRepair({ state, truth: { running: false, sessionId: "session-a" }, nowMs: NOW }),
      planSleepRepair({ state, truth: { running: true, sessionId: "session-a" }, nowMs: NOW }),
    ]],
    then: ["a stopped pane lands asleep and a started pane clears", ([stopped, started]) => {
      expect(stopped.action).toBe("asleep");
      expect(stopped.state).toMatchObject({ status: "asleep", repairedFrom: "wake_pending" });
      expect(started.action).toBe("clear");
      expect(started.state).toMatchObject({ status: "awake", repairedFrom: "wake_pending" });
    }],
  });

  unit("fresh, unknown, mismatched, or settled records stay parked", {
    given: ["one record per unclear class", () => ({
      fresh: interrupted("arming", { updatedAt: NOW - 60_000 }),
      settled: interrupted("asleep"),
      stale: interrupted("arming"),
    })],
    when: ["planning each", ({ fresh, settled, stale }) => [
      planSleepRepair({ state: fresh, truth: { running: false, sessionId: "session-a" }, nowMs: NOW }),
      planSleepRepair({ state: stale, truth: null, nowMs: NOW }),
      planSleepRepair({ state: stale, truth: { running: false, sessionId: "other" }, nowMs: NOW }),
      planSleepRepair({ state: settled, truth: { running: false, sessionId: "session-a" }, nowMs: NOW }),
    ]],
    then: ["nothing changes without proof", ([fresh, unknown, mismatch, settled]) => {
      expect(fresh).toMatchObject({ action: "hold", reason: "repair-ttl-not-met" });
      expect(unknown).toMatchObject({ action: "hold", reason: "repair-truth-unknown" });
      expect(mismatch).toMatchObject({ action: "hold", reason: "repair-session-mismatch" });
      expect(settled).toMatchObject({ action: "hold", reason: "repair-not-applicable" });
    }],
  });
});

feature("a blocked record is re-verified, never trusted blindly", () => {
  unit("a provably stopped pane with its exact session may wake", {
    given: ["a blocked record and sleeping truth", () => ({
      state: interrupted("blocked", { blockedReason: "sleep-shell-unverified" }),
      truth: { running: false, sessionId: "session-a" },
    })],
    when: ["deciding", ({ state, truth }) => blockedWakeDecision({ state, truth })],
    then: ["the wake is tracked", (verdict) => {
      expect(verdict).toEqual({ ok: true, tracked: true, action: "wake", reason: "blocked-truth-asleep" });
    }],
  });

  unit("a live pane clears the record but starts nothing", {
    given: ["a blocked record and running truth", () => ({
      state: interrupted("blocked"),
      truth: { running: true, sessionId: "session-a" },
    })],
    when: ["deciding", ({ state, truth }) => blockedWakeDecision({ state, truth })],
    then: ["the verdict is an untracked clear", (verdict) => {
      expect(verdict).toEqual({ ok: true, tracked: false, action: "clear", reason: "blocked-truth-awake" });
    }],
  });

  unit("unknown truth and session mismatch stay refused", {
    given: ["a blocked record", () => interrupted("blocked")],
    when: ["deciding both", (state) => [
      blockedWakeDecision({ state, truth: { running: null, sessionId: null } }),
      blockedWakeDecision({ state, truth: { running: false, sessionId: "other" } }),
      blockedWakeDecision({ state: interrupted("arming"), truth: { running: false, sessionId: "session-a" } }),
    ]],
    then: ["both fail closed", ([unknown, mismatch, notBlocked]) => {
      expect(unknown).toEqual({ ok: false, reason: "sleep-state-blocked" });
      expect(mismatch).toEqual({ ok: false, reason: "sleep-session-mismatch" });
      expect(notBlocked).toEqual({ ok: false, reason: "sleep-state-not-blocked" });
    }],
  });
});

function repairFixture({ records, probes = {}, identities = {} }) {
  const stateRoot = mkdtempSync(join(tmpdir(), "amux-sleep-repair-"));
  for (const record of records) writePaneSleepState(record, { rootDir: stateRoot });
  const repair = createPaneSleepRepair({
    resolvePane: (agentName, pane) => ({ paneDir: `/fake/${agentName}/${pane}`, engine: "claude" }),
    processState: async (agentName, pane) => probes[`${agentName}:${pane}`] ?? null,
    latestIdentity: (paneDir) => {
      const sessionId = identities[paneDir];
      return sessionId ? { sessionId } : null;
    },
    stateRoot,
    now: () => NOW,
  });
  return { stateRoot, repair };
}

feature("the repair pass persists only proven transitions", () => {
  unit("a stale arming record over a dead process lands asleep and can wake", {
    given: ["one stale arming record and a stopped pane", () => repairFixture({
      records: [interrupted("arming")],
      probes: { "lsrc:3": { running: false, shell: true } },
      identities: { "/fake/lsrc/3": "session-a" },
    })],
    when: ["repairing the pane", async (fixture) => ({
      ...fixture,
      result: await fixture.repair.repairPane({ agentName: "lsrc", pane: 3 }),
    })],
    then: ["the durable record is asleep", (fixture) => {
      expect(fixture.result).toMatchObject({ action: "asleep", reason: "repair-process-exited" });
      expect(readPaneSleepState("lsrc", 3, { rootDir: fixture.stateRoot })).toMatchObject({
        status: "asleep",
        sleepGeneration: 4,
        sessionId: "session-a",
        repairedFrom: "arming",
      });
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });

  unit("the sweep repairs stale records and leaves settled or unclear ones alone", {
    given: ["four records in different states", () => repairFixture({
      records: [
        interrupted("arming", { pane: 1, sessionId: "s1" }),
        interrupted("wake_pending", { pane: 2, sessionId: "s2", wakeRequestedAt: STALE }),
        interrupted("arming", { pane: 4, sessionId: "s4", updatedAt: NOW - 60_000, armedAt: NOW - 60_000 }),
        interrupted("blocked", { pane: 5, sessionId: "s5", blockedReason: "sleep-shell-unverified" }),
      ],
      probes: {
        "lsrc:1": { running: false, shell: true },
        "lsrc:2": { running: true, shell: false },
        "lsrc:4": { running: false, shell: true },
        "lsrc:5": { running: false, shell: true },
      },
      identities: {
        "/fake/lsrc/1": "s1",
        "/fake/lsrc/2": "s2",
        "/fake/lsrc/4": "s4",
        "/fake/lsrc/5": "s5",
      },
    })],
    when: ["sweeping", async (fixture) => ({ ...fixture, results: await fixture.repair.sweep() })],
    then: ["each record lands in its proven end state", (fixture) => {
      const read = (pane) => readPaneSleepState("lsrc", pane, { rootDir: fixture.stateRoot });
      expect(read(1)).toMatchObject({ status: "asleep", repairedFrom: "arming" });
      expect(read(2)).toMatchObject({ status: "awake", repairedFrom: "wake_pending" });
      expect(read(4)).toMatchObject({ status: "arming" });
      expect(read(5)).toMatchObject({ status: "blocked", blockedReason: "sleep-shell-unverified" });
      expect(fixture.results.map((result) => result.action).sort())
        .toEqual(["asleep", "clear", "hold", "hold"]);
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });

  unit("the sweep never clears a pane whose truth cannot be read", {
    given: ["one stale arming record and an unresolvable probe", () => repairFixture({
      records: [interrupted("arming")],
    })],
    when: ["sweeping", async (fixture) => ({ ...fixture, results: await fixture.repair.sweep() })],
    then: ["the record stays arming", (fixture) => {
      expect(fixture.results[0]).toMatchObject({ action: "hold", reason: "repair-truth-unknown" });
      expect(readPaneSleepState("lsrc", 3, { rootDir: fixture.stateRoot })).toMatchObject({ status: "arming" });
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });

  unit("record listing skips malformed files", {
    given: ["a state root with one valid and two invalid files", () => {
      const rootDir = mkdtempSync(join(tmpdir(), "amux-sleep-list-"));
      writePaneSleepState(interrupted("asleep"), { rootDir });
      writeFileSync(join(rootDir, "broken.json"), "{not json");
      writeFileSync(join(rootDir, "note.txt"), "{}");
      writeFileSync(join(rootDir, "wrong-version.json"), JSON.stringify({ version: 99 }));
      return { rootDir };
    }],
    when: ["listing", ({ rootDir }) => ({ rootDir, states: listPaneSleepStates({ rootDir }) })],
    then: ["only the valid record returns", ({ rootDir, states }) => {
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({ agentName: "lsrc", pane: 3, status: "asleep" });
      rmSync(rootDir, { recursive: true, force: true });
    }],
  });
});

function blockedLifecycleFixture({ probe } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-sleep-unblock-"));
  const paneDir = join(root, "workspace", ".agents", "3");
  const homeDir = join(root, "home");
  const projectDir = claudeProjectDir(paneDir, homeDir);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION}.jsonl`), "\n");
  const stateRoot = join(root, "state");
  writePaneSleepState({
    version: 1,
    agentName: "lsrc",
    pane: 3,
    status: "blocked",
    stage: "blocked",
    blockedReason: "sleep-shell-unverified",
    sleepGeneration: 7,
    sessionId: SESSION,
    updatedAt: STALE,
  }, { rootDir: stateRoot });
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const lifecycle = createPaneSleepWakeLifecycle({
    resolvePane: () => ({ paneDir, engine: "claude" }),
    processState: probe === undefined ? undefined : async () => probe,
    stateRoot,
    now: () => NOW,
  });
  return {
    root,
    stateRoot,
    lifecycle,
    restore: () => {
      process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

feature("durable delivery re-verifies a blocked pane through the lifecycle", () => {
  unit("a provably sleeping blocked pane wakes and completes", {
    given: ["a blocked record and a stopped pane", () => blockedLifecycleFixture({
      probe: { running: false, shell: true },
    })],
    when: ["preparing and completing", async (ctx) => {
      const token = await ctx.lifecycle.prepare({ agentName: "lsrc", pane: 3 });
      const completed = await ctx.lifecycle.complete({
        agentName: "lsrc",
        pane: 3,
        token,
        processState: { running: true },
      });
      return { ...ctx, token, completed };
    }],
    then: ["the exact session wakes and the delivery can proceed", (ctx) => {
      expect(ctx.token).toMatchObject({
        ok: true,
        tracked: true,
        sessionId: SESSION,
        sleepGeneration: 7,
      });
      expect(ctx.completed).toEqual({ ok: true, tracked: true });
      expect(readPaneSleepState("lsrc", 3, { rootDir: ctx.stateRoot })).toMatchObject({
        status: "awake",
        sleepGeneration: 7,
      });
      ctx.restore();
    }],
  });

  unit("a blocked pane already running clears without starting anything", {
    given: ["a blocked record and a live pane", () => blockedLifecycleFixture({
      probe: { running: true, shell: false },
    })],
    when: ["preparing", async (ctx) => ({ ...ctx, token: await ctx.lifecycle.prepare({ agentName: "lsrc", pane: 3 }) })],
    then: ["the record clears untracked so delivery proceeds", (ctx) => {
      expect(ctx.token).toEqual({ ok: true, tracked: false });
      expect(readPaneSleepState("lsrc", 3, { rootDir: ctx.stateRoot })).toMatchObject({
        status: "awake",
        repairedFrom: "blocked",
      });
      ctx.restore();
    }],
  });

  unit("an unverifiable blocked pane stays refused", {
    given: ["a blocked record and no process probe", () => blockedLifecycleFixture()],
    when: ["preparing", async (ctx) => ({ ...ctx, token: await ctx.lifecycle.prepare({ agentName: "lsrc", pane: 3 }) })],
    then: ["the refusal keeps the record blocked", (ctx) => {
      expect(ctx.token).toEqual({ ok: false, reason: "sleep-state-blocked" });
      expect(readPaneSleepState("lsrc", 3, { rootDir: ctx.stateRoot })).toMatchObject({
        status: "blocked",
        blockedReason: "sleep-shell-unverified",
      });
      ctx.restore();
    }],
  });
});
