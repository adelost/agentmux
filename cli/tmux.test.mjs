import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sendToPane } from "./tmux.mjs";
import { refuseHumanQuote } from "../core/human-quote-guard.mjs";
import { parkPane } from "../core/pane-park.mjs";

const tmpPath = () => join(tmpdir(), `amux-send-test-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);

function fakeAgent() {
  const sent = [];
  return {
    sent,
    dismissBlockingPrompt: async () => null,
    sendOnly: async (_name, text) => { sent.push(text); },
    waitForPromptEcho: async () => true,
    isBusy: async () => false,
  };
}

function fakeDeliveryQueue(status = "acknowledged") {
  let job = null;
  return {
    enqueue: vi.fn((request) => {
      job = { id: "job-1", status: "pending", ...request };
      return job;
    }),
    findById: vi.fn(() => job ? { ...job, status } : null),
  };
}

feature("sendToPane delivery outcome", () => {
  unit("an unknown target is rejected before durable persistence", {
    given: ["a canonical config without the misspelled target", () => {
      const configPath = tmpPath();
      writeFileSync(configPath, "skydive:\n  dir: /tmp/skydive\n  panes:\n    - cmd: codex\n");
      return { configPath, deliveryQueue: fakeDeliveryQueue() };
    }],
    when: ["a command-shaped typo is offered as an agent", async ({ configPath, deliveryQueue }) => {
      let error = null;
      const mirrors = [];
      try {
        await sendToPane({ configPath, deliveryQueue, deliveryWaitMs: 0 },
          "queue", 7, "skydive", { mirrorDispatch: (payload) => mirrors.push(payload) });
      } catch (caught) { error = caught; }
      try { unlinkSync(configPath); } catch {}
      return { error, calls: deliveryQueue.enqueue.mock.calls.length, mirrors };
    }],
    then: ["no queue job, Discord mirror, or receipt can be created", ({ error, calls, mirrors }) => {
      expect(error?.message).toContain("Agent 'queue' not found");
      expect(calls).toBe(0);
      expect(mirrors).toEqual([]);
    }],
  });

  unit("a caller-supplied idempotency identity reaches the durable queue", {
    given: ["an unparked pane and deterministic relay identity", () => {
      const path = tmpPath();
      writeFileSync(path, "");
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = path;
      return { path, oldPath, deliveryQueue: fakeDeliveryQueue() };
    }],
    when: ["sending the same Suggestions stage", async ({ path, oldPath, deliveryQueue }) => {
      await sendToPane({ configPath: null, deliveryQueue, deliveryWaitMs: 0 },
        "skydive", 3, "bounded handoff", {
          mirror: false,
          idempotencyKey: "suggestions-comment:skydive:SKY-1:7:initial",
        });
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
      return deliveryQueue.enqueue.mock.calls[0][0];
    }],
    then: ["the queue owns the exact retry identity", (request) => {
      expect(request.idempotencyKey).toBe("suggestions-comment:skydive:SKY-1:7:initial");
    }],
  });

  unit("verified delivery is returned to the caller", {
    given: ["an unparked pane", () => {
      const path = tmpPath();
      writeFileSync(path, "");
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = path;
      return { path, oldPath, agent: fakeAgent(), deliveryQueue: fakeDeliveryQueue() };
    }],
    when: ["sending", async ({ path, oldPath, agent, deliveryQueue }) => {
      const result = await sendToPane({ agent, configPath: null, deliveryQueue, deliveryWaitMs: 0 }, "claw", 1, "review this");
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
      return { result, sent: agent.sent };
    }],
    then: ["the result is explicit and tmux is left to the broker", ({ result, sent }) => {
      expect(result).toMatchObject({ delivered: true, blocked: false, via: "broker" });
      expect(sent).toEqual([]);
    }],
  });

  unit("park guard returns blocked without touching the pane", {
    given: ["a parked pane", () => {
      const path = tmpPath();
      parkPane({ session: "claw", pane: 1, detail: "sol to luna", path });
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = path;
      return { path, oldPath, agent: fakeAgent() };
    }],
    when: ["sending work", async ({ path, oldPath, agent }) => {
      const result = await sendToPane({ agent, configPath: null }, "claw", 1, "review this");
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
      return { result, sent: agent.sent };
    }],
    then: ["the caller can fail loudly and no prompt was injected", ({ result, sent }) => {
      expect(result).toMatchObject({ delivered: false, blocked: true });
      expect(sent).toEqual([]);
    }],
  });

  unit("returns a durable pending receipt while the broker has not acknowledged", {
    given: ["an unparked pane whose queued job is still pending", () => {
      const path = tmpPath();
      writeFileSync(path, "");
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = path;
      const agent = fakeAgent();
      return { path, oldPath, agent, deliveryQueue: fakeDeliveryQueue("drafted") };
    }],
    when: ["sending through the CLI delivery contract", async ({ path, oldPath, agent, deliveryQueue }) => {
      const result = await sendToPane(
        { agent, configPath: null, deliveryQueue, deliveryWaitMs: 0 },
        "claw",
        3,
        "[from claw:0]\n\nclaim respected",
        { mirror: false },
      );
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
      return result;
    }],
    then: ["the caller knows it is safely queued, not falsely failed", (result) => {
      expect(result).toMatchObject({ delivered: true, blocked: false, pending: true, queueState: "drafted" });
    }],
  });

  unit("returns a terminal unverified receipt without reopening delivery", {
    given: ["an unparked pane whose durable submission aged out of receipt reconciliation", () => {
      const path = tmpPath();
      writeFileSync(path, "");
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = path;
      return { path, oldPath, agent: fakeAgent(),
        deliveryQueue: fakeDeliveryQueue("delivered_unverified") };
    }],
    when: ["the CLI observes the terminal audit state", async ({
      path, oldPath, agent, deliveryQueue,
    }) => {
      const result = await sendToPane(
        { agent, configPath: null, deliveryQueue, deliveryWaitMs: 0 },
        "claw", 3, "already left composer", { mirror: false },
      );
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
      return result;
    }],
    then: ["it is complete but explicitly not history-verified", (result) => {
      expect(result).toMatchObject({
        delivered: true,
        blocked: false,
        pending: false,
        unverified: true,
        queueState: "delivered_unverified",
      });
    }],
  });

  unit("cross-agent delivery mirrors the full brief to target and a receipt to sender", {
    given: ["a verified lsrc:4 to lsrc:0 brief with both panes bound", () => {
      const parkPath = tmpPath();
      const configPath = tmpPath();
      writeFileSync(parkPath, "");
      writeFileSync(configPath, [
        "lsrc:",
        "  dir: /tmp/lsrc",
        "  panes:",
        "    - cmd: codex",
        "  discord:",
        "    sender-channel: 4",
        "    target-channel: 0",
        "",
      ].join("\n"));
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = parkPath;
      return { parkPath, configPath, oldPath, agent: fakeAgent(), deliveryQueue: fakeDeliveryQueue(), mirrors: [] };
    }],
    when: ["sending through the central delivery path", async (ctx) => {
      const result = await sendToPane(
        { agent: ctx.agent, configPath: ctx.configPath, deliveryQueue: ctx.deliveryQueue, deliveryWaitMs: 0 },
        "lsrc",
        0,
        "[from lsrc:4]\n\nreview every image\nKeep the entire second line visible.",
        { mirrorDispatch: (payload) => ctx.mirrors.push(payload) },
      );
      if (ctx.oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = ctx.oldPath;
      try { unlinkSync(ctx.parkPath); } catch {}
      try { unlinkSync(ctx.configPath); } catch {}
      return { result, mirrors: ctx.mirrors };
    }],
    then: ["target gets the brief and sender gets immediate delivery proof", ({ result, mirrors }) => {
      expect(result.delivered).toBe(true);
      expect(result.queueState).toBe("acknowledged");
      expect(mirrors).toEqual([
        { channelId: "target-channel", content: "[from lsrc:4]\n\nreview every image\nKeep the entire second line visible.", idempotencyKey: "mirror:job-1" },
        { channelId: "sender-channel", content: "`amux lsrc -p 0 …` → delivered." },
      ]);
    }],
  });

  unit("CLI delivery persists the bound target channel for unverified warnings", {
    given: ["an aged inter-agent job whose delivery is terminal but unverified", () => {
      const parkPath = tmpPath();
      const configPath = tmpPath();
      writeFileSync(parkPath, "");
      writeFileSync(configPath, [
        "lsrc:",
        "  dir: /tmp/lsrc",
        "  panes:",
        "    - cmd: codex",
        "  discord:",
        "    sender-channel: 4",
        "    target-channel: 0",
        "",
      ].join("\n"));
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = parkPath;
      return {
        parkPath, configPath, oldPath, agent: fakeAgent(),
        deliveryQueue: fakeDeliveryQueue("delivered_unverified"), mirrors: [],
      };
    }],
    when: ["the CLI reopens the durable identity", async (ctx) => {
      const result = await sendToPane(
        { agent: ctx.agent, configPath: ctx.configPath, deliveryQueue: ctx.deliveryQueue, deliveryWaitMs: 0 },
        "lsrc",
        0,
        "[from lsrc:4]\n\ncritical review",
        { mirrorDispatch: (payload) => ctx.mirrors.push(payload) },
      );
      const request = ctx.deliveryQueue.enqueue.mock.calls[0][0];
      if (ctx.oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = ctx.oldPath;
      try { unlinkSync(ctx.parkPath); } catch {}
      try { unlinkSync(ctx.configPath); } catch {}
      return { result, request, mirrors: ctx.mirrors };
    }],
    then: ["the broker can warn the target and the sender is not told delivery was verified", ({ result, request, mirrors }) => {
      expect(request.metadata).toEqual({ sender: "lsrc:4", channelId: "target-channel" });
      expect(result).toMatchObject({
        delivered: true,
        pending: false,
        unverified: true,
        queueState: "delivered_unverified",
      });
      expect(mirrors).toEqual([
        { channelId: "target-channel", content: "[from lsrc:4]\n\ncritical review", idempotencyKey: "mirror:job-1" },
        { channelId: "sender-channel", content: "`amux lsrc -p 0 …` → delivery unverified." },
      ]);
    }],
  });
});

// 2026-10-18 22:38Z: skyvw:3 handed the Cutkit lead to skyvw:0, which sat at its weekly
// limit; the send said only "queued", so the sender let go of the role for 5.8 h.
feature("sending to a pane stopped at its limit", () => {
  const nightReceipt = { sessionId: "s", limitEventId: "l", limitKind: "weekly",
    text: "You've hit your weekly limit · resets Oct 21, 9am (Europe/Stockholm)" };
  const send = async (receipt) => {
    const path = tmpPath();
    writeFileSync(path, "");
    const oldPath = process.env.AMUX_PARK_STATE_PATH;
    process.env.AMUX_PARK_STATE_PATH = path;
    try {
      return await sendToPane({ configPath: null, deliveryQueue: fakeDeliveryQueue("pending"), deliveryWaitMs: 0,
        recipientLimit: () => receipt }, "skyvw", 0, "[from skyvw:3] the lead is yours again", { mirror: false });
    } finally {
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
    }
  };

  unit("the sender is told the recipient cannot read it and keeps the role", {
    when: ["handing over a role to skyvw:0 at its weekly limit", () => send(nightReceipt)],
    then: ["the result names the stop, its reset and who keeps the role", (result) => {
      expect(result).toMatchObject({ delivered: true, pending: true });
      expect(result.notice).toBe("WARNING: skyvw:0 is stopped at its Claude weekly limit (You've hit your weekly limit"
        + " · resets Oct 21, 9am (Europe/Stockholm)). The message waits in its queue until the pane recovers."
        + " Keep any role you hand over until skyvw:0 acknowledges.");
    }],
  });

  unit("a recipient without a limit gets no warning", {
    when: ["sending to a pane that can read", () => send(null)],
    then: ["the result is the ordinary queued receipt", (result) => {
      expect(result).toMatchObject({ delivered: true, pending: true });
      expect(result.notice).toBeUndefined();
    }],
  });
});

// 2026-10-19: one lead pasted his voice messages into 17 briefs although he had
// asked many times that briefs never quote him.
feature("an agent's send that quotes him", () => {
  const his = [{ ts: Date.parse("2026-10-19T04:00:00Z"), to: "lsrc:0",
    text: "Jag tycker att ni ska bestämma åt mig, så får jag rätta till det efteråt om något blir fel." }];
  const sendWith = async (text) => {
    const deliveryQueue = fakeDeliveryQueue("pending");
    const result = await sendToPane({ configPath: null, deliveryQueue, deliveryWaitMs: 0,
      humanQuote: (outgoing) => refuseHumanQuote(outgoing, { enabled: true, messages: () => his }) },
    "claw", 0, text, { mirror: false });
    return { result, enqueued: deliveryQueue.enqueue.mock.calls.length };
  };

  unit("is refused before it reaches the queue", {
    when: ["lsrc:0 pastes his delegation into a brief", () => sendWith(
      "[from lsrc:0]\n\nAuthority, verbatim: \"Jag tycker att ni ska bestämma åt mig, så får jag rätta till det efteråt.\"")],
    then: ["nothing is queued and the send reports the block", ({ result, enqueued }) => {
      expect(result).toEqual({ delivered: false, blocked: true, reason: "human-quote" });
      expect(enqueued).toBe(0);
    }],
  });

  unit("is not checked when no agent sent it", {
    when: ["the same words arrive without an agent sender", () => sendWith(
      "Jag tycker att ni ska bestämma åt mig, så får jag rätta till det efteråt.")],
    then: ["it is queued as before", ({ result, enqueued }) => {
      expect(result).toMatchObject({ delivered: true, pending: true });
      expect(enqueued).toBe(1);
    }],
  });
});
