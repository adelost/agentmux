import { component, expect, feature } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue as localQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker as localBroker } from "./delivery-broker.mjs";
import { createTmuxAdapter as localTmux } from "./tmux.mjs";
import { createState as localState } from "./state.mjs";
import { pathToFileURL } from "node:url";
import { isQuotaFloorHeldJob } from "./delivery-wake.mjs";

// The same owner-level exercise can read the exact installed package after release.
const packageRoot = process.env.AMUX_PREPARATION_PROOF_PACKAGE_ROOT;
const load = (path, local) => packageRoot ? import(pathToFileURL(join(packageRoot, path)).href) : local;
const { createDeliveryQueue } = await load("core/delivery-queue.mjs", { createDeliveryQueue: localQueue });
const { createDeliveryBroker } = await load("core/delivery-broker.mjs", { createDeliveryBroker: localBroker });
const { createTmuxAdapter } = await load("core/tmux.mjs", { createTmuxAdapter: localTmux });
const { createState } = await load("core/state.mjs", { createState: localState });

const faults = vi.hoisted(() => ({ receipt: false, paneLease: false }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, writeFileSync(path, data, ...args) {
    if (faults.receipt && String(data).includes('"status": "acknowledged"')) {
      faults.receipt = false;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return fs.writeFileSync(path, data, ...args);
  }, writeSync(fd, ...args) {
    if (faults.paneLease && fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith(".consumer.lock")) {
      faults.paneLease = false;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return fs.writeSync(fd, ...args);
  } };
});

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-storage-recovery-"));
  const clock = { value: Date.now() };
  const now = () => clock.value;
  const queue = createDeliveryQueue({ rootDir, now });
  const echoed = new Set(), sends = [], logs = [], receiptWaits = [];
  const agent = {
    capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
    waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
    dismissBlockingPrompt: async () => {},
    sendOnly: async (_name, text, pane, options) => {
      sends.push(pane);
      await options.onDrafted?.();
      await options.onSubmitting?.();
      await options.onSubmitted?.();
      echoed.add(text);
      return { submitted: true };
    },
  };
  const broker = createDeliveryBroker({ agent, queue, now, log: message => logs.push(message) });
  const first = queue.enqueue({ agentName: "api", pane: 5, text: "first" });
  const human = queue.enqueue({ agentName: "api", pane: 0, text: "human", source: "discord" });
  return { rootDir, queue, agent, broker, first, human, sends, logs, receiptWaits, clock };
}

feature("delivery storage failure recovery", () => {
  component("the default unsent bound releases at sixty seconds on its monotonic clock", {
    given: ["a never-settling pane read and a named fake timer/performance clock", () => {
      vi.useFakeTimers();
      const ctx = fixture();
      ctx.agent.paneProcessState = () => new Promise(() => {});
      return ctx;
    }],
    when: ["the caller's wall clock jumps but the monotonic sixty-second budget passes", async ctx => {
      let ended = false;
      const drain = ctx.broker.kickTarget("api", 5).then(() => { ended = true; });
      await vi.advanceTimersByTimeAsync(59_999);
      const early = ended;
      vi.setSystemTime(Date.now() + 86_400_000);
      await vi.advanceTimersByTimeAsync(1);
      await drain;
      return { early, ended };
    }],
    then: ["the default bound is independent of the wall-clock correction", ({ early, ended }, ctx) => {
      expect(early).toBe(false); expect(ended).toBe(true);
      expect(ctx.queue.read("api", 5, ctx.first.id).lastReason).toBe("preparation-timeout:paneProcessState:60000ms");
    }], cleanup: ctx => { vi.useRealTimers(); rmSync(ctx.rootDir, { recursive: true, force: true }); },
  });

  for (const status of ["pending", "pasting", "drafted", "submitting", "submitted"]) {
    component(`a late cursor cannot overwrite the current ${status} job or erase its physical fence`, {
      given: ["the journal cursor read is held while the actual queue contains its exact current state", () => {
        const ctx = fixture();
        ctx.queue.update(ctx.first, { status, draftOwned: ["pasting", "drafted"].includes(status),
          ...(["submitting", "submitted"].includes(status) ? { submitFenceAt: Date.now() } : {}) });
        let release;
        ctx.agent.capturePromptEchoCursor = () => new Promise(resolve => { release = resolve; });
        ctx.broker = createDeliveryBroker({ agent: ctx.agent, queue: ctx.queue, preparationTimeoutMs: 20,
          log: message => ctx.logs.push(message) });
        return { ...ctx, release: value => release(value) };
      }],
      when: ["the bound ends and a new owner stores its cursor before the stale read returns", async ctx => {
        await ctx.broker.kickTarget("api", 5);
        const current = ctx.queue.update(ctx.first, { echoCursor: { kind: "current-owner", positions: {} } });
        ctx.release({ kind: "stale-owner", positions: {} });
        await new Promise(resolve => setTimeout(resolve, 5));
        return current;
      }],
      then: ["no late cursor or input changes the newer result; physical states remain fenced", (current, ctx) => {
        const saved = ctx.queue.read("api", 5, ctx.first.id);
        expect(saved).toEqual(current);
        expect(saved.status).toBe(status);
        expect(ctx.sends).toEqual([]);
      }], cleanup: ctx => rmSync(ctx.rootDir, { recursive: true, force: true }),
    });
  }
  component("a stalled preparation releases its real session lease and names the unread stage", {
    given: ["the pane-state I/O never settles until after the preparation bound", () => {
      const ctx = fixture();
      let release;
      const held = new Promise(resolve => { release = resolve; });
      ctx.agent.paneProcessState = (_name, pane) => pane === 5 ? held : Promise.resolve({ running: true });
      ctx.broker = createDeliveryBroker({ agent: ctx.agent, queue: ctx.queue,
        preparationTimeoutMs: 20, log: message => ctx.logs.push(message) });
      return { ...ctx, release };
    }],
    when: ["the bound passes before the old read returns", async ctx => {
      const drain = ctx.broker.kickTarget("api", 5);
      const ended = await Promise.race([drain.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 60))]);
      const lease = ctx.queue.acquireSessionLease("api", 0);
      const released = Boolean(lease); lease?.release();
      const atStop = ctx.queue.read("api", 5, ctx.first.id);
      ctx.release({ running: true });
      await drain;
      await new Promise(resolve => setTimeout(resolve, 5));
      await ctx.broker.kickTarget("api", 0);
      return { ended, released, atStop };
    }],
    then: ["the sibling runs, the same job waits, and the old read cannot send", (result, ctx) => {
      try {
        expect(result.ended).toBe(true);
        expect(result.released).toBe(true);
        expect(result.atStop).toMatchObject({ status: "pending", draftOwned: false,
          lastReason: expect.stringContaining("preparation-timeout:paneProcessState") });
        expect(result.atStop.nextAttemptAt).toBeGreaterThan(result.atStop.lastAttemptAt);
        expect(ctx.queue.read("api", 0, ctx.human.id).status).toBe("acknowledged");
        expect(ctx.sends).toEqual([0]);
        expect(ctx.logs.some(line => line.includes("preparation-timeout:paneProcessState"))).toBe(true);
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });

  component("an expired admission continuation cannot type or overwrite queue and account state", {
    given: ["a captured admission owner holds I/O and catches individual write failures", () => {
      const ctx = fixture();
      const state = createState(join(ctx.rootDir, "state.json"));
      const writes = [], errors = [];
      // Named tmux-exec I/O double: the real adapter owns the physical dispatch guard.
      const tmux = createTmuxAdapter({ socket: "/unused-preparation-test", exec: async command => { writes.push(command); return { stdout: "" }; } });
      let release;
      const held = new Promise(resolve => { release = resolve; });
      ctx.agent.paneProcessState = async () => ({ running: true });
      const costAdmission = async job => {
        await held;
        for (const write of [() => tmux.sendLiteral("api:.5", "local test"),
          () => ctx.queue.update(job, { metadata: { staleAdmission: true } }), () => state.set("profile", "late"),
          () => ctx.queue.acquireSessionLease("api", 5)]) {
          try { await write(); } catch (error) { errors.push(error.code); }
        }
        return { ok: true };
      };
      ctx.broker = createDeliveryBroker({ agent: ctx.agent, queue: ctx.queue, costAdmission,
        preparationTimeoutMs: 20, log: message => ctx.logs.push(message) });
      return { ...ctx, state, writes, errors, release };
    }],
    when: ["the writer ends, then admission resumes after a newer owner has written", async ctx => {
      const drain = ctx.broker.kickTarget("api", 5);
      const ended = await Promise.race([drain.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 60))]);
      ctx.state.set("profile", "current");
      ctx.release(); await drain;
      await new Promise(resolve => setTimeout(resolve, 5));
      return ended;
    }],
    then: ["late physical input, stale cursor/job metadata and account state are all refused", (ended, ctx) => {
      try {
        expect(ended).toBe(true);
        expect(ctx.writes).toEqual([]);
        expect(ctx.errors).toEqual(Array(4).fill("AMUX_DELIVERY_PREPARATION_EXPIRED"));
        expect(ctx.state.get("profile")).toBe("current");
        expect(ctx.queue.read("api", 5, ctx.first.id).metadata.staleAdmission).toBeUndefined();
        expect(ctx.queue.read("api", 5, ctx.first.id).lastReason).toContain("preparation-timeout:cost-admission");
        expect(ctx.sends).toEqual([]);
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });

  component("a quota preparation timeout preserves the movable floor hold and the owner's ordinary input", {
    given: ["a floor-held automatic head with an unresolved reader and its owner's message on the same pane", () => {
      const ctx = fixture();
      const owner = ctx.queue.enqueue({ agentName: "api", pane: 5, text: "owner input", source: "discord", orderKey: "9999999999999999:owner" });
      let release;
      const held = new Promise(resolve => { release = resolve; });
      ctx.agent.paneProcessState = async () => ({ running: true });
      ctx.broker = createDeliveryBroker({ agent: ctx.agent, queue: ctx.queue, preparationTimeoutMs: 20,
        quotaFloor: { percent: 10, windowsFor: () => held }, log: message => ctx.logs.push(message) });
      return { ...ctx, owner, release };
    }],
    when: ["quota preparation expires, the owner is delivered and the old reader returns late", async ctx => {
      await ctx.broker.kickTarget("api", 5);
      const held = ctx.queue.read("api", 5, ctx.first.id);
      await ctx.broker.kickTarget("api", 5);
      ctx.release({ unavailable: true });
      await new Promise(resolve => setTimeout(resolve, 5));
      return held;
    }],
    then: ["the old automatic job stays held, exact-source account moves remain allowed, and only the owner is typed", (held, ctx) => {
      expect(isQuotaFloorHeldJob(held)).toBe(true);
      expect(held.lastReason).toContain("preparation-timeout:quota-floor:cached");
      expect(ctx.queue.read("api", 5, ctx.first.id)).toEqual(held);
      expect(ctx.queue.read("api", 5, ctx.owner.id).status).toBe("acknowledged");
      expect(ctx.sends).toEqual([5]);
    }], cleanup: ctx => rmSync(ctx.rootDir, { recursive: true, force: true }),
  });

  component("a real input dispatch preserves its physical fence beyond the preparation budget", {
    given: ["the real tmux adapter has dispatched input but its receipt I/O is held", () => {
      const ctx = fixture();
      let release;
      const held = new Promise(resolve => { release = resolve; });
      const tmux = createTmuxAdapter({ socket: "/unused-preparation-test", exec: async () => ({ stdout: "" }) });
      const send = ctx.agent.sendOnly;
      ctx.agent.sendOnly = async (name, text, pane, options) => {
        await options.onPasteStarted?.();
        await tmux.sendLiteral(`${name}:.${pane}`, text);
        await held;
        return send(name, text, pane, options);
      };
      ctx.broker = createDeliveryBroker({ agent: ctx.agent, queue: ctx.queue, preparationTimeoutMs: 20 });
      return { ...ctx, release };
    }],
    when: ["the unsent budget passes while actual input awaits its receipt", async ctx => {
      let ended = false;
      const drain = ctx.broker.kickTarget("api", 5).then(() => { ended = true; });
      await new Promise(resolve => setTimeout(resolve, 60));
      const atStop = ctx.queue.read("api", 5, ctx.first.id);
      const lease = ctx.queue.acquireSessionLease("api", 0);
      const released = Boolean(lease); lease?.release();
      const premature = ended;
      ctx.release(); await drain;
      return { atStop, released, premature };
    }],
    then: ["no unsent verdict or lease release abandons the already-started input", (result, ctx) => {
      try {
        expect(result.premature).toBe(false);
        expect(result.released).toBe(false);
        expect(result.atStop.status).toBe("pasting");
        expect(ctx.queue.read("api", 5, ctx.first.id).status).toBe("acknowledged");
        expect(ctx.sends).toEqual([5]);
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });

  component("a finished physical head does not disable the next head's preparation bound", {
    given: ["two prompts on one pane; the second cursor I/O is held after the first real input", () => {
      const ctx = fixture();
      ctx.queue.update(ctx.human, { status: "acknowledged" }); // This fixture has no waiting sibling.
      const next = ctx.queue.enqueue({ agentName: "api", pane: 5, text: "second", orderKey: "9999999999999999:second" });
      const tmux = createTmuxAdapter({ socket: "/unused-preparation-test", exec: async () => ({ stdout: "" }) });
      const send = ctx.agent.sendOnly;
      ctx.agent.sendOnly = async (name, text, pane, options) => {
        await tmux.sendLiteral(`${name}:.${pane}`, text);
        return send(name, text, pane, options);
      };
      let release;
      ctx.agent.capturePromptEchoCursor = (_name, _pane, text) => text === "second"
        ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ kind: "test", positions: {} });
      ctx.broker = createDeliveryBroker({ agent: ctx.agent, queue: ctx.queue, preparationTimeoutMs: 20,
        log: message => ctx.logs.push(message) });
      return { ...ctx, next, release: () => release(null) };
    }],
    when: ["the first input finishes and the next preparation expires", async ctx => {
      await ctx.broker.kickTarget("api", 5);
      ctx.release();
      await new Promise(resolve => setTimeout(resolve, 5));
    }],
    then: ["only the first prompt was delivered and the second remains the same deferred job", (_, ctx) => {
      expect(ctx.queue.read("api", 5, ctx.first.id).status).toBe("acknowledged");
      expect(ctx.queue.read("api", 5, ctx.next.id)).toMatchObject({ status: "pending",
        lastReason: expect.stringContaining("preparation-timeout:capturePromptEchoCursor") });
      expect(ctx.sends).toEqual([5]);
    }], cleanup: ctx => rmSync(ctx.rootDir, { recursive: true, force: true }),
  });
  component("a failed receipt write releases the session and retries the exact receipt", {
    given: ["api:5 can see its receipt but its acknowledgement write fails once", () => {
      const ctx = fixture();
      faults.receipt = true;
      return ctx;
    }],
    when: ["the write fails, a human reaches api:0, and the next round checks api:5", async ctx => {
      const failure = await ctx.broker.kickTarget("api", 5).catch(error => error);
      const afterFailure = ctx.queue.read("api", 5, ctx.first.id).status;
      await ctx.broker.kickTarget("api", 0);
      const sibling = ctx.queue.read("api", 0, ctx.human.id).status;
      const beforeRetry = ctx.queue.read("api", 5, ctx.first.id).status;
      ctx.clock.value += 1_001;
      await ctx.broker.kickTarget("api", 5);
      return { failure, afterFailure, sibling, beforeRetry };
    }],
    then: ["the failure is loud, the sibling passes, and no prompt is sent twice", (result, ctx) => {
      try {
        expect(result.failure.code).toBe("ENOSPC");
        expect(result.afterFailure).toBe("submitted");
        expect(result.beforeRetry).toBe("submitted");
        expect(result.sibling).toBe("acknowledged");
        expect(ctx.queue.read("api", 5, ctx.first.id).status).toBe("acknowledged");
        expect(ctx.sends).toEqual([5, 0]);
        expect(ctx.logs.some(line => line.includes("ENOSPC") && line.includes(ctx.first.id))).toBe(true);
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });

  component("a pane lock write failure cannot leak its already-acquired session lock", {
    given: ["the pane lease metadata write fails after the session lease was acquired", () => {
      const ctx = fixture();
      faults.paneLease = true;
      return ctx;
    }],
    when: ["the failed acquisition is followed by a sibling and a retry", async ctx => {
      const failure = await ctx.broker.kickTarget("api", 5).catch(error => error);
      await ctx.broker.kickTarget("api", 0);
      await ctx.broker.kickTarget("api", 5);
      return failure;
    }],
    then: ["both jobs recover in the same broker without a leaked kernel flock", (failure, ctx) => {
      try {
        expect(failure.code).toBe("ENOSPC");
        expect(ctx.queue.read("api", 0, ctx.human.id).status).toBe("acknowledged");
        expect(ctx.queue.read("api", 5, ctx.first.id).status).toBe("acknowledged");
        expect(ctx.sends).toEqual([0, 5]);
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });

  component("a submitted pane does not hold siblings while waiting for its receipt", {
    given: ["api:5 has submitted but its JSONL receipt is not yet visible", () => {
      const ctx = fixture();
      const check = ctx.agent.waitForPromptEcho;
      ctx.agent.waitForPromptEcho = async (name, pane, text, timeout) => {
        if (pane === 5) ctx.receiptWaits.push(timeout);
        return pane === 5 ? false : check(name, pane, text);
      };
      return ctx;
    }],
    when: ["both panes are drained", async ctx => {
      await ctx.broker.kickTarget("api", 5);
      await ctx.broker.kickTarget("api", 0);
    }],
    then: ["the human passes without any blocking receipt wait", (_, ctx) => {
      try {
        expect(ctx.queue.read("api", 5, ctx.first.id).status).toBe("submitted");
        expect(ctx.queue.read("api", 0, ctx.human.id).status).toBe("acknowledged");
        expect(ctx.receiptWaits.every(timeout => timeout === 0)).toBe(true);
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });
});
