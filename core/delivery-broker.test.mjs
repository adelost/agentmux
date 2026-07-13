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

  component("transport zoom is always restored", {
    given: ["a pane that needs temporary zoom", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      queue.enqueue({ agentName: "api", pane: 3, text: "show composer" });
      const agent = acceptingAgent();
      agent.zoomPaneForPicker = async () => true;
      agent.restorePaneZoom = async (_name, _pane, changed) => { agent.restored = changed; };
      const broker = createDeliveryBroker({ agent, queue, notify: async () => {} });
      return { rootDir, broker, agent };
    }],
    when: ["delivery finishes", ({ broker }) => broker.kickTarget("api", 3)],
    then: ["the tiled layout is restored", (_, ctx) => {
      expect(ctx.agent.restored).toBe(true);
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
