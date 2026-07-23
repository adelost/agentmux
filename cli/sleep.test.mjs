import { expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { cmdSleep, cmdSleepWatch, cmdWake } from "./sleep.mjs";
import { observePane } from "./sleep-probes.mjs";
import { readPaneSleepState, writePaneSleepState } from "../core/pane-sleep.mjs";

const NOW = Date.parse("2026-07-20T12:00:00Z");

let errorSpy;
let logSpy;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

function leaseQueue() {
  const lease = { release: vi.fn() };
  return {
    lease,
    list: () => [],
    acquireSessionLease: vi.fn(() => lease),
  };
}

function baseContext() {
  return {
    socket: "/tmp/amux.sock",
    bridgeDir: "/release",
    configPath: "/tmp/agents.yaml",
    agent: {
      capturePromptEchoCursor: vi.fn(async () => ({
        kind: "claude-prompt-events-v1",
        positions: { "/tmp/session.jsonl": 10 },
      })),
      sendOnly: vi.fn(async () => ({ submitted: true })),
      waitForPromptEcho: vi.fn(async () => true),
      isBusy: vi.fn(async () => false),
      getResponseStreamWithRaw: vi.fn(async (_name, _pane, prompt) => {
        const nonce = /AMUX-SLEEP-CHECK ([0-9a-f]+)/u.exec(prompt)?.[1];
        return {
          source: "jsonl",
          items: [{ type: "text", content: `AMUX_SLEEP_CHECK_${nonce}_OK` }],
        };
      }),
      paneProcessState: vi.fn(async () => ({ running: true, shell: false, command: "node" })),
      ensureReady: vi.fn(async () => {}),
    },
  };
}

function successFixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "amux-sleep-command-"));
  const queue = leaseQueue();
  const ctx = baseContext();
  let observeCount = 0;
  const observe = vi.fn(async () => ({
    ok: true,
    reason: "ok",
    identity: { sessionId: observeCount++ === 0 ? "before" : "after" },
    processGeneration: "pane:pid:start",
    facts: {},
    lastActivityMs: NOW - 25 * 60 * 60 * 1000,
  }));
  const slashCalls = [];
  const sendSlash = vi.fn(async (_agent, _name, _pane, command) => {
    slashCalls.push(command);
    if (command === "/exit") {
      ctx.agent.paneProcessState = vi.fn(async () => ({
        running: false,
        shell: true,
        command: "bash",
      }));
    }
    return { delivered: true, via: "command-receipt" };
  });
  const deps = {
    agents: [{
      name: "lsrc",
      dir: "/tmp/lsrc",
      panes: Array.from({ length: 4 }, () => ({ cmd: "claude --continue" })),
    }],
    queue,
    observe,
    latestIdentity: () => ({ sessionId: "after" }),
    sendSlash,
    hasCompactBoundary: () => true,
    hasActivityAfterCursor: () => false,
    uuid: () => "12345678-1234-1234-1234-123456789abc",
    now: () => NOW,
    sleep: async () => {},
    stateRoot,
    exit: vi.fn(),
  };
  return { ctx, deps, queue, slashCalls, stateRoot };
}

feature("exact Claude sleep sequence", () => {
  unit("compact, nonce response, two observations, and graceful exit produce asleep state", {
    given: ["a fully proven idle pane", () => successFixture()],
    when: ["sleeping it", async (fixture) => {
      await cmdSleep(fixture.ctx, "lsrc", 3, {}, fixture.deps);
      return fixture;
    }],
    then: ["the exact sequence commits one durable asleep generation", (fixture) => {
      expect(fixture.slashCalls).toEqual(["/compact", "/exit"]);
      expect(fixture.ctx.agent.sendOnly).toHaveBeenCalledWith(
        "lsrc",
        expect.stringContaining("AMUX-SLEEP-CHECK 1234567812341234"),
        3,
      );
      expect(fixture.deps.observe).toHaveBeenCalledTimes(3);
      expect(readPaneSleepState("lsrc", 3, { rootDir: fixture.stateRoot })).toMatchObject({
        status: "asleep",
        stage: "asleep",
        sleepGeneration: 1,
        sessionId: "after",
        receipt: {
          compactBoundary: true,
          response: "AMUX_SLEEP_CHECK_1234567812341234_OK",
          observations: 2,
        },
      });
      expect(fixture.queue.lease.release).toHaveBeenCalledOnce();
      expect(fixture.deps.exit).not.toHaveBeenCalled();
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });

  unit("new activity at the final fence blocks sleep before exit", {
    given: ["the same fixture with appended activity", () => {
      const fixture = successFixture();
      fixture.deps.hasActivityAfterCursor = () => true;
      return fixture;
    }],
    when: ["attempting sleep", async (fixture) => {
      await cmdSleep(fixture.ctx, "lsrc", 3, {}, fixture.deps);
      return fixture;
    }],
    then: ["no exit is sent and the reason is durable", (fixture) => {
      expect(fixture.slashCalls).toEqual(["/compact"]);
      expect(fixture.deps.exit).toHaveBeenCalledWith(1);
      expect(readPaneSleepState("lsrc", 3, { rootDir: fixture.stateRoot })).toMatchObject({
        status: "blocked",
        blockedReason: "activity-after-sleep-check",
      });
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });

  unit("a busy delivery lease refuses before any pane write", {
    given: ["a queue whose broker owns the session", () => {
      const fixture = successFixture();
      fixture.deps.queue.acquireSessionLease = () => null;
      return fixture;
    }],
    when: ["attempting sleep", async (fixture) => {
      await cmdSleep(fixture.ctx, "lsrc", 3, {}, fixture.deps);
      return fixture;
    }],
    then: ["the command is side-effect free", (fixture) => {
      expect(fixture.slashCalls).toEqual([]);
      expect(fixture.ctx.agent.sendOnly).not.toHaveBeenCalled();
      expect(fixture.deps.exit).toHaveBeenCalledWith(1);
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });
});

feature("exact-session wake", () => {
  unit("a mismatched on-disk session is refused before ensureReady", {
    given: ["an asleep manifest for a different session", () => {
      const fixture = successFixture();
      writePaneSleepState({
        version: 1,
        agentName: "lsrc",
        pane: 3,
        status: "asleep",
        stage: "asleep",
        sleepGeneration: 1,
        sessionId: "expected",
      }, { rootDir: fixture.stateRoot });
      fixture.deps.latestIdentity = () => ({ sessionId: "other" });
      fixture.deps.gate = async () => ({ ok: true });
      return fixture;
    }],
    when: ["waking", async (fixture) => {
      await cmdWake(fixture.ctx, "lsrc", 3, {}, fixture.deps);
      return fixture;
    }],
    then: ["the wrong session never starts", (fixture) => {
      expect(fixture.ctx.agent.ensureReady).not.toHaveBeenCalled();
      expect(fixture.deps.exit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith("wake-refused:sleep-session-mismatch");
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });

  unit("the exact asleep session becomes awake after verified start", {
    given: ["an asleep exact manifest", () => {
      const fixture = successFixture();
      writePaneSleepState({
        version: 1,
        agentName: "lsrc",
        pane: 3,
        status: "asleep",
        stage: "asleep",
        sleepGeneration: 2,
        sessionId: "after",
      }, { rootDir: fixture.stateRoot });
      fixture.deps.gate = async () => ({ ok: true });
      return fixture;
    }],
    when: ["waking", async (fixture) => {
      await cmdWake(fixture.ctx, "lsrc", 3, {}, fixture.deps);
      return fixture;
    }],
    then: ["ensureReady runs once and state becomes awake", (fixture) => {
      expect(fixture.ctx.agent.ensureReady).toHaveBeenCalledOnce();
      expect(readPaneSleepState("lsrc", 3, { rootDir: fixture.stateRoot })).toMatchObject({
        status: "awake",
        sleepGeneration: 2,
      });
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });
});

feature("candidate watch", () => {
  unit("unsupported engines fail closed before expensive fleet probes", {
    given: ["a Codex pane and probe methods that must remain untouched", () => {
      const ctx = baseContext();
      ctx.agent.paneProcessState = vi.fn();
      ctx.agent.promptTransportState = vi.fn();
      ctx.agent.isBusy = vi.fn();
      ctx.agent.capturePane = vi.fn();
      return {
        ctx,
        agent: { name: "lsrc", dir: "/tmp/lsrc", panes: [{ cmd: "codex" }] },
        exec: vi.fn(() => { throw new Error("must not probe"); }),
      };
    }],
    when: ["observing the pane", ({ ctx, agent, exec }) => observePane(ctx, agent, 0, {
      exec,
      queue: leaseQueue(),
      readFile: vi.fn(),
      nowMs: NOW,
    })],
    then: ["the engine is refused without touching runtime or filesystem probes", (result, fixture) => {
      expect(result).toMatchObject({ ok: false, reason: "unsupported-engine" });
      expect(fixture.exec).not.toHaveBeenCalled();
      expect(fixture.ctx.agent.paneProcessState).not.toHaveBeenCalled();
      expect(fixture.ctx.agent.capturePane).not.toHaveBeenCalled();
    }],
  });

  unit("recent Claude activity refuses before process, git, or tmux probes", {
    given: ["a Claude pane used one hour ago", () => {
      const ctx = baseContext();
      ctx.agent.paneProcessState = vi.fn();
      ctx.agent.promptTransportState = vi.fn();
      ctx.agent.isBusy = vi.fn();
      ctx.agent.capturePane = vi.fn();
      return {
        ctx,
        agent: { name: "lsrc", dir: "/tmp/lsrc", panes: [{ cmd: "claude" }] },
        exec: vi.fn(() => { throw new Error("must not probe"); }),
      };
    }],
    when: ["observing the pane", ({ ctx, agent, exec }) => observePane(ctx, agent, 0, {
      exec,
      queue: leaseQueue(),
      readFile: vi.fn(),
      nowMs: NOW,
      activity: () => NOW - 60 * 60_000,
    })],
    then: ["the 24-hour gate refuses without expensive probes", (result, fixture) => {
      expect(result).toMatchObject({ ok: false, reason: "idle-threshold-not-met" });
      expect(fixture.exec).not.toHaveBeenCalled();
      expect(fixture.ctx.agent.paneProcessState).not.toHaveBeenCalled();
      expect(fixture.ctx.agent.capturePane).not.toHaveBeenCalled();
    }],
  });

  unit("dry mode reports only the conservative candidates and never sleeps", {
    given: ["one Claude candidate and one unsupported pane", () => {
      const logs = [];
      const ctx = baseContext();
      const queue = leaseQueue();
      return {
        ctx,
        logs,
        deps: {
          agents: [{ name: "lsrc", dir: "/tmp/lsrc", panes: [
            { cmd: "claude" },
            { cmd: "kimi-code" },
          ] }],
          queue,
          observe: vi.fn(async (_ctx, _agent, pane) => ({
            ok: pane === 0,
            facts: pane === 0 ? {
              engine: "claude",
              busy: false,
              paneStatus: "idle",
              transportState: "empty-idle",
              liveDeliveryJobs: 0,
              worktreeClean: true,
              rebaseInProgress: false,
              processRunning: true,
              attached: false,
              excluded: false,
            } : {
              engine: "unsupported",
              busy: false,
              paneStatus: "idle",
              transportState: "empty-idle",
              liveDeliveryJobs: 0,
              worktreeClean: true,
              rebaseInProgress: false,
              processRunning: true,
              attached: false,
              excluded: false,
            },
            lastActivityMs: NOW - 25 * 60 * 60 * 1000,
            processGeneration: "p",
          })),
          now: () => NOW,
          log: (line) => logs.push(line),
        },
      };
    }],
    when: ["running a dry sweep", async (fixture) => {
      await cmdSleepWatch(fixture.ctx, { dry: true }, fixture.deps);
      return fixture;
    }],
    then: ["only lsrc:0 is shown", (fixture) => {
      expect(fixture.logs).toHaveLength(1);
      expect(fixture.logs[0]).toContain("lsrc:0");
      expect(fixture.logs[0]).not.toContain("lsrc:1:");
    }],
  });
});

const STALE = NOW - 20 * 60 * 1000;

function interruptedRecord(status, overrides = {}) {
  return {
    version: 1,
    agentName: "lsrc",
    pane: 3,
    status,
    stage: status,
    sleepGeneration: 3,
    sessionId: "after",
    processGeneration: "pane:pid:start",
    armedAt: STALE,
    updatedAt: STALE,
    ...overrides,
  };
}

feature("interrupted sleep recovery", () => {
  unit("a stale arming record over a live working pane clears and sleep refuses", {
    given: ["a stale arming record and a busy pane", () => {
      const fixture = successFixture();
      writePaneSleepState(interruptedRecord("arming", {
        stage: "pre-compact",
        sleepGeneration: 1,
      }), { rootDir: fixture.stateRoot });
      fixture.deps.observe = vi.fn(async () => ({
        ok: false,
        reason: "active-or-unknown-turn",
        facts: {},
        identity: null,
        processGeneration: null,
        lastActivityMs: null,
      }));
      return fixture;
    }],
    when: ["attempting sleep", async (fixture) => {
      await cmdSleep(fixture.ctx, "lsrc", 3, {}, fixture.deps);
      return fixture;
    }],
    then: ["the record is awake, nothing was sent, and the pane was never slept", (fixture) => {
      expect(readPaneSleepState("lsrc", 3, { rootDir: fixture.stateRoot })).toMatchObject({
        status: "awake",
        repairedFrom: "arming",
      });
      expect(fixture.slashCalls).toEqual([]);
      expect(fixture.deps.exit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith("active-or-unknown-turn");
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });

  unit("a blocked pane that is provably asleep wakes under force", {
    given: ["a blocked record and a stopped pane behind a refusing gate", () => {
      const fixture = successFixture();
      writePaneSleepState(interruptedRecord("blocked", {
        blockedReason: "sleep-shell-unverified",
      }), { rootDir: fixture.stateRoot });
      fixture.deps.gate = async () => ({ ok: false, reason: "memory-critical" });
      let started = false;
      fixture.ctx.agent.ensureReady = vi.fn(async () => { started = true; });
      fixture.ctx.agent.paneProcessState = vi.fn(async () => (started
        ? { running: true, shell: false, command: "node" }
        : { running: false, shell: true, command: "bash" }));
      return fixture;
    }],
    when: ["force waking", async (fixture) => {
      await cmdWake(fixture.ctx, "lsrc", 3, { force: true }, fixture.deps);
      return fixture;
    }],
    then: ["the exact session starts and the record ends awake", (fixture) => {
      expect(fixture.ctx.agent.ensureReady).toHaveBeenCalledOnce();
      expect(readPaneSleepState("lsrc", 3, { rootDir: fixture.stateRoot })).toMatchObject({
        status: "awake",
        sleepGeneration: 3,
      });
      expect(fixture.deps.exit).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("WAKE lsrc:3 generation=3");
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });

  unit("a blocked pane with a live active process stays refused under force", {
    given: ["a blocked record and a running pane", () => {
      const fixture = successFixture();
      writePaneSleepState(interruptedRecord("blocked", {
        blockedReason: "sleep-shell-unverified",
      }), { rootDir: fixture.stateRoot });
      fixture.deps.gate = async () => ({ ok: true });
      fixture.ctx.agent.paneProcessState = vi.fn(async () => ({
        running: true,
        shell: false,
        command: "node",
      }));
      return fixture;
    }],
    when: ["force waking", async (fixture) => {
      await cmdWake(fixture.ctx, "lsrc", 3, { force: true }, fixture.deps);
      return fixture;
    }],
    then: ["wake refuses and the record stays blocked", (fixture) => {
      expect(fixture.ctx.agent.ensureReady).not.toHaveBeenCalled();
      expect(fixture.deps.exit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith("wake-refused:sleep-state-blocked-pane-awake");
      expect(readPaneSleepState("lsrc", 3, { rootDir: fixture.stateRoot })).toMatchObject({
        status: "blocked",
        blockedReason: "sleep-shell-unverified",
      });
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });

  unit("a stale wake_pending record over a stopped pane re-arms as asleep", {
    given: ["a stuck wake_pending record and a stopped pane", () => {
      const fixture = successFixture();
      writePaneSleepState(interruptedRecord("wake_pending", {
        stage: "wake-intent",
        wakeRequestedAt: STALE,
      }), { rootDir: fixture.stateRoot });
      fixture.ctx.agent.paneProcessState = vi.fn(async () => ({
        running: false,
        shell: true,
        command: "bash",
      }));
      return fixture;
    }],
    when: ["attempting sleep", async (fixture) => {
      await cmdSleep(fixture.ctx, "lsrc", 3, {}, fixture.deps);
      return fixture;
    }],
    then: ["the record lands asleep and sleep refuses without pane writes", (fixture) => {
      expect(readPaneSleepState("lsrc", 3, { rootDir: fixture.stateRoot })).toMatchObject({
        status: "asleep",
        repairedFrom: "wake_pending",
      });
      expect(fixture.slashCalls).toEqual([]);
      expect(fixture.deps.exit).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith("sleep-state-asleep");
      rmSync(fixture.stateRoot, { recursive: true, force: true });
    }],
  });
});
