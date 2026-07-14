import { feature, component, expect } from "bdd-vitest";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";

const tempRoot = () => join(tmpdir(), `amux-delivery-broker-${process.pid}-${Math.random().toString(36).slice(2)}`);

function acceptingAgent() {
  const echoed = new Set();
  const sends = [];
  return {
    sends,
    capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
    waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
    dismissBlockingPrompt: async () => null,
    sendOnly: async (_name, text, _pane, options = {}) => {
      sends.push({ text, options });
      await options.onPasteStarted?.();
      await options.onDrafted?.();
      await options.onSubmitted?.();
      echoed.add(text);
      return { submitted: true, queued: false };
    },
    sendEnter: async () => {},
    capturePane: async () => "› ",
  };
}

feature("single-writer delivery broker", () => {
  component("a legacy job for an invalid target is terminalized without retrying tmux", {
    given: ["one pre-validation ghost job", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "queue", pane: 7, text: "skydive" });
      const agent = acceptingAgent();
      const broker = createDeliveryBroker({
        agent,
        queue,
        validateTarget: (name) => {
          if (name === "queue") throw new Error("Agent 'queue' not found");
        },
        notify: async () => {},
      });
      return { rootDir, queue, job, agent, broker };
    }],
    when: ["startup reconciliation reaches the malformed target", ({ broker }) =>
      broker.kickTarget("queue", 7)],
    then: ["the job becomes terminal and never reaches the pane driver", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.queue.read("queue", 7, ctx.job.id)).toMatchObject({
        status: "cancelled",
        draftOwned: false,
        nextAttemptAt: null,
        terminalAt: expect.any(Number),
        lastReason: "invalid delivery target: Agent 'queue' not found",
      });
      expect(ctx.queue.targets()).toEqual([]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("startup recovery loads the complete FIFO before any tmux write", {
    given: ["a broker that has not started and one recovered job", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const agent = acceptingAgent();
      const broker = createDeliveryBroker({ agent, queue, intervalMs: 60_000, notify: async () => {} });
      return { rootDir, queue, agent, broker };
    }],
    when: ["an older job is enqueued after a newer legacy record, then the broker starts", async ({ broker }) => {
      broker.enqueue({ agentName: "lsrc", pane: 3, text: "newer", orderKey: "002" });
      broker.enqueue({ agentName: "lsrc", pane: 3, text: "older", orderKey: "001" });
      await Promise.resolve();
      broker.start();
      await broker.kickTarget("lsrc", 3);
      await broker.stop();
    }],
    then: ["nothing writes early and source order wins", (_, ctx) => {
      expect(ctx.agent.sends.map((send) => send.text)).toEqual(["older", "newer"]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("one pane drains strictly FIFO", {
    given: ["two durable jobs and an accepting agent", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const agent = acceptingAgent();
      const broker = createDeliveryBroker({ agent, queue, intervalMs: 60_000, notify: async () => {} });
      queue.enqueue({ agentName: "ai", pane: 5, text: "first", orderKey: "001" });
      queue.enqueue({ agentName: "ai", pane: 5, text: "second", orderKey: "002" });
      return { rootDir, queue, agent, broker };
    }],
    when: ["the lane is drained", ({ broker }) => broker.kickTarget("ai", 5)],
    then: ["both exact prompts are acknowledged in source order", (_, ctx) => {
      expect(ctx.agent.sends.map((send) => send.text)).toEqual(["first", "second"]);
      expect(ctx.queue.list("ai", 5).map((job) => job.status))
        .toEqual(["acknowledged", "acknowledged"]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an exact JSONL receipt gates the next physical FIFO write", {
    given: ["two prompts whose authoritative receipts arrive after each submit", () => {
      const rootDir = tempRoot();
      let clock = 1_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      queue.enqueue({ agentName: "ai", pane: 5, text: "first", orderKey: "001" });
      queue.enqueue({ agentName: "ai", pane: 5, text: "second", orderKey: "002" });
      const echoed = new Set();
      const sends = [];
      const agent = {
        sends,
        capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
        waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
        dismissBlockingPrompt: async () => null,
        sendOnly: async (_name, text, _pane, options = {}) => {
          sends.push(text);
          await options.onDrafted?.();
          await options.onSubmitted?.();
          return { submitted: true, queued: true };
        },
      };
      const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify: async () => {} });
      return {
        rootDir, queue, broker, sends, echoed,
        advance: () => { clock += 1_001; },
      };
    }],
    when: ["the first submit waits at the FIFO head until its echo, then the second does the same", async ({
      broker, queue, sends, echoed, advance,
    }) => {
      await broker.kickTarget("ai", 5);
      const afterFirstSubmit = {
        sends: [...sends],
        states: queue.list("ai", 5).map((job) => job.status),
      };
      echoed.add("first");
      advance();
      await broker.kickTarget("ai", 5);
      const afterFirstReceipt = {
        sends: [...sends],
        states: queue.list("ai", 5).map((job) => job.status),
      };
      echoed.add("second");
      advance();
      await broker.kickTarget("ai", 5);
      return { afterFirstSubmit, afterFirstReceipt };
    }],
    then: ["neither TUI submit nor queue observation releases the following write", ({
      afterFirstSubmit, afterFirstReceipt,
    }, ctx) => {
      expect(afterFirstSubmit).toEqual({
        sends: ["first"],
        states: ["submitted", "pending"],
      });
      expect(afterFirstReceipt).toEqual({
        sends: ["first", "second"],
        states: ["acknowledged", "submitted"],
      });
      expect(ctx.queue.list("ai", 5).map((job) => job.status))
        .toEqual(["acknowledged", "acknowledged"]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("different panes in one tmux session never write concurrently", {
    given: ["two pending panes and a transport that records overlap", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      queue.enqueue({ agentName: "api", pane: 3, text: "pane three" });
      queue.enqueue({ agentName: "api", pane: 4, text: "pane four" });
      let active = 0;
      let maxActive = 0;
      const agent = acceptingAgent();
      agent.sendOnly = async (_name, text, _pane, options = {}) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await options.onDrafted?.();
        await options.onSubmitted?.();
        active--;
        return { submitted: true };
      };
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, queue, broker, maxActive: () => maxActive };
    }],
    when: ["both pane drains are kicked together", ({ broker }) => Promise.all([
      broker.kickTarget("api", 3),
      broker.kickTarget("api", 4),
    ])],
    then: ["the shared window has one writer", (_, ctx) => {
      expect(ctx.maxActive()).toBe(1);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a successful tiled delivery never changes the visible zoom", {
    given: ["a pane whose composer works in the tiled layout", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      queue.enqueue({ agentName: "api", pane: 3, text: "stay tiled" });
      const agent = acceptingAgent();
      agent.zoomCalls = 0;
      agent.restoreCalls = 0;
      agent.zoomPaneForPicker = async () => { agent.zoomCalls++; return true; };
      agent.restorePaneZoom = async () => { agent.restoreCalls++; };
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, broker, agent };
    }],
    when: ["delivery finishes", ({ broker }) => broker.kickTarget("api", 3)],
    then: ["neither zoom nor restore touches the tmux window", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(1);
      expect(ctx.agent.zoomCalls).toBe(0);
      expect(ctx.agent.restoreCalls).toBe(0);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a tiled composer paint failure retries once with temporary zoom", {
    given: ["a long draft that becomes recoverable after zoom", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "api", pane: 3, text: "show composer" });
      let echoed = false;
      const sends = [];
      const agent = {
        sends,
        zoomCalls: 0,
        restoreCalls: 0,
        restored: null,
        capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
        waitForPromptEcho: async () => echoed,
        dismissBlockingPrompt: async () => null,
        sendOnly: async (_name, text, _pane, options = {}) => {
          sends.push({ text, options });
          if (sends.length === 1) {
            await options.onPasteStarted?.();
            const error = new Error("Codex prompt delivery blocked: exact prompt did not finish painting in the composer");
            error.code = "AMUX_DELIVERY_BLOCKED";
            error.zoomRecoverable = true;
            throw error;
          }
          await options.onSubmitted?.();
          echoed = true;
          return { submitted: true };
        },
        zoomPaneForPicker: async () => {
          agent.zoomCalls++;
          return { changed: true, previousActivePaneId: "%1" };
        },
        restorePaneZoom: async (_name, _pane, receipt) => {
          agent.restoreCalls++;
          agent.restored = receipt;
        },
      };
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, queue, job, broker, agent };
    }],
    when: ["the ordinary tiled attempt cannot finish painting", ({ broker }) => broker.kickTarget("api", 3)],
    then: ["the exact owned draft is recovered under zoom and the old view is restored", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(2);
      expect(ctx.agent.sends[0].options.knownDrafted).toBe(false);
      expect(ctx.agent.sends[1].options.knownDrafted).toBe(true);
      expect(ctx.agent.zoomCalls).toBe(1);
      expect(ctx.agent.restoreCalls).toBe(1);
      expect(ctx.agent.restored).toMatchObject({ changed: true, previousActivePaneId: "%1" });
      expect(ctx.queue.read("api", 3, ctx.job.id).status).toBe("acknowledged");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a foreign composer draft never triggers fullscreen fallback", {
    given: ["a pane containing text owned by the human", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "api", pane: 3, text: "do not overwrite" });
      const agent = acceptingAgent();
      agent.zoomCalls = 0;
      agent.zoomPaneForPicker = async () => { agent.zoomCalls++; return true; };
      agent.sendOnly = async () => {
        const error = new Error("Codex prompt delivery blocked: composer contains a different draft");
        error.code = "AMUX_DELIVERY_BLOCKED";
        throw error;
      };
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, queue, job, broker, agent };
    }],
    when: ["delivery fails closed on the foreign draft", ({ broker }) => broker.kickTarget("api", 3)],
    then: ["the job stays pending with a hint and without changing zoom", (_, ctx) => {
      expect(ctx.agent.zoomCalls).toBe(0);
      expect(ctx.queue.read("api", 3, ctx.job.id)).toMatchObject({
        status: "pending",
        lastReason: "awaiting exact JSONL receipt; TUI hint: Codex prompt delivery blocked: composer contains a different draft",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an unverified disappearing paste stays provisional at the FIFO head", {
    given: ["a first attempt that pastes, then loses the composer", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const first = queue.enqueue({ agentName: "lsrc", pane: 3, text: "long prompt", orderKey: "001" });
      queue.enqueue({ agentName: "lsrc", pane: 3, text: "later directive", orderKey: "002" });
      const sends = [];
      const failingAgent = {
        sends,
        capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
        waitForPromptEcho: async () => false,
        dismissBlockingPrompt: async () => null,
        sendOnly: async (_name, text, _pane, options = {}) => {
          sends.push({ text, options });
          await options.onPasteStarted?.();
          const error = new Error("exact prompt did not finish painting");
          error.code = "AMUX_DELIVERY_BLOCKED";
          throw error;
        },
      };
      const broker = createDeliveryBroker({ agent: failingAgent, queue, notify: async () => {} });
      return { rootDir, queue, first, sends, broker };
    }],
    when: ["the first delivery loses its TUI paint", ({ broker }) => broker.kickTarget("lsrc", 3)],
    then: ["the provisional ownership persists and the later directive is untouched", (_, ctx) => {
      expect(ctx.queue.read("lsrc", 3, ctx.first.id)).toMatchObject({
        status: "pasting",
        draftOwned: true,
      });
      expect(ctx.sends.map((send) => send.text)).toEqual(["long prompt"]);
      expect(ctx.queue.list("lsrc", 3)[1].status).toBe("pending");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("restart resumes the exact drafted job without re-pasting", {
    given: ["a drafted transaction left by an earlier bridge", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "ai", pane: 5, text: "same long prompt" });
      queue.update(job, {
        status: "drafted",
        draftOwned: true,
        echoCursor: { kind: "test", positions: {} },
        nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, queue, job, agent, broker };
    }],
    when: ["the replacement broker drains the lane", ({ broker }) => broker.kickTarget("ai", 5)],
    then: ["transport is told to recover the owned draft and acknowledges once", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(1);
      expect(ctx.agent.sends[0].options.knownDrafted).toBe(true);
      expect(ctx.queue.read("ai", 5, ctx.job.id).status).toBe("acknowledged");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("submitted is a no-retype fence while JSONL is late", {
    given: ["a job whose exact draft already left the composer", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "api", pane: 4, text: "do once" });
      queue.update(job, {
        status: "submitted",
        echoCursor: { kind: "test", positions: {} },
        nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, queue, job, agent, broker };
    }],
    when: ["the broker polls before JSONL catches up", ({ broker }) => broker.kickTarget("api", 4)],
    then: ["no second tmux write occurs", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.queue.read("api", 4, ctx.job.id).status).toBe("submitted");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an empty composer never turns submitted back into paste permission", {
    given: ["an old submitted job with no JSONL receipt and an idle empty composer", () => {
      const rootDir = tempRoot();
      let clock = 20_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "api", pane: 5, text: "exactly once" });
      queue.update(job, {
        status: "submitted",
        submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} },
        nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => ({ state: "empty-idle", busy: false, dialect: "codex" });
      const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify: async () => {} });
      return { rootDir, queue, job, agent, broker, advance: () => { clock += 10_000; } };
    }],
    when: ["the broker reconciles the ambiguity twice", async ({ broker, advance }) => {
      await broker.kickTarget("api", 5);
      advance();
      await broker.kickTarget("api", 5);
    }],
    then: ["it waits for JSONL without any second write", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.queue.read("api", 5, ctx.job.id)).toMatchObject({
        status: "submitted",
        draftOwned: false,
        lastReason: "awaiting exact JSONL receipt; TUI hint: empty-idle",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a submitted Codex prompt becomes terminal when its receipt never arrives", {
    given: ["an ambiguous submission just below the one-hour audit boundary", () => {
      const rootDir = tempRoot();
      let clock = 3_600_999;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "skydive", pane: 3, text: "preserve at most once", createdAt: 1_000,
      });
      queue.update(job, {
        status: "submitted",
        submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} },
        nextAttemptAt: 0,
      });
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => ({
        state: "empty-idle", busy: false, dialect: "codex",
      });
      const broker = createDeliveryBroker({
        agent,
        queue,
        now: () => clock,
        notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, agent, notices, broker, advance: () => { clock += 3_001; } };
    }],
    when: ["the broker checks once before and once after the boundary", async ({ broker, advance }) => {
      await broker.kickTarget("skydive", 3);
      advance();
      await broker.kickTarget("skydive", 3);
    }],
    then: ["it never retypes and records a terminal delivered-unverified audit state", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notices).toEqual(["unverified"]);
      expect(ctx.queue.read("skydive", 3, ctx.job.id)).toMatchObject({
        status: "delivered_unverified",
        draftOwned: false,
        terminalAt: 3_604_000,
        nextAttemptAt: null,
        lastReason: "submit attempt has no exact JSONL receipt after 60 minutes; delivery remains unverified",
      });
      expect(ctx.queue.next("skydive", 3)).toBeNull();
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("delivered-unverified is never exposed as delivered", {
    given: ["an idempotent replay of a terminal prompt with no JSONL receipt", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const request = {
        agentName: "skydive",
        pane: 3,
        text: "still unverified",
        idempotencyKey: "test:unverified-result",
      };
      const job = queue.enqueue(request);
      queue.update(job, {
        status: "delivered_unverified",
        terminalAt: Date.now(),
        nextAttemptAt: null,
      });
      const broker = createDeliveryBroker({ agent: acceptingAgent(), queue, notify: async () => {} });
      return { rootDir, broker, request };
    }],
    when: ["the caller asks for the existing durable result", ({ broker, request }) =>
      broker.enqueueAndWait(request, { timeoutMs: 0 })],
    then: ["the API distinguishes terminal uncertainty from authoritative delivery", (result, ctx) => {
      expect(result).toMatchObject({
        delivered: false,
        pending: false,
        unverified: true,
        job: { status: "delivered_unverified" },
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("fresh receipt proof wins at the submitted timeout boundary", {
    given: ["a stale submitted job whose exact JSONL event is now visible", () => {
      const rootDir = tempRoot();
      const clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "skydive", pane: 3, text: "receipt wins", createdAt: 1_000 });
      queue.update(job, {
        status: "submitted", submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => true;
      agent.promptTransportState = async () => ({
        state: "empty-idle", busy: false, dialect: "codex",
      });
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, broker };
    }],
    when: ["the stale receipt is reconciled", ({ broker }) => broker.kickTarget("skydive", 3)],
    then: ["the authoritative echo acknowledges instead of dead-lettering", (_, ctx) => {
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("skydive", 3, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        acknowledgedAt: 4_000_000,
        lastReason: null,
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a receipt that appears during the final transport probe wins", {
    given: ["a stale submission whose JSONL echo races the timeout inspection", () => {
      const rootDir = tempRoot();
      const clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "skydive", pane: 3, text: "late receipt wins", createdAt: 1_000,
      });
      queue.update(job, {
        status: "submitted", submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      let echoChecks = 0;
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => ++echoChecks >= 2;
      agent.promptTransportState = async () => ({
        state: "empty-idle", busy: false, dialect: "codex",
      });
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, broker, echoChecks: () => echoChecks };
    }],
    when: ["the transport probe overlaps the late receipt", ({ broker }) => broker.kickTarget("skydive", 3)],
    then: ["the final sink check acknowledges without an unverified warning", (_, ctx) => {
      expect(ctx.echoChecks()).toBeGreaterThanOrEqual(2);
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("skydive", 3, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        acknowledgedAt: 4_000_000,
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a resurfaced draft is only a TUI hint while awaiting JSONL", {
    given: ["a submitted prompt whose text has reappeared in the composer", () => {
      const rootDir = tempRoot();
      const clock = 20_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "skydive", pane: 3, text: "draft wins", createdAt: 1_000 });
      queue.update(job, {
        status: "submitted", submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => ({ state: "drafted", busy: false, dialect: "codex" });
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, broker };
    }],
    when: ["the pending receipt is reconciled", ({ broker }) => broker.kickTarget("skydive", 3)],
    then: ["the durable submit fence remains authoritative over the scraped draft", (_, ctx) => {
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("skydive", 3, ctx.job.id)).toMatchObject({
        status: "submitted",
        draftOwned: false,
        nextAttemptAt: 21_000,
        lastReason: "awaiting exact JSONL receipt; TUI hint: drafted",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("TUI state cannot defer the JSONL receipt timeout", {
    given: ["a timed-out submit whose composer probes would disagree", () => {
      const rootDir = tempRoot();
      const clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "skydive", pane: 3, text: "resurfacing draft", createdAt: 1_000,
      });
      queue.update(job, {
        status: "submitted", submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      let probes = 0;
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => (++probes === 1
        ? { state: "empty-idle", busy: false, dialect: "codex" }
        : { state: "drafted", busy: false, dialect: "codex" });
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, broker, probes: () => probes };
    }],
    when: ["the timeout path reconciles the authoritative sink", ({ broker }) => broker.kickTarget("skydive", 3)],
    then: ["terminalization does not consult or trust either TUI observation", (_, ctx) => {
      expect(ctx.probes()).toBe(0);
      expect(ctx.notices).toEqual(["unverified"]);
      expect(ctx.queue.read("skydive", 3, ctx.job.id)).toMatchObject({
        status: "delivered_unverified",
        draftOwned: false,
        nextAttemptAt: null,
        lastReason: "submit attempt has no exact JSONL receipt after 60 minutes; delivery remains unverified",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("terminal timeout never overwrites a concurrent acknowledgement", {
    given: ["an authoritative echo check overlaps an acknowledgement committed by another reconciler", () => {
      const rootDir = tempRoot();
      const clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "skydive", pane: 3, text: "already acknowledged", createdAt: 1_000,
      });
      queue.update(job, {
        status: "submitted", submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      const notices = [];
      const agent = acceptingAgent();
      let echoChecks = 0;
      agent.waitForPromptEcho = async () => {
        echoChecks++;
        if (echoChecks === 2) {
          const current = queue.read("skydive", 3, job.id);
          queue.update(current, { status: "acknowledged", acknowledgedAt: clock, nextAttemptAt: null });
        }
        return false;
      };
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, broker, echoChecks: () => echoChecks };
    }],
    when: ["the stale submitted path reaches terminalization", ({ broker }) => broker.kickTarget("skydive", 3)],
    then: ["the terminal guard preserves acknowledged and emits no warning", (_, ctx) => {
      expect(ctx.echoChecks()).toBe(2);
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("skydive", 3, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        acknowledgedAt: 4_000_000,
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an unverified warning retries after restart without reopening delivery", {
    given: ["Discord fails the first warning for a terminalized prompt", () => {
      const rootDir = tempRoot();
      let clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "skydive", pane: 3, text: "warn durably", createdAt: 1_000,
        metadata: { channelId: "target-channel" },
      });
      queue.update(job, {
        status: "submitted", submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => ({
        state: "empty-idle", busy: false, dialect: "codex",
      });
      let notifyCalls = 0;
      const notify = async () => {
        notifyCalls++;
        if (notifyCalls === 1) throw new Error("discord down");
      };
      const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify });
      return {
        rootDir, queue, job, agent, broker, notify,
        notifyCalls: () => notifyCalls,
        advance: () => { clock += 60_000; },
        now: () => clock,
      };
    }],
    when: ["the first broker terminalizes and two replacement brokers poll the spool", async (ctx) => {
      await ctx.broker.kickTarget("skydive", 3);
      ctx.afterFailure = ctx.queue.read("skydive", 3, ctx.job.id);
      ctx.targetsAfterFailure = ctx.queue.targets();
      ctx.advance();
      const reopened = createDeliveryQueue({ rootDir: ctx.rootDir, now: ctx.now });
      await createDeliveryBroker({
        agent: ctx.agent, queue: reopened, now: ctx.now, notify: ctx.notify,
      }).kick();
      ctx.afterSuccess = reopened.read("skydive", 3, ctx.job.id);
      const third = createDeliveryQueue({ rootDir: ctx.rootDir, now: ctx.now });
      await createDeliveryBroker({
        agent: ctx.agent, queue: third, now: ctx.now, notify: ctx.notify,
      }).kick();
      ctx.targetsAfterSuccess = third.targets();
    }],
    then: ["warning success is durable while the prompt stays terminal and is never pasted", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.afterFailure).toMatchObject({
        status: "delivered_unverified",
        unverifiedNoticeAttempts: 1,
        unverifiedNoticeSentAt: null,
      });
      expect(ctx.targetsAfterFailure).toEqual([{ agentName: "skydive", pane: 3 }]);
      expect(ctx.afterSuccess).toMatchObject({
        status: "delivered_unverified",
        unverifiedNoticeAttempts: 2,
        unverifiedNoticeSentAt: 4_060_000,
      });
      expect(ctx.notifyCalls()).toBe(2);
      expect(ctx.targetsAfterSuccess).toEqual([]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an internal producer resolves the bound target channel centrally", {
    given: ["a drift-guard prompt without channel metadata and a bound target pane", () => {
      const rootDir = tempRoot();
      const clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "claw", pane: 4, text: "refresh instructions", createdAt: 1_000,
        source: "drift-guard",
      });
      queue.update(job, {
        status: "submitted", submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => ({
        state: "empty-idle", busy: false, dialect: "codex",
      });
      const sends = [];
      const broker = createDeliveryBroker({
        agent,
        queue,
        now: () => clock,
        resolveNotificationChannel: (candidate) =>
          candidate.agentName === "claw" && candidate.pane === 4 ? "bound-channel" : null,
        notify: async (candidate, kind) => {
          sends.push({
            channelId: candidate.metadata?.channelId,
            kind,
            markerBeforeSend: queue.read("claw", 4, job.id).unverifiedNoticeSentAt,
          });
        },
      });
      return { rootDir, queue, job, agent, sends, broker, clock };
    }],
    when: ["the stale internal prompt becomes unverified", async (ctx) => {
      await ctx.broker.kickTarget("claw", 4);
      const reopened = createDeliveryQueue({ rootDir: ctx.rootDir, now: () => ctx.clock });
      await createDeliveryBroker({
        agent: ctx.agent,
        queue: reopened,
        now: () => ctx.clock,
        resolveNotificationChannel: () => "bound-channel",
        notify: async () => ctx.sends.push({ duplicate: true }),
      }).kick();
      ctx.afterRestart = reopened.read("claw", 4, ctx.job.id);
      ctx.targetsAfterRestart = reopened.targets();
    }],
    then: ["Discord is called before the sent marker and restart does not duplicate it", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.sends).toEqual([{
        channelId: "bound-channel",
        kind: "unverified",
        markerBeforeSend: null,
      }]);
      expect(ctx.afterRestart).toMatchObject({
        status: "delivered_unverified",
        metadata: { channelId: "bound-channel" },
        unverifiedNoticeSentAt: 4_000_000,
        unverifiedNoticeLastReason: null,
      });
      expect(ctx.targetsAfterRestart).toEqual([]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("no bound target channel is distinct from a sent warning", {
    given: ["an internal prompt whose pane currently has no Discord binding", () => {
      const rootDir = tempRoot();
      const clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "unbound", pane: 1, text: "retain warning", createdAt: 1_000,
        source: "voice-pwa",
      });
      queue.update(job, {
        status: "submitted", submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => ({
        state: "empty-idle", busy: false, dialect: "codex",
      });
      let notifyCalls = 0;
      const notify = async () => { notifyCalls++; };
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, resolveNotificationChannel: () => null, notify,
      });
      return { rootDir, queue, job, agent, notifyCalls: () => notifyCalls, broker };
    }],
    when: ["the warning channel cannot be resolved", ({ broker }) => broker.kickTarget("unbound", 1)],
    then: ["the prompt stays terminal but warning audit remains retryable and unsent", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notifyCalls()).toBe(0);
      expect(ctx.queue.read("unbound", 1, ctx.job.id)).toMatchObject({
        status: "delivered_unverified",
        unverifiedNoticeSentAt: null,
        unverifiedNoticeAttempts: 1,
        unverifiedNoticeLastReason: "no Discord channel is currently bound to the target pane",
      });
      expect(ctx.queue.targets()).toEqual([{ agentName: "unbound", pane: 1 }]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an idle Claude composer cannot reopen a submitted prompt", {
    given: ["a Claude job whose submitted prompt is still awaiting JSONL", () => {
      const rootDir = tempRoot();
      let clock = 20_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "watch", pane: 0, text: "review everything", createdAt: 1_000,
      });
      queue.update(job, {
        status: "submitted",
        submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} },
        nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => ({ state: "empty-idle", busy: false, dialect: "claude" });
      const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify: async () => {} });
      return { rootDir, queue, job, agent, broker, advance: () => { clock += 1_001; } };
    }],
    when: ["the broker observes the empty TUI twice", async ({ broker, advance }) => {
      await broker.kickTarget("watch", 0);
      advance();
      await broker.kickTarget("watch", 0);
    }],
    then: ["no retype occurs and only the diagnostic hint changes", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.queue.read("watch", 0, ctx.job.id)).toMatchObject({
        status: "submitted",
        lastReason: "awaiting exact JSONL receipt; TUI hint: empty-idle",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a fresh Claude submission keeps its no-retype grace period", {
    given: ["an empty idle Claude composer before the grace period expires", () => {
      const rootDir = tempRoot();
      const clock = 20_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "watch", pane: 0, text: "do not race JSONL", createdAt: 1_000,
      });
      queue.update(job, {
        status: "submitted",
        submittedAt: 1_000,
        echoCursor: { kind: "test", positions: {} },
        nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => ({ state: "empty-idle", busy: false, dialect: "claude" });
      const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify: async () => {} });
      return { rootDir, queue, job, agent, broker };
    }],
    when: ["the broker checks before thirty seconds", ({ broker }) => broker.kickTarget("watch", 0)],
    then: ["no duplicate paste permission is granted", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.queue.read("watch", 0, ctx.job.id).status).toBe("submitted");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("legacy Claude recovery counters cannot override JSONL truth", {
    given: ["a Claude job carrying two historical recovery attempts", () => {
      const rootDir = tempRoot();
      const clock = 100_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "api", pane: 0, text: "broken JSONL", createdAt: 1_000,
      });
      queue.update(job, {
        status: "submitted",
        submittedAt: 1_000,
        recoveryAttempts: 2,
        echoCursor: { kind: "test", positions: {} },
        nextAttemptAt: 0,
      });
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.promptTransportState = async () => ({ state: "empty-idle", busy: false, dialect: "claude" });
      const broker = createDeliveryBroker({
        agent,
        queue,
        now: () => clock,
        notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, agent, notices, broker };
    }],
    when: ["the broker reconciles the stale submission", ({ broker }) => broker.kickTarget("api", 0)],
    then: ["it remains fenced without a TUI-derived blocked verdict", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("api", 0, ctx.job.id)).toMatchObject({
        status: "submitted",
        recoveryAttempts: 2,
        lastReason: "awaiting exact JSONL receipt; TUI hint: empty-idle",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a provisional foreign repaint never receives Enter or a duplicate paste", {
    given: ["a first paste whose composer disappears before submit", () => {
      const rootDir = tempRoot();
      let clock = 1_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "skydive", pane: 5, text: "x".repeat(1_212) });
      let physicalPastes = 0;
      const calls = [];
      const agent = {
        capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
        waitForPromptEcho: async () => false,
        dismissBlockingPrompt: async () => null,
        sendOnly: async (_name, _text, _pane, options = {}) => {
          calls.push({ knownDrafted: options.knownDrafted });
          if (!options.knownDrafted) {
            physicalPastes++;
            await options.onPasteStarted?.();
          }
          const error = new Error("durable draft is not visible; refusing to paste it again");
          error.code = "AMUX_DELIVERY_BLOCKED";
          throw error;
        },
        promptTransportState: async () => ({
          state: "foreign", busy: false, dialect: "codex", detail: "torn owned paste",
        }),
      };
      const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify: async () => {} });
      return { rootDir, queue, job, broker, calls, physicalPastes: () => physicalPastes, advance: () => { clock += 10_000; } };
    }],
    when: ["the durable head is retried after its backoff", async ({ broker, advance }) => {
      await broker.kickTarget("skydive", 5);
      advance();
      await broker.kickTarget("skydive", 5);
    }],
    then: ["only the first attempt may physically paste", (_, ctx) => {
      expect(ctx.physicalPastes()).toBe(1);
      expect(ctx.calls).toEqual([{ knownDrafted: false }]);
      expect(ctx.queue.read("skydive", 5, ctx.job.id)).toMatchObject({
        status: "pasting",
        draftOwned: true,
        attempts: 1,
        lastReason: expect.stringContaining("preserving both"),
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an empty idle composer safely reopens only a provisional paste", {
    given: ["a crash after paste initiation but before exact verification or Enter", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "skydive", pane: 7, text: "retry exact once" });
      queue.update(job, {
        status: "pasting", draftOwned: true,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      agent.promptTransportState = async () => ({
        state: "empty-idle", busy: false, dialect: "codex",
      });
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, queue, job, agent, broker };
    }],
    when: ["the broker proves the unsent paste absent, then drains the reopened job", async ({ broker }) => {
      await broker.kickTarget("skydive", 7);
      await broker.kickTarget("skydive", 7);
    }],
    then: ["the immutable payload is pasted exactly once and acknowledged", (_, ctx) => {
      expect(ctx.agent.sends.map((send) => send.text)).toEqual(["retry exact once"]);
      expect(ctx.queue.read("skydive", 7, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        attempts: 1,
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("fresh panes fall back to a persisted local echo boundary", {
    given: ["cursor capture returns null before the first write", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "new", pane: 0, text: "first session prompt" });
      const agent = acceptingAgent();
      agent.capturePromptEchoCursor = async () => null;
      let echoed = false;
      agent.waitForPromptEcho = async (_name, _pane, _text, _timeout, options) =>
        echoed && Number(options?.notBeforeMs) > 0;
      agent.sendOnly = async (_name, text, _pane, options = {}) => {
        agent.sends.push({ text, options });
        await options.onPasteStarted?.();
        await options.onDrafted?.();
        await options.onSubmitted?.();
        echoed = true;
        return { submitted: true };
      };
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, queue, job, agent, broker };
    }],
    when: ["the broker submits and then performs its authoritative echo check", async ({ broker }) => {
      await broker.kickTarget("new", 0);
      await broker.kickTarget("new", 0);
    }],
    then: ["the one prompt is acknowledged without a duplicate write", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(1);
      expect(ctx.queue.read("new", 0, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        echoNotBeforeMs: expect.any(Number),
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a submitted slash command is acknowledged after broker restart", {
    given: ["a slash whose composer transition persisted before a crash", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "claw", pane: 1, text: "/compact", kind: "slash" });
      queue.update(job, { status: "submitted", submittedAt: 1000, nextAttemptAt: 0 });
      const agent = acceptingAgent();
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, queue, job, agent, broker };
    }],
    when: ["the replacement broker reconciles the head", ({ broker }) => broker.kickTarget("claw", 1)],
    then: ["it advances without executing /compact twice", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.queue.read("claw", 1, ctx.job.id).status).toBe("acknowledged");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });
});
