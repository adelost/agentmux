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
            await options.onDrafted?.();
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
    then: ["the job remains blocked without changing zoom", (_, ctx) => {
      expect(ctx.agent.zoomCalls).toBe(0);
      expect(ctx.queue.read("api", 3, ctx.job.id).status).toBe("blocked");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a disappearing composer keeps the owned draft at the FIFO head", {
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
          await options.onDrafted?.();
          const error = new Error("exact prompt did not finish painting");
          error.code = "AMUX_DELIVERY_BLOCKED";
          throw error;
        },
      };
      const broker = createDeliveryBroker({ agent: failingAgent, queue, notify: async () => {} });
      return { rootDir, queue, first, sends, broker };
    }],
    when: ["the first delivery loses its TUI paint", ({ broker }) => broker.kickTarget("lsrc", 3)],
    then: ["the draft persists and the later directive is untouched", (_, ctx) => {
      expect(ctx.queue.read("lsrc", 3, ctx.first.id)).toMatchObject({
        status: "drafted",
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
        lastReason: "submission has no JSONL receipt yet; refusing duplicate paste",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("an idle Claude submission is retried after its JSONL grace period", {
    given: ["a stale Claude job whose submitted prompt genuinely vanished", () => {
      const rootDir = tempRoot();
      let clock = 40_000;
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
      let echoed = false;
      agent.waitForPromptEcho = async () => echoed;
      agent.promptTransportState = async () => ({ state: "empty-idle", busy: false, dialect: "claude" });
      const originalSend = agent.sendOnly;
      agent.sendOnly = async (...args) => {
        const result = await originalSend(...args);
        echoed = true;
        return result;
      };
      const broker = createDeliveryBroker({ agent, queue, now: () => clock, notify: async () => {} });
      return { rootDir, queue, job, agent, broker, advance: () => { clock += 1; } };
    }],
    when: ["the broker proves loss and then drains the recovered head", async ({ broker, advance }) => {
      await broker.kickTarget("watch", 0);
      advance();
      await broker.kickTarget("watch", 0);
    }],
    then: ["the exact prompt is re-sent once and acknowledged", (_, ctx) => {
      expect(ctx.agent.sends.map((send) => send.text)).toEqual(["review everything"]);
      expect(ctx.queue.read("watch", 0, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        recoveryAttempts: 1,
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

  component("Claude stale recovery stops after two bounded retries", {
    given: ["a Claude job that exhausted both recovery attempts", () => {
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
    then: ["it remains fenced and emits one blocked notice", (_, ctx) => {
      expect(ctx.agent.sends).toHaveLength(0);
      expect(ctx.notices).toEqual(["blocked"]);
      expect(ctx.queue.read("api", 0, ctx.job.id)).toMatchObject({
        status: "submitted",
        recoveryAttempts: 2,
        lastReason: "Claude delivery recovery exhausted after 2 retries; prompt still absent from JSONL",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a drafted repaint may recover but never paste the payload twice", {
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
            await options.onDrafted?.();
          }
          const error = new Error("durable draft is not visible; refusing to paste it again");
          error.code = "AMUX_DELIVERY_BLOCKED";
          throw error;
        },
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
      expect(ctx.calls).toEqual([{ knownDrafted: false }, { knownDrafted: true }]);
      expect(ctx.queue.read("skydive", 5, ctx.job.id)).toMatchObject({
        status: "drafted",
        draftOwned: true,
        attempts: 2,
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
