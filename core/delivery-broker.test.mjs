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
      await options.onSubmitting?.();
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
          await options.onSubmitting?.();
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
        await options.onSubmitting?.();
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
          await options.onSubmitting?.();
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

  // The 2026-07-15 claw:6 freeze: a submitted head waited silently on its
  // receipt while ten messages starved behind it and the human learned it
  // from the queue files. The receipt wait may be long; the silence may not.
  const stalledSubmittedHead = () => {
    const rootDir = tempRoot();
    let clock = 1_000;
    const queue = createDeliveryQueue({ rootDir, now: () => clock });
    const job = queue.enqueue({ agentName: "api", pane: 4, text: "stuck order" });
    queue.update(job, {
      status: "submitted",
      submittedAt: clock,
      echoCursor: { kind: "test", positions: {} },
      nextAttemptAt: 0,
    });
    // Same-millisecond jobs tie on orderKey and fall back to random identity;
    // distinct timestamps keep the submitted job the deterministic FIFO head.
    clock += 100;
    queue.enqueue({ agentName: "api", pane: 4, text: "follower one" });
    clock += 100;
    queue.enqueue({ agentName: "api", pane: 4, text: "follower two" });
    const agent = acceptingAgent();
    let receiptVisible = false;
    agent.waitForPromptEcho = async () => receiptVisible;
    const notices = [];
    const broker = createDeliveryBroker({
      agent,
      queue,
      now: () => clock,
      notify: async (noticedJob, state, extra) => notices.push({ id: noticedJob.id, state, extra }),
    });
    return {
      rootDir, queue, job, agent, broker, notices,
      advance: (ms) => { clock += ms; },
      revealReceipt: () => { receiptVisible = true; },
    };
  };

  component("a stalled submitted head warns the human once with the queue depth", {
    given: ["a submitted job with no receipt and two starving followers", stalledSubmittedHead],
    when: ["the broker polls past the stall threshold, twice", async (ctx) => {
      ctx.advance(3 * 60_000);
      await ctx.broker.kickTarget("api", 4);
      ctx.advance(2_000);
      await ctx.broker.kickTarget("api", 4);
    }],
    then: ["exactly one stalled notice fires and it counts both followers", (_, ctx) => {
      const stalled = ctx.notices.filter((notice) => notice.state === "stalled");
      expect(stalled).toHaveLength(1);
      expect(stalled[0]).toMatchObject({ id: ctx.job.id, extra: { queuedBehind: 2 } });
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.queue.read("api", 4, ctx.job.id)).toMatchObject({
        status: "submitted",
        noticeSentAt: expect.any(Number),
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a submitted head below the stall threshold stays quiet", {
    given: ["a submitted job whose receipt is merely seconds late", stalledSubmittedHead],
    when: ["the broker polls one minute in", async (ctx) => {
      ctx.advance(60_000);
      await ctx.broker.kickTarget("api", 4);
    }],
    then: ["no notice of any kind fires", (_, ctx) => {
      expect(ctx.notices).toHaveLength(0);
      expect(ctx.queue.read("api", 4, ctx.job.id).noticeSentAt).toBeNull();
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a stall warning resolves into recovery the moment the receipt lands", {
    given: ["a stalled-notified job whose exact JSONL receipt then appears", stalledSubmittedHead],
    when: ["the broker polls after the stall notice and again once the receipt exists", async (ctx) => {
      ctx.advance(3 * 60_000);
      await ctx.broker.kickTarget("api", 4);
      ctx.revealReceipt();
      ctx.advance(2_000);
      await ctx.broker.kickTarget("api", 4);
    }],
    then: ["the head acknowledges and the human hears recovered, in that order", (_, ctx) => {
      expect(ctx.notices.map((notice) => notice.state)).toEqual(["stalled", "recovered"]);
      expect(ctx.queue.read("api", 4, ctx.job.id).status).toBe("acknowledged");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a crash after Enter preserves the pre-Enter fence across restart", {
    given: ["a transport that fails after persisting submitting but before submitted", () => {
      const rootDir = tempRoot();
      let clock = 1_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "api", pane: 4, text: "never retype after Enter" });
      const firstAgent = acceptingAgent();
      firstAgent.waitForPromptEcho = async () => false;
      firstAgent.sendOnly = async (_name, text, _pane, options = {}) => {
        firstAgent.sends.push({ text, options });
        await options.onPasteStarted?.();
        await options.onDrafted?.();
        await options.onSubmitting?.();
        throw new Error("process lost after physical Enter");
      };
      const firstBroker = createDeliveryBroker({
        agent: firstAgent, queue, now: () => clock, notify: async () => {},
      });
      return {
        rootDir, queue, job, firstAgent, firstBroker,
        now: () => clock,
        advance: (ms) => { clock += ms; },
      };
    }],
    when: ["the first bridge fails, the sender cancels, and a replacement reaches the audit timeout", async (ctx) => {
      await ctx.firstBroker.kickTarget("api", 4);
      ctx.afterCrash = ctx.queue.read("api", 4, ctx.job.id);
      ctx.queue.requestCancellation(ctx.job.id, {
        reason: "do not retry after the crash", requestedBy: "api:2",
      });
      ctx.advance(1_001);
      const reopened = createDeliveryQueue({ rootDir: ctx.rootDir, now: ctx.now });
      const replacementAgent = acceptingAgent();
      replacementAgent.waitForPromptEcho = async () => false;
      let nativeDispatches = 0;
      replacementAgent.isNativeTarget = () => true;
      replacementAgent.deliverQueued = async () => {
        nativeDispatches++;
        return { accepted: true };
      };
      const notices = [];
      const replacement = createDeliveryBroker({
        agent: replacementAgent,
        queue: reopened,
        now: ctx.now,
        notify: async (_candidate, kind) => notices.push(kind),
      });
      await replacement.kickTarget("api", 4);
      ctx.afterRestart = reopened.read("api", 4, ctx.job.id);
      ctx.advance(3_600_000);
      await replacement.kickTarget("api", 4);
      ctx.afterTimeout = reopened.read("api", 4, ctx.job.id);
      ctx.replacementAgent = replacementAgent;
      ctx.nativeDispatches = () => nativeDispatches;
      ctx.notices = notices;
    }],
    then: ["neither restart nor cancellation retypes or falsely says NOT SENT", (_, ctx) => {
      expect(ctx.firstAgent.sends).toHaveLength(1);
      expect(ctx.afterCrash).toMatchObject({
        status: "submitting",
        submitFenceAt: 1_000,
        lastReason: "submit fence committed before physical completion; awaiting authoritative receipt",
      });
      expect(ctx.afterRestart).toMatchObject({
        status: "submitting",
        cancelRequestStatus: "refused",
        cancelRequestLastReason: expect.stringContaining("submit may already have been attempted"),
      });
      expect(ctx.replacementAgent.sends).toHaveLength(0);
      expect(ctx.nativeDispatches()).toBe(0);
      expect(ctx.notices).toEqual(["unverified"]);
      expect(ctx.afterTimeout).toMatchObject({
        status: "delivered_unverified",
        metadata: { deliveryAmbiguity: "submitting-fence" },
        lastReason: "pre-Enter submit fence has no exact receipt after 60 minutes; physical delivery remains unverified",
      });
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
      // The hour-long receipt wait now warns the human on the way (stalled)
      // before the terminal unverified verdict; silence was the 07-15 bug.
      expect(ctx.notices).toEqual(["stalled", "unverified"]);
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

  component("an exhausted pending head becomes NOT SENT and releases a never-attempted follower", {
    given: ["the live ai:5 shape: one repeatedly blocked head and an old job waiting behind it", () => {
      const rootDir = tempRoot();
      const clock = 3_700_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const first = queue.enqueue({
        agentName: "ai", pane: 5, text: "blocked by foreign q draft", createdAt: 1_000, orderKey: "001",
      });
      queue.update(first, {
        status: "pending",
        attempts: 64,
        firstAttemptAt: 1_000,
        lastAttemptAt: 3_600_000,
        echoCursor: { kind: "test", positions: {} },
        nextAttemptAt: 0,
      });
      const second = queue.enqueue({
        agentName: "ai", pane: 5, text: "old but never attempted", createdAt: 2_000, orderKey: "002",
      });
      const notices = [];
      const agent = acceptingAgent();
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, first, second, notices, agent, broker };
    }],
    when: ["the broker terminalizes the exhausted head, then polls the released lane", async ({ broker }) => {
      await broker.kickTarget("ai", 5);
      await broker.kickTarget("ai", 5);
    }],
    then: ["the first job is explicitly not sent while the follower receives its first real attempt", (_, ctx) => {
      expect(ctx.queue.read("ai", 5, ctx.first.id)).toMatchObject({
        status: "cancelled",
        terminalAt: 3_700_000,
        nextAttemptAt: null,
        metadata: { deliveryTimeout: "pre-submit" },
        unverifiedNoticeSentAt: 3_700_000,
        lastReason: expect.stringContaining("not sent:"),
      });
      expect(ctx.notices).toEqual(["not-sent"]);
      expect(ctx.agent.sends.map((send) => send.text)).toEqual(["old but never attempted"]);
      expect(ctx.queue.read("ai", 5, ctx.second.id)).toMatchObject({
        status: "acknowledged",
        attempts: 1,
        firstAttemptAt: 3_700_000,
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a sender can cancel a never-attempted follower without disturbing the FIFO head", {
    given: ["a fresh blocked head and an obsolete job that has never touched the composer", () => {
      const rootDir = tempRoot();
      const clock = 10_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const head = queue.enqueue({
        agentName: "ai", pane: 5, text: "keep the head", createdAt: 1_000, orderKey: "001",
      });
      queue.update(head, {
        status: "pending", attempts: 1, firstAttemptAt: 9_000, nextAttemptAt: 20_000,
      });
      const obsolete = queue.enqueue({
        agentName: "ai", pane: 5, text: "obsolete follower", createdAt: 2_000, orderKey: "002",
      });
      queue.requestCancellation(obsolete.id, {
        reason: "already merged and deployed elsewhere", requestedBy: "ai:2",
      });
      const notices = [];
      const agent = acceptingAgent();
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_candidate, kind) => notices.push(kind),
      });
      return { rootDir, queue, head, obsolete, notices, agent, broker };
    }],
    when: ["the broker adjudicates cancellation under the pane writer lease", ({ broker }) =>
      broker.kickTarget("ai", 5)],
    then: ["the follower is provably NOT SENT while the head and composer remain untouched", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notices).toEqual(["not-sent"]);
      expect(ctx.queue.read("ai", 5, ctx.head.id)).toMatchObject({
        status: "pending", attempts: 1, nextAttemptAt: 20_000,
      });
      expect(ctx.queue.read("ai", 5, ctx.obsolete.id)).toMatchObject({
        status: "cancelled",
        attempts: 0,
        cancelRequestStatus: "completed",
        cancelRequestResolvedAt: 10_000,
        metadata: {
          deliveryOutcome: "not-sent",
          deliveryCancellation: "sender-request",
        },
        lastReason: expect.stringContaining("already merged and deployed elsewhere"),
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a cancellation request loses to an authoritative receipt", {
    given: ["a pre-submit record whose exact JSONL event is already durable", () => {
      const rootDir = tempRoot();
      const clock = 10_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "claw", pane: 4, text: "receipt beats cancel", createdAt: 1_000,
        echoCursor: { kind: "test", positions: {} },
      });
      queue.requestCancellation(job.id, {
        reason: "sender changed its mind", requestedBy: "claw:2",
      });
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => true;
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_candidate, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, agent, broker };
    }],
    when: ["the broker checks the authoritative sink before declaring NOT SENT", ({ broker }) =>
      broker.kickTarget("claw", 4)],
    then: ["delivery truth is retained and the cancellation is explicitly refused", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("claw", 4, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        cancelRequestStatus: "refused",
        cancelRequestResolvedAt: 10_000,
        cancelRequestLastReason: expect.stringContaining("authoritative receipt"),
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a cancellation arriving before the submit fence prevents Enter", {
    given: ["a sender request that appears after paste but before the durable pre-Enter callback", () => {
      const rootDir = tempRoot();
      const clock = 10_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "lsrc", pane: 8, text: "stop before Enter", createdAt: 9_000 });
      const notices = [];
      let physicalEnters = 0;
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.sendOnly = async (_name, text, _pane, options = {}) => {
        agent.sends.push({ text, options });
        await options.onPasteStarted?.();
        await options.onDrafted?.();
        queue.requestCancellation(job.id, {
          reason: "became obsolete before Enter", requestedBy: "lsrc:2",
        });
        await options.onSubmitting?.();
        physicalEnters++;
        await options.onSubmitted?.();
        return { submitted: true, queued: false };
      };
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_candidate, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, agent, broker, physicalEnters: () => physicalEnters };
    }],
    when: ["the durable fence callback observes the sender request", ({ broker }) =>
      broker.kickTarget("lsrc", 8)],
    then: ["the composer is preserved, Enter never runs, and NOT SENT is truthful", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(1);
      expect(ctx.physicalEnters()).toBe(0);
      expect(ctx.notices).toEqual(["not-sent"]);
      expect(ctx.queue.read("lsrc", 8, ctx.job.id)).toMatchObject({
        status: "cancelled",
        cancelRequestStatus: "completed",
        metadata: {
          deliveryOutcome: "not-sent",
          deliveryCancellation: "sender-request",
        },
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a cancellation racing physical submit is refused instead of misreported", {
    given: ["a sender request that arrives after paste but before the submit callback commits", () => {
      const rootDir = tempRoot();
      const clock = 10_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "lsrc", pane: 8, text: "in-flight prompt", createdAt: 9_000 });
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      agent.sendOnly = async (_name, text, _pane, options = {}) => {
        agent.sends.push({ text, options });
        await options.onPasteStarted?.();
        await options.onDrafted?.();
        await options.onSubmitting?.();
        queue.requestCancellation(job.id, {
          reason: "arrived during the physical write", requestedBy: "lsrc:2",
        });
        await options.onSubmitted?.();
        return { submitted: true, queued: false };
      };
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_candidate, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, agent, broker };
    }],
    when: ["one pass submits and the next pass adjudicates the late request", async ({ broker }) => {
      await broker.kickTarget("lsrc", 8);
      await broker.kickTarget("lsrc", 8);
    }],
    then: ["the durable submit fence survives and no false NOT SENT warning is emitted", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(1);
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("lsrc", 8, ctx.job.id)).toMatchObject({
        status: "submitted",
        cancelRequestStatus: "refused",
        cancelRequestResolvedAt: 10_000,
        cancelRequestLastReason: expect.stringContaining("submit may already have been attempted"),
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an attempted native dispatch is never misreported as NOT SENT", {
    given: ["a native job whose HTTP attempt may have outlived the bridge response", () => {
      const rootDir = tempRoot();
      const clock = 10_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "skybar", pane: 3, text: "native ambiguity", createdAt: 1_000 });
      queue.update(job, {
        status: "pending", attempts: 1, firstAttemptAt: 1_000, nextAttemptAt: 20_000,
      });
      queue.requestCancellation(job.id, {
        reason: "cancel after HTTP uncertainty", requestedBy: "skybar:2",
      });
      const notices = [];
      const agent = acceptingAgent();
      agent.isNativeTarget = () => true;
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_candidate, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, agent, broker };
    }],
    when: ["the broker adjudicates the request before the next native retry", ({ broker }) =>
      broker.kickTarget("skybar", 3)],
    then: ["the ambiguous request is refused without dispatch or a false terminal notice", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("skybar", 3, ctx.job.id)).toMatchObject({
        status: "pending",
        cancelRequestStatus: "refused",
        cancelRequestLastReason: expect.stringContaining("not safe for pre-submit cancellation"),
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a model-parked native job remains durable beyond the pre-submit timeout", {
    given: ["a native runtime that repeatedly refuses work while its model guard is active", () => {
      const rootDir = tempRoot();
      let clock = 1_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "watch", pane: 3, text: "wait for model choice" });
      let attempts = 0;
      const agent = acceptingAgent();
      agent.isNativeTarget = () => true;
      agent.deliverQueued = async () => {
        attempts++;
        return {
          accepted: false,
          retryable: true,
          code: "model-downgrade-parked",
          reason: "native runtime model-downgrade-parked",
        };
      };
      const notices = [];
      const broker = createDeliveryBroker({
        agent,
        queue,
        now: () => clock,
        notify: async (_candidate, kind) => notices.push(kind),
      });
      return {
        rootDir, queue, job, broker, notices,
        attempts: () => attempts,
        advance: (ms) => { clock += ms; },
      };
    }],
    when: ["the broker retries once, then retries again more than an hour later", async (ctx) => {
      await ctx.broker.kickTarget("watch", 3);
      ctx.advance(2 * 60 * 60 * 1_000);
      await ctx.broker.kickTarget("watch", 3);
    }],
    then: ["the immutable job stays pending instead of becoming terminal NOT SENT", (_, ctx) => {
      expect(ctx.attempts()).toBe(2);
      expect(ctx.queue.read("watch", 3, ctx.job.id)).toMatchObject({
        status: "pending",
        attempts: 2,
        terminalAt: null,
        lastReason: "native runtime model-downgrade-parked",
      });
      expect(ctx.notices).not.toContain("unverified");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a stale provisional paste is dead-lettered without touching the foreign composer", {
    given: ["the live lsrc:8 shape: an old paste fence and a different visible compact command", () => {
      const rootDir = tempRoot();
      const clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "lsrc", pane: 8, text: "/compact", kind: "slash", createdAt: 1_000,
      });
      queue.update(job, {
        status: "pasting",
        draftOwned: true,
        attempts: 1,
        lastAttemptAt: 2_000,
        nextAttemptAt: 0,
      });
      let transportProbes = 0;
      const notices = [];
      const agent = acceptingAgent();
      agent.promptTransportState = async () => {
        transportProbes++;
        return { state: "foreign", detail: "/compact summarize conversation" };
      };
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_candidate, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, agent, broker, transportProbes: () => transportProbes };
    }],
    when: ["the stale provisional owner reaches its terminal audit", ({ broker }) =>
      broker.kickTarget("lsrc", 8)],
    then: ["no paste, Enter, cleanup or permissive composer probe occurs", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.transportProbes()).toBe(0);
      expect(ctx.notices).toEqual(["not-sent"]);
      expect(ctx.queue.read("lsrc", 8, ctx.job.id)).toMatchObject({
        status: "cancelled",
        draftOwned: false,
        metadata: { deliveryTimeout: "pre-submit" },
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an authoritative receipt wins at the pre-submit timeout boundary", {
    given: ["an exhausted-looking pending job whose exact JSONL event has arrived", () => {
      const rootDir = tempRoot();
      const clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "api", pane: 2, text: "receipt wins", createdAt: 1_000 });
      queue.update(job, {
        status: "pending", attempts: 64, firstAttemptAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => true;
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_candidate, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, agent, broker };
    }],
    when: ["the terminal audit first checks the authoritative sink", ({ broker }) =>
      broker.kickTarget("api", 2)],
    then: ["the job is acknowledged without a NOT SENT warning or another write", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("api", 2, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        acknowledgedAt: 4_000_000,
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("pre-submit timeout never overwrites a concurrent acknowledgement", {
    given: ["a legacy exhausted job whose final sink check overlaps another reconciler", () => {
      const rootDir = tempRoot();
      const clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "ai", pane: 5, text: "concurrent receipt wins", createdAt: 1_000,
      });
      queue.update(job, {
        status: "pending", attempts: 64,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      let echoChecks = 0;
      const notices = [];
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => {
        echoChecks++;
        if (echoChecks === 2) {
          const current = queue.read("ai", 5, job.id);
          queue.update(current, {
            status: "acknowledged", acknowledgedAt: clock, nextAttemptAt: null,
          });
        }
        return false;
      };
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_candidate, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, agent, broker, echoChecks: () => echoChecks };
    }],
    when: ["the stale observer reaches the guarded terminal transition", ({ broker }) =>
      broker.kickTarget("ai", 5)],
    then: ["the committed acknowledgement survives without a write or false NOT SENT warning", (_, ctx) => {
      expect(ctx.echoChecks()).toBe(2);
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notices).toEqual([]);
      expect(ctx.queue.read("ai", 5, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        acknowledgedAt: 4_000_000,
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a failed NOT SENT warning retries durably after broker restart", {
    given: ["an exhausted pre-submit job and a transient Discord failure", () => {
      const rootDir = tempRoot();
      let clock = 4_000_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "watch", pane: 3, text: "warn that this was not sent", createdAt: 1_000,
        metadata: { channelId: "target-channel" },
      });
      queue.update(job, {
        status: "pending", attempts: 64, firstAttemptAt: 1_000,
        echoCursor: { kind: "test", positions: {} }, nextAttemptAt: 0,
      });
      const agent = acceptingAgent();
      agent.waitForPromptEcho = async () => false;
      let notifyCalls = 0;
      const notify = async (_candidate, kind) => {
        expect(kind).toBe("not-sent");
        notifyCalls++;
        if (notifyCalls === 1) throw new Error("discord down");
      };
      const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify });
      return {
        rootDir, queue, job, agent, broker, notify,
        calls: () => notifyCalls,
        advance: () => { clock += 60_000; },
        now: () => clock,
      };
    }],
    when: ["one broker terminalizes and a replacement retries the notice", async (ctx) => {
      await ctx.broker.kickTarget("watch", 3);
      ctx.afterFailure = ctx.queue.read("watch", 3, ctx.job.id);
      ctx.targetsAfterFailure = ctx.queue.targets();
      ctx.advance();
      const reopened = createDeliveryQueue({ rootDir: ctx.rootDir, now: ctx.now });
      await createDeliveryBroker({
        agent: ctx.agent, queue: reopened, now: ctx.now, notify: ctx.notify,
      }).kick();
      ctx.afterSuccess = reopened.read("watch", 3, ctx.job.id);
      ctx.targetsAfterSuccess = reopened.targets();
    }],
    then: ["the terminal job never reopens while the notice becomes exactly-once durable", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.afterFailure).toMatchObject({
        status: "cancelled",
        unverifiedNoticeAttempts: 1,
        unverifiedNoticeSentAt: null,
      });
      expect(ctx.targetsAfterFailure).toEqual([{ agentName: "watch", pane: 3 }]);
      expect(ctx.afterSuccess).toMatchObject({
        status: "cancelled",
        unverifiedNoticeAttempts: 2,
        unverifiedNoticeSentAt: 4_060_000,
      });
      expect(ctx.calls()).toBe(2);
      expect(ctx.targetsAfterSuccess).toEqual([]);
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
        await options.onSubmitting?.();
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

  component("a cursor-backed slash remains fenced until its exact command receipt", {
    given: ["a submitted /model whose palette transition survived a broker restart", () => {
      const rootDir = tempRoot();
      let clock = 20_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "claw", pane: 2, text: "/model fable", kind: "slash" });
      queue.update(job, {
        status: "submitted",
        submittedAt: 1_000,
        echoCursor: { kind: "claude-slash-events-v1", positions: {} },
        nextAttemptAt: 0,
      });
      let receiptChecks = 0;
      const agent = acceptingAgent();
      agent.waitForSlashReceipt = async () => ++receiptChecks >= 2;
      const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify: async () => {} });
      return { rootDir, queue, job, agent, broker, advance: () => { clock += 1_001; } };
    }],
    when: ["one missing receipt then the exact receipt are observed", async ({ broker, advance, queue, job }) => {
      await broker.kickTarget("claw", 2);
      advance();
      const fenced = queue.read("claw", 2, job.id);
      await broker.kickTarget("claw", 2);
      return fenced;
    }],
    then: ["the first check does not release FIFO and the second does without a retype", (fenced, ctx) => {
      expect(fenced.status).toBe("submitted");
      expect(fenced.lastReason).toContain("awaiting exact command receipt");
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.queue.read("claw", 2, ctx.job.id).status).toBe("acknowledged");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("slash crash recovery verifies the command after model-alias rewriting", {
    given: ["a submitted /model opus job whose executed command used the pinned model id", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "claw", pane: 2, text: "/model opus", kind: "slash" });
      queue.update(job, {
        status: "submitted",
        submittedAt: Date.now(),
        echoCursor: { kind: "claude-slash-events-v1", positions: {} },
        nextAttemptAt: 0,
      });
      const receiptTexts = [];
      const agent = acceptingAgent();
      agent.waitForSlashReceipt = async (_name, _pane, text) => {
        receiptTexts.push(text);
        return text === "/model claude-opus-4-8";
      };
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, queue, job, agent, receiptTexts, broker };
    }],
    when: ["the replacement broker checks the authoritative receipt", ({ broker }) =>
      broker.kickTarget("claw", 2)],
    then: ["the rewritten command identity acknowledges without a duplicate write", (_, ctx) => {
      expect(ctx.receiptTexts).toEqual(["/model claude-opus-4-8"]);
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.queue.read("claw", 2, ctx.job.id).status).toBe("acknowledged");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a submitting slash command remains ambiguous after restart", {
    given: ["a slash whose pre-Enter fence persisted but post-Enter callback did not", () => {
      const rootDir = tempRoot();
      const clock = 3_602_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "claw", pane: 1, text: "/compact", kind: "slash" });
      queue.update(job, {
        status: "submitting", submitFenceAt: 1_000, lastAttemptAt: 1_000, nextAttemptAt: 0,
      });
      const notices = [];
      const agent = acceptingAgent();
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_candidate, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, agent, broker };
    }],
    when: ["the replacement broker reaches the ambiguity timeout", ({ broker }) =>
      broker.kickTarget("claw", 1)],
    then: ["it never executes the slash twice or upgrades missing proof to delivered", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notices).toEqual(["unverified"]);
      expect(ctx.queue.read("claw", 1, ctx.job.id)).toMatchObject({
        status: "delivered_unverified",
        metadata: { deliveryAmbiguity: "submitting-fence" },
        lastReason: "pre-Enter submit fence has no exact receipt after 60 minutes; physical delivery remains unverified",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  // A pane can accept keystrokes forever while ingesting none of them: ai:2 on
  // 2026-07-16 spun at 109% CPU inside `claude --continue` over an 887MB
  // session and wrote no JSONL for five hours. Every job then paid its own
  // 60-minute receipt budget, so the queue drained one message per hour while
  // fleet-watch enqueued six. Two of the messages burned that way were real
  // worker reports, not nudges.
  const wedgeableTarget = () => {
    const rootDir = tempRoot();
    let clock = 1_000;
    const queue = createDeliveryQueue({ rootDir, now: () => clock });
    const sends = [];
    const echoed = new Set();
    const ingestion = { enabled: false };
    const agent = {
      sends,
      capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
      waitForPromptEcho: async (_name, _pane, text) => ingestion.enabled && echoed.has(text),
      dismissBlockingPrompt: async () => null,
      sendOnly: async (_name, text, _pane, options = {}) => {
        sends.push(text);
        await options.onDrafted?.();
        await options.onSubmitting?.();
        await options.onSubmitted?.();
        echoed.add(text);
        return { submitted: true, queued: true };
      },
      sendEnter: async () => {},
      capturePane: async () => "› ",
    };
    // What a sender is told is the behaviour under test: a job can be
    // terminalized and then resurrected by the head snapshot, so status alone
    // cannot distinguish a spared probe from a cancelled-and-retyped one.
    const notices = [];
    const broker = createDeliveryBroker({
      agent, queue, now: () => clock,
      notify: async (job, kind) => { notices.push(`${job.text}:${kind}`); },
    });
    const enqueue = (text, index) =>
      queue.enqueue({ agentName: "ai", pane: 2, text, orderKey: `00${index}` });
    const burnBudget = async () => {
      await broker.kickTarget("ai", 2);
      clock += 61 * 60_000;
      await broker.kickTarget("ai", 2);
    };
    const statusByText = () =>
      Object.fromEntries(queue.list("ai", 2).map((job) => [job.text, job.status]));
    // A submitted head parks on ACTIVE_RETRY_MS, so a frozen clock would skip
    // it before its receipt is ever read.
    const tick = () => { clock += 2_000; };
    return {
      rootDir, queue, broker, sends, notices, ingestion,
      enqueue, burnBudget, statusByText, tick,
    };
  };

  component("a backlog behind a target proven not to ingest is answered now, not one hour at a time", {
    given: ["four queued prompts and a pane that accepts keystrokes but ingests none", () => {
      const context = wedgeableTarget();
      ["first", "second", "third", "fourth"].forEach(context.enqueue);
      return context;
    }],
    when: ["two consecutive receipt budgets expire without any acknowledgement", async ({
      broker, burnBudget, statusByText,
    }) => {
      await burnBudget();
      await burnBudget();
      await broker.kickTarget("ai", 2);
      return { byText: statusByText() };
    }],
    then: ["the head still probes while everything behind it is answered without being typed", ({ byText }, ctx) => {
      expect(byText).toEqual({
        first: "delivered_unverified",
        second: "delivered_unverified",
        third: "submitted",
        fourth: "cancelled",
      });
      expect(ctx.sends).toEqual(["first", "second", "third"]);
      expect(ctx.queue.list("ai", 2).find((job) => job.text === "fourth")).toMatchObject({
        metadata: { deliveryOutcome: "not-sent", deliveryTarget: "not-ingesting" },
      });
      // The probe's sender is never told NOT SENT about a prompt the broker is
      // in fact typing; only the backlog behind it is answered.
      expect(ctx.notices).toContain("fourth:not-sent");
      expect(ctx.notices).not.toContain("third:not-sent");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  // Only an acknowledgement ends the streak, so a breaker that silenced the
  // head too could never see one again and would mute a healed pane forever.
  // That failure would be worse than the hourly drain it replaces.
  component("a healed pane reopens its own queue through the probe the breaker spared", {
    given: ["a target already proven not to ingest across two receipt budgets", async () => {
      const context = wedgeableTarget();
      ["first", "second", "third"].forEach(context.enqueue);
      await context.burnBudget();
      await context.burnBudget();
      await context.broker.kickTarget("ai", 2);
      return context;
    }],
    when: ["the pane starts ingesting again and two further prompts arrive", async ({
      broker, ingestion, enqueue, statusByText, tick,
    }) => {
      ingestion.enabled = true;
      tick();
      await broker.kickTarget("ai", 2);
      // Two, deliberately: the head is always spared as the probe, so only a
      // follower can prove the streak itself cleared rather than being dodged.
      enqueue("after-recovery", 9);
      enqueue("behind-recovery", 10);
      for (let kick = 0; kick < 3; kick++) {
        tick();
        await broker.kickTarget("ai", 2);
      }
      return { byText: statusByText() };
    }],
    then: ["the probe's receipt clears the streak and the backlog behind it delivers again", ({ byText }, ctx) => {
      expect(byText.third).toBe("acknowledged");
      expect(byText["after-recovery"]).toBe("acknowledged");
      expect(byText["behind-recovery"]).toBe("acknowledged");
      expect(ctx.notices).not.toContain("behind-recovery:not-sent");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });
});

feature("exact-session Claude quota recovery", () => {
  const receipt = {
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    limitEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    limitKind: "session",
    observedAt: 1_000,
    resetAt: 20_000,
  };

  const recoveryContext = ({ submitted = false } = {}) => {
    const rootDir = tempRoot();
    let clock = 30_000;
    const queue = createDeliveryQueue({ rootDir, now: () => clock });
    const job = queue.enqueue({ agentName: "lsrc", pane: 2, text: "queued while limited" });
    if (submitted) {
      queue.update(job, {
        status: "submitted",
        submittedAt: clock,
        echoCursor: { kind: "test", positions: {} },
        nextAttemptAt: 0,
      });
    }
    const echoed = new Set();
    const sends = [];
    const restarts = [];
    let activeReceipt = receipt;
    const agent = {
      capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
      waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
      claudeLimitReceipt: async () => activeReceipt,
      restartClaude: async (...args) => { restarts.push(args); return { ok: true }; },
      dismissBlockingPrompt: async () => null,
      sendOnly: async (_name, text, _pane, options = {}) => {
        sends.push(text);
        await options.onPasteStarted?.();
        await options.onDrafted?.();
        await options.onSubmitting?.();
        await options.onSubmitted?.();
        echoed.add(text);
        if (text.startsWith("[AMUX AUTOMATIC QUOTA RECOVERY")) activeReceipt = null;
        return { submitted: true, queued: false };
      },
      sendEnter: async () => {},
      capturePane: async () => "❯ ",
    };
    const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify: async () => {} });
    return { rootDir, queue, job, agent, broker, sends, restarts, tick: () => { clock += 1_000; } };
  };

  component("a limited pane parks new delivery before any physical write", {
    given: ["a pending prompt and an exact active quota receipt", recoveryContext],
    when: ["the broker reaches the pane", ({ broker }) => broker.kickTarget("lsrc", 2)],
    then: ["the prompt is durably quota-paused and no key reaches Claude", (_, ctx) => {
      expect(ctx.sends).toEqual([]);
      expect(ctx.queue.read("lsrc", 2, ctx.job.id)).toMatchObject({
        status: "quota_paused",
        metadata: {
          quotaPreviousStatus: "pending",
          quotaLimitEventId: receipt.limitEventId,
          quotaSessionId: receipt.sessionId,
        },
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("quota top-up restarts the exact session and continues before parked FIFO", {
    given: ["an ambiguous submitted job created while Claude was limited", () => recoveryContext({ submitted: true })],
    when: ["the broker parks, recovers twice, then drains", async (ctx) => {
      await ctx.broker.kickTarget("lsrc", 2);
      const first = await ctx.broker.recoverClaudeQuota({ agentName: "lsrc", pane: 2, receipt });
      const retry = await ctx.broker.recoverClaudeQuota({ agentName: "lsrc", pane: 2, receipt });
      ctx.tick();
      await ctx.broker.kickTarget("lsrc", 2);
      return { first, retry };
    }],
    then: ["one exact restart makes the old fence retry-safe and sends one continuation first", ({ first, retry }, ctx) => {
      expect(first).toMatchObject({ recovered: true, restarted: true, replayed: false });
      expect(retry).toMatchObject({ recovered: true, restarted: false, replayed: true });
      expect(ctx.restarts).toEqual([["lsrc", 2, {
        resumeSessionId: receipt.sessionId,
        expectedLimitEventId: receipt.limitEventId,
      }]]);
      expect(ctx.sends).toHaveLength(2);
      expect(ctx.sends[0]).toContain("AMUX AUTOMATIC QUOTA RECOVERY");
      expect(ctx.sends[1]).toBe("queued while limited");
      expect(ctx.queue.read("lsrc", 2, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        attempts: 1,
        submitFenceAt: expect.any(Number),
        submittedAt: expect.any(Number),
        metadata: { quotaRecoveredAt: expect.any(Number) },
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a superseded receipt never restarts or creates a continuation", {
    given: ["a pane whose active receipt belongs to another limit event", recoveryContext],
    when: ["recovery is requested with stale evidence", ({ broker, agent }) => {
      agent.claudeLimitReceipt = async () => ({ ...receipt, limitEventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
      return broker.recoverClaudeQuota({ agentName: "lsrc", pane: 2, receipt });
    }],
    then: ["the process and queue remain untouched", (result, ctx) => {
      expect(result).toEqual({ recovered: false, reason: "quota receipt was superseded before restart" });
      expect(ctx.restarts).toEqual([]);
      expect(ctx.queue.list("lsrc", 2)).toHaveLength(1);
      expect(ctx.queue.read("lsrc", 2, ctx.job.id).status).toBe("pending");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });
});
